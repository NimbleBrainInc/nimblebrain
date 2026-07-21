import type { LanguageModelV3, SharedV3ProviderOptions } from "@ai-sdk/provider";
import { getModelByString, getProviderFromModel } from "../model/catalog.ts";
import { log } from "../observability/log.ts";
import { type TokenUsage, tokenUsageFromV3 } from "../usage/types.ts";
import type { BriefingContext } from "./briefing-collector.ts";
import { debugBriefing } from "./briefing-debug.ts";
import type {
  ActivityOutput,
  BriefingOutput,
  BriefingSection,
  BriefingState,
  HomeConfig,
} from "./home-types.ts";

/**
 * Wall-clock cap for the LLM call. Covers realistic p99 across providers
 * without burning user attention on a stuck request.
 */
const BRIEFING_TIMEOUT_MS = 45_000;

/**
 * Output token cap. The prompt asks for "under 800 tokens" — 1500 gives
 * headroom for a verbose generation without allowing runaway output.
 */
const BRIEFING_MAX_OUTPUT_TOKENS = 1500;

/**
 * Input bounds. A tenant with thousands of CRM rows shouldn't be able to
 * blow up the LLM input — cap facet count and per-facet data payload.
 */
const BRIEFING_MAX_FACETS = 12;
const BRIEFING_MAX_FACET_DATA_CHARS = 800;

const BRIEFING_SYSTEM_PROMPT = `You are a daily briefing generator for a business workspace.

You receive two data sources:
1. **App facets** — structured data from installed business apps (CRM, tasks, signals, etc.). Each facet has a label, type, and resolved data.
2. **System activity** — platform telemetry (conversations, tool calls, errors). This is secondary — only mention if there are significant errors or outages.

Produce a JSON object with two fields:

1. "lede" — A single sentence (max 120 chars) summarizing the most important business insight. Lead with what matters to the user, not platform stats.
2. "sections" — An array of 1–6 briefing sections, each with:
   - "id": short kebab-case identifier (e.g., "pipeline", "blocked-tasks", "overdue-followups")
   - "text": 1–2 sentences in business language. Use names, numbers, and specifics from the facet data.
   - "type": "positive" | "neutral" | "warning"
   - "category": "recent" | "upcoming" | "attention"
   - "action" (optional): semantic action object. The shape includes both "route" and "prompt"; set the unused one to null based on the action type:
     - navigate: { "type": "navigate", "route": "<route from facet>", "prompt": null, "label": "Open CRM" }
     - startChat: { "type": "startChat", "route": null, "prompt": "<natural language prompt>", "label": "Ask about this" }
   Each facet includes a "route" field — use that exact value in navigate actions.

Rules:
- Facets with type "attention" → category "attention", type "warning". Surface these first.
- Facets with type "upcoming" → category "upcoming".
- Facets with type "activity" or "delta" → category "recent".
- Write like a human assistant, not a monitoring dashboard. "2 follow-ups overdue" not "2 interaction entities with follow_up_date < now".
- Use concrete numbers and names from the facet data.
- If facet data is empty or zero, skip it — don't report "0 new contacts".
- System activity (errors, tool calls) only gets a section if error rate > 5% or a bundle crashed. Otherwise omit it entirely.
- Keep total output under 800 tokens.
- Return ONLY valid JSON. No markdown, no explanation.
- Actions are semantic — never include route paths or URLs.`;

/**
 * JSON Schema for the briefing response — enables provider-level structured output.
 *
 * Anthropic structured output rules:
 * - `additionalProperties: false` on every object
 * - All object properties must appear in `required`
 * - Optional fields use `anyOf: [{ type: "..." }, { type: "null" }]`
 * - No minLength/maxLength/minimum/maximum — use description instead
 */
const BRIEFING_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    lede: { type: "string" as const, description: "Single-sentence summary, max 120 chars" },
    sections: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          text: { type: "string" as const },
          type: { type: "string" as const, enum: ["positive", "neutral", "warning"] },
          category: { type: "string" as const, enum: ["recent", "upcoming", "attention"] },
          action: {
            anyOf: [
              {
                type: "object" as const,
                properties: {
                  type: { type: "string" as const, enum: ["navigate", "startChat"] },
                  // Discriminated payloads: navigate uses route, startChat uses prompt.
                  // Both fields are listed in `required` (Anthropic structured-output
                  // rule) but the unused one must be `null`, not a fabricated string.
                  // The TS type (BriefingAction) matches this nullable wire shape.
                  route: {
                    anyOf: [{ type: "string" as const }, { type: "null" as const }],
                    description: "Route for navigate actions; null on startChat",
                  },
                  prompt: {
                    anyOf: [{ type: "string" as const }, { type: "null" as const }],
                    description: "Prompt for startChat actions; null on navigate",
                  },
                  label: { type: "string" as const },
                },
                required: ["type", "route", "prompt", "label"],
                additionalProperties: false,
              },
              { type: "null" as const },
            ],
          },
        },
        required: ["id", "text", "type", "category", "action"],
        additionalProperties: false,
      },
    },
  },
  required: ["lede", "sections"],
  additionalProperties: false,
};

/**
 * Provider-aware options for the short structured briefing call. Suppresses
 * reasoning/thinking on every provider that exposes a knob (gated on the
 * catalog's `capabilities.reasoning` so older models that don't expose
 * the option get an empty options object). Inlined here rather than
 * abstracted into a slot-profile because briefing is the only caller
 * today; if a second caller appears, lift this into a shared helper.
 */
function shortCallProviderOptions(modelString: string | null): SharedV3ProviderOptions {
  if (!modelString) return {};
  const provider = getProviderFromModel(modelString);
  const model = getModelByString(modelString);
  if (!model?.capabilities.reasoning) return {};
  switch (provider) {
    case "anthropic":
      return { anthropic: { thinking: { type: "disabled" } } };
    case "google":
      return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    case "openai":
      return { openai: { reasoningEffort: "minimal" } };
    case "nebius":
      // Deliberately no suppression, and NOT a silent fallthrough. Nebius rejects
      // `reasoning_effort` (HTTP 400) on its DeepSeek/Qwen/gpt-oss reasoning
      // models, and there's no shared alternative knob. It isn't needed anyway:
      // under the briefing's json_schema structured-output path these models
      // return clean JSON within the 1500-token budget (finish=stop, no reasoning
      // dump) — verified against a live account. Do not add a `reasoning_effort`
      // case here; it breaks the briefing rather than fixing it.
      return {};
    default:
      return {};
  }
}

/** Parsed briefing payload as returned by JSON.parse, before caller-side shape validation. */
type BriefingResult = { lede: string; sections: BriefingSection[] };

/** Mutable state threaded through the truncation-repair character scan. */
type ScanState = { opens: string[]; inString: boolean; escaped: boolean };

export class BriefingGenerator {
  constructor(
    private model: LanguageModelV3,
    private modelString: string | null,
    private config: HomeConfig,
    /**
     * Observe the `fast`-slot generation's usage — the call runs outside the
     * agentic loop and emits no llm.response, so without this its cost is
     * invisible to the usage aggregator.
     */
    private onUsage?: (usage: TokenUsage, llmMs: number) => void,
  ) {}

  async generate(
    activity: ActivityOutput,
    facetContext?: BriefingContext,
  ): Promise<BriefingOutput> {
    const greeting = this.buildGreeting();
    const date = this.formatDate();
    const now = new Date().toISOString();

    const hasFacets = facetContext && facetContext.facets.length > 0;
    if (!hasFacets && this.isEmpty(activity)) {
      return {
        greeting,
        date,
        lede: "It's been a quiet day. No activity in the last 24 hours.",
        sections: [],
        state: "quiet",
        generated_at: now,
        cached: false,
      };
    }

    // Throws on failure — caller (tools/core-source.ts) catches and
    // renders a minimal "couldn't load" briefing without caching.
    return this.generateWithLlm(activity, greeting, date, now, facetContext);
  }

  private buildGreeting(): string {
    const hour = this.getHourInTimezone();
    const name = this.config.userName;
    if (hour < 12) return `Good morning, ${name}`;
    if (hour < 17) return `Good afternoon, ${name}`;
    return `Good evening, ${name}`;
  }

  private getHourInTimezone(): number {
    const tz = this.config.timezone;
    if (!tz) return new Date().getHours();
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        hour12: false,
      }).format(new Date());
      return Number.parseInt(formatted, 10);
    } catch {
      return new Date().getHours();
    }
  }

  private formatDate(): string {
    const tz = this.config.timezone || undefined;
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date());
    } catch {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date());
    }
  }

  private isEmpty(activity: ActivityOutput): boolean {
    return (
      activity.conversations.length === 0 &&
      activity.bundle_events.length === 0 &&
      activity.tool_usage.length === 0 &&
      activity.errors.length === 0
    );
  }

  private async generateWithLlm(
    activity: ActivityOutput,
    greeting: string,
    date: string,
    now: string,
    facetContext?: BriefingContext,
  ): Promise<BriefingOutput> {
    const userPayload = this.buildUserPayload(activity, facetContext);
    const userText = JSON.stringify(userPayload);

    // Per-facet diagnostic log gated on NB_DEBUG_BRIEFING — emits one
    // line per facet showing what the collector resolved. The bug
    // surface for this tool is "LLM said no data, but I have data";
    // this log answers "what did the collector actually send?" in one
    // pageload. Quiet by default.
    const facets = (userPayload.app_facets as Array<Record<string, unknown>> | undefined) ?? [];
    if (facets.length === 0) {
      debugBriefing(() => "no facets resolved");
    } else {
      for (const f of facets) {
        debugBriefing(() => {
          const data =
            typeof f.data === "string"
              ? f.data.slice(0, 160)
              : JSON.stringify(f.data).slice(0, 160);
          return `facet app=${f.app} label="${f.label}" ok=${f.ok} data="${data.replace(/\n/g, " ")}"`;
        });
      }
    }

    const providerOptions = shortCallProviderOptions(this.modelString);
    const abort = AbortSignal.timeout(BRIEFING_TIMEOUT_MS);
    const startedAt = Date.now();
    const response = await this.model.doGenerate({
      prompt: [
        { role: "system", content: BRIEFING_SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "text", text: userText }],
        },
      ],
      responseFormat: {
        type: "json",
        schema: BRIEFING_RESPONSE_SCHEMA,
        name: "briefing",
        description: "Daily workspace briefing with sections",
      },
      maxOutputTokens: BRIEFING_MAX_OUTPUT_TOKENS,
      abortSignal: abort,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    });

    this.onUsage?.(tokenUsageFromV3(response.usage), Date.now() - startedAt);

    const finishReason = response.finishReason?.unified ?? "unknown";
    if (finishReason === "length") {
      log.warn("[briefing] LLM response truncated (hit token limit)");
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("LLM returned no text content for briefing");
    }

    const parsed = this.parseJson(textBlock.text, finishReason === "length");
    if (!parsed || typeof parsed.lede !== "string" || !Array.isArray(parsed.sections)) {
      throw new Error(
        `Failed to parse briefing JSON (finishReason=${finishReason}): ${textBlock.text.slice(0, 200)}`,
      );
    }

    return {
      greeting,
      date,
      lede: parsed.lede,
      sections: parsed.sections,
      state: this.deriveState(parsed.sections),
      generated_at: now,
      cached: false,
    };
  }

  private buildUserPayload(
    activity: ActivityOutput,
    facetContext?: BriefingContext,
  ): Record<string, unknown> {
    const userPayload: Record<string, unknown> = {};
    if (facetContext && facetContext.facets.length > 0) {
      // Cap facet count and per-facet data size — tenants with very large
      // entity stores (5k+ CRM contacts, etc.) can produce facet data
      // strings that dominate input tokens and push first-token latency
      // past the wall-clock cap.
      const truncated = facetContext.facets.slice(0, BRIEFING_MAX_FACETS).map((f) => ({
        app: f.appName,
        route: f.appRoute,
        label: f.facet.label,
        type: f.facet.type,
        data:
          f.data.length > BRIEFING_MAX_FACET_DATA_CHARS
            ? `${f.data.slice(0, BRIEFING_MAX_FACET_DATA_CHARS)}… (truncated)`
            : f.data,
        ok: f.ok,
      }));
      userPayload.app_facets = truncated;
      userPayload.period = facetContext.period;
    }
    userPayload.system_activity = {
      conversations: activity.totals.conversations,
      tool_calls: activity.totals.tool_calls,
      errors: activity.totals.errors,
      error_rate:
        activity.totals.tool_calls > 0
          ? `${((activity.totals.errors / activity.totals.tool_calls) * 100).toFixed(1)}%`
          : "0%",
      bundle_events: activity.bundle_events,
    };
    return userPayload;
  }

  private parseJson(text: string, truncated = false): BriefingResult | null {
    const jsonStr = this.stripJsonFences(text);

    // Attempt 1: parse as-is.
    const asIs = this.safeParse(jsonStr);
    if (asIs !== undefined) return asIs;

    // Attempt 1b: strip trailing commas (a common LLM JSON error) and retry.
    const cleaned = jsonStr.replace(/,\s*([}\]])/g, "$1");
    if (cleaned !== jsonStr) {
      const reparsed = this.safeParse(cleaned);
      if (reparsed !== undefined) return reparsed;
    }

    // Attempt 2: extract the outermost complete JSON object.
    const braceStart = jsonStr.indexOf("{");
    const extracted = this.parseExtractedObject(jsonStr, braceStart);
    if (extracted !== undefined) return extracted;

    // Attempt 3: repair truncated JSON — close open structures.
    if (truncated && braceStart !== -1) {
      const repaired = this.repairTruncatedJson(jsonStr.slice(braceStart));
      if (repaired) return repaired;
    }

    return null;
  }

  /** Strip markdown fences (closed, or a truncated-open leading fence) from an LLM JSON response. */
  private stripJsonFences(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) return (fenceMatch[1] ?? "").trim();
    const openFence = text.match(/^```(?:json)?\s*\n?/);
    return openFence ? text.slice(openFence[0].length).trim() : text.trim();
  }

  /** JSON.parse that yields undefined (never a valid JSON value) instead of throwing. */
  private safeParse(str: string): BriefingResult | undefined {
    try {
      return JSON.parse(str) as BriefingResult;
    } catch {
      return undefined;
    }
  }

  /** Attempt 2: parse the substring between the first `{` and last `}`, with a trailing-comma retry. */
  private parseExtractedObject(jsonStr: string, braceStart: number): BriefingResult | undefined {
    const braceEnd = jsonStr.lastIndexOf("}");
    if (braceStart === -1 || braceEnd <= braceStart) return undefined;
    const extracted = jsonStr.slice(braceStart, braceEnd + 1);
    const direct = this.safeParse(extracted);
    if (direct !== undefined) return direct;
    return this.safeParse(extracted.replace(/,\s*([}\]])/g, "$1"));
  }

  /**
   * Attempt to repair truncated JSON by trimming to the last complete value
   * boundary, then closing remaining open structures.
   * Only called when we know the response was cut short (finishReason: "length").
   */
  private repairTruncatedJson(json: string): BriefingResult | null {
    // Trim back to the last `}` or `]` — this drops any partially written
    // object/array entry and leaves us at a clean structural boundary, then
    // strips any trailing comma after that last complete value.
    const lastBrace = Math.max(json.lastIndexOf("}"), json.lastIndexOf("]"));
    if (lastBrace === -1) return null;
    const trimmed = json.slice(0, lastBrace + 1).replace(/,\s*$/, "");

    // Close remaining open structures in reverse order.
    const closed = trimmed + this.unclosedBrackets(trimmed).reverse().join("");
    try {
      const parsed = JSON.parse(closed);
      if (typeof parsed.lede === "string" && Array.isArray(parsed.sections)) {
        return parsed;
      }
    } catch {
      // repair failed
    }
    return null;
  }

  /** Collect the still-open bracket/brace closers in `text`, outermost last. */
  private unclosedBrackets(text: string): string[] {
    const state: ScanState = { opens: [], inString: false, escaped: false };
    for (const ch of text) this.scanChar(state, ch);
    return state.opens;
  }

  /** Fold one character into the truncation-repair bracket-scan state. */
  private scanChar(state: ScanState, ch: string): void {
    if (state.escaped) {
      state.escaped = false;
      return;
    }
    if (ch === "\\") {
      state.escaped = true;
      return;
    }
    if (ch === '"') {
      state.inString = !state.inString;
      return;
    }
    if (state.inString) return;
    if (ch === "{") state.opens.push("}");
    else if (ch === "[") state.opens.push("]");
    else if (ch === "}" || ch === "]") state.opens.pop();
  }

  private deriveState(sections: BriefingSection[]): BriefingState {
    if (sections.length === 0) return "normal";
    if (sections.some((s) => s.type === "warning")) return "attention";
    if (sections.every((s) => s.type === "positive")) return "all-clear";
    return "normal";
  }
}
