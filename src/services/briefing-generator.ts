import type { ModelProfile } from "../model/model-profile.ts";
import type { BriefingContext, FacetResult } from "./briefing-collector.ts";
import type {
  ActivityOutput,
  BriefingOutput,
  BriefingSection,
  BriefingState,
  HomeConfig,
} from "./home-types.ts";

/**
 * Per-attempt wall-clock cap. The first attempt is generous; the retry is
 * tighter and uses a smaller token cap to favor latency over completeness.
 * Worst-case total wait before the heuristic fallback is FIRST + RETRY.
 */
const BRIEFING_TIMEOUT_MS_FIRST = 30_000;
const BRIEFING_TIMEOUT_MS_RETRY = 20_000;

/**
 * Output token caps. The prompt asks for "under 800 tokens" — 1500 gives
 * headroom for a verbose run, 800 hard-caps the retry to prevent runaway
 * generation when the first attempt already burned wall-clock budget.
 */
const BRIEFING_MAX_OUTPUT_TOKENS_FIRST = 1500;
const BRIEFING_MAX_OUTPUT_TOKENS_RETRY = 800;

/**
 * Input bounds. A tenant with thousands of CRM rows shouldn't be able to
 * blow up the LLM input — we send the highest-priority facets only and
 * truncate each one's `data` payload.
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
   - "action" (optional): semantic action object, one of:
     - { "type": "navigate", "route": "<route from facet>", "label": "Open CRM" }
     - { "type": "startChat", "prompt": "<natural language prompt>", "label": "Ask about this" }
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
                  route: { type: "string" as const, description: "Route for navigate actions" },
                  prompt: { type: "string" as const, description: "Prompt for startChat actions" },
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

export class BriefingGenerator {
  constructor(
    private profile: ModelProfile,
    private config: HomeConfig,
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

    return this.generateWithLlm(activity, greeting, date, now, facetContext);
  }

  private get modelString(): string {
    return this.profile.modelString;
  }

  private get providerName(): string {
    return this.profile.provider;
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

    // First attempt — generous budget.
    const first = await this.attempt(userText, 1, {
      timeoutMs: BRIEFING_TIMEOUT_MS_FIRST,
      maxOutputTokens: BRIEFING_MAX_OUTPUT_TOKENS_FIRST,
    });
    if (first.kind === "ok") {
      return this.buildBriefing(greeting, date, now, first.parsed);
    }

    // Don't retry on terminal failures (auth, model-not-found, etc.).
    if (!first.retryable) {
      return this.buildHeuristicBriefing(greeting, date, now, facetContext);
    }

    // Single retry — tighter wall-clock and token cap.
    const second = await this.attempt(userText, 2, {
      timeoutMs: BRIEFING_TIMEOUT_MS_RETRY,
      maxOutputTokens: BRIEFING_MAX_OUTPUT_TOKENS_RETRY,
    });
    if (second.kind === "ok") {
      return this.buildBriefing(greeting, date, now, second.parsed);
    }

    return this.buildHeuristicBriefing(greeting, date, now, facetContext);
  }

  /**
   * One LLM attempt. Returns a discriminated result so the caller can
   * decide whether to retry without re-throwing. Recoverable failures
   * (timeout, empty, parse, 5xx) carry retryable=true; terminal failures
   * (4xx auth/model-not-found) carry retryable=false.
   */
  private async attempt(
    userText: string,
    attemptNumber: number,
    opts: { timeoutMs: number; maxOutputTokens: number },
  ): Promise<AttemptResult> {
    const start = performance.now();
    const providerOptions = this.profile.providerOptions;

    try {
      const abort = AbortSignal.timeout(opts.timeoutMs);
      const response = await this.profile.model.doGenerate({
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
        maxOutputTokens: opts.maxOutputTokens,
        abortSignal: abort,
        ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      });

      const finishReason = response.finishReason?.unified ?? "unknown";
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        this.logFailure("empty", attemptNumber, start);
        return { kind: "fail", reason: "empty", retryable: true };
      }

      const parsed = this.parseJson(textBlock.text, finishReason === "length");
      if (!parsed || typeof parsed.lede !== "string" || !Array.isArray(parsed.sections)) {
        this.logFailure("parse", attemptNumber, start, {
          finish_reason: finishReason,
          preview: textBlock.text.slice(0, 200),
        });
        return { kind: "fail", reason: "parse", retryable: true };
      }

      return { kind: "ok", parsed };
    } catch (err) {
      const { reason, retryable } = classifyError(err);
      this.logFailure(reason, attemptNumber, start, {
        message: err instanceof Error ? err.message : String(err),
      });
      return { kind: "fail", reason, retryable };
    }
  }

  private logFailure(
    reason: FailureReason,
    attempt: number,
    start: number,
    extra: Record<string, unknown> = {},
  ): void {
    const elapsedMs = Math.round(performance.now() - start);
    const fields = [
      `reason=${reason}`,
      `provider=${this.providerName}`,
      `model=${this.modelString}`,
      `attempt=${attempt}`,
      `elapsed_ms=${elapsedMs}`,
    ];
    for (const [k, v] of Object.entries(extra)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      // Inline single-line for grep-ability; truncate noisy strings.
      fields.push(`${k}=${s.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    console.warn(`[briefing] generation failed ${fields.join(" ")}`);
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

  private buildBriefing(
    greeting: string,
    date: string,
    now: string,
    parsed: { lede: string; sections: BriefingSection[] },
  ): BriefingOutput {
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

  private parseJson(
    text: string,
    truncated = false,
  ): { lede: string; sections: BriefingSection[] } | null {
    // Extract JSON from the response, stripping any markdown fences or surrounding text.
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    let jsonStr: string;
    if (fenceMatch) {
      jsonStr = (fenceMatch[1] ?? "").trim();
    } else {
      // Strip opening fence if present but unclosed (truncated response)
      const openFence = text.match(/^```(?:json)?\s*\n?/);
      jsonStr = openFence ? text.slice(openFence[0].length).trim() : text.trim();
    }

    // Attempt 1: parse as-is
    try {
      return JSON.parse(jsonStr);
    } catch {
      // continue to fallbacks
    }

    // Attempt 1b: strip trailing commas (common LLM JSON error) and retry
    const cleaned = jsonStr.replace(/,\s*([}\]])/g, "$1");
    if (cleaned !== jsonStr) {
      try {
        return JSON.parse(cleaned);
      } catch {
        // continue to fallbacks
      }
    }

    // Attempt 2: extract the outermost complete JSON object
    const braceStart = jsonStr.indexOf("{");
    const braceEnd = jsonStr.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      const extracted = jsonStr.slice(braceStart, braceEnd + 1);
      try {
        return JSON.parse(extracted);
      } catch {
        // try with trailing comma cleanup
        try {
          return JSON.parse(extracted.replace(/,\s*([}\]])/g, "$1"));
        } catch {
          // continue to repair
        }
      }
    }

    // Attempt 3: repair truncated JSON — close open structures
    if (truncated && braceStart !== -1) {
      const repaired = this.repairTruncatedJson(jsonStr.slice(braceStart));
      if (repaired) return repaired;
    }

    return null;
  }

  /**
   * Attempt to repair truncated JSON by trimming to the last complete value
   * boundary, then closing remaining open structures.
   * Only called when we know the response was cut short (finishReason: "length").
   */
  private repairTruncatedJson(json: string): { lede: string; sections: BriefingSection[] } | null {
    // Trim back to the last `}` or `]` — this drops any partially written
    // object/array entry and leaves us at a clean structural boundary.
    const lastBrace = Math.max(json.lastIndexOf("}"), json.lastIndexOf("]"));
    if (lastBrace === -1) return null;
    let trimmed = json.slice(0, lastBrace + 1);

    // Strip any trailing comma after the last complete value
    trimmed = trimmed.replace(/,\s*$/, "");

    // Count open/close brackets and braces to determine what to append
    const opens: string[] = [];
    let inString = false;
    let escaped = false;
    for (const ch of trimmed) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") opens.push("}");
      else if (ch === "[") opens.push("]");
      else if (ch === "}" || ch === "]") opens.pop();
    }

    // Close remaining structures in reverse order
    const closed = trimmed + opens.reverse().join("");
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

  private deriveState(sections: BriefingSection[]): BriefingState {
    if (sections.length === 0) return "normal";
    if (sections.some((s) => s.type === "warning")) return "attention";
    if (sections.every((s) => s.type === "positive")) return "all-clear";
    return "normal";
  }

  /**
   * Best-effort briefing built without an LLM, used when both attempts
   * fail or the failure is terminal. Walks `facetContext` and emits one
   * section per facet with sensible category/type mapping. The result is
   * marked `degraded: true` so it isn't cached and the UI can show a
   * retry affordance.
   */
  private buildHeuristicBriefing(
    greeting: string,
    date: string,
    now: string,
    facetContext: BriefingContext | undefined,
  ): BriefingOutput {
    const sections = facetContext ? facetsToSections(facetContext.facets) : [];
    const lede =
      sections.length > 0 ? buildHeuristicLede(sections) : "Activity summary is available.";

    return {
      greeting,
      date,
      lede,
      sections,
      state: this.deriveState(sections),
      generated_at: now,
      cached: false,
      degraded: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Failure classification + heuristic helpers
// ---------------------------------------------------------------------------

type FailureReason =
  | "timeout"
  | "empty"
  | "parse"
  | "auth"
  | "bad_request"
  | "rate_limit"
  | "server"
  | "unknown";

type AttemptResult =
  | { kind: "ok"; parsed: { lede: string; sections: BriefingSection[] } }
  | { kind: "fail"; reason: FailureReason; retryable: boolean };

/**
 * Map a thrown error from `model.doGenerate` into a stable failure
 * category and a retry decision. Keeps the structural decision (retry?)
 * separate from the reporting decision (what to log).
 *
 * Most providers throw plain Errors with statusCode hints; AbortSignal
 * timeouts surface as DOMException `TimeoutError` or an Error whose
 * message contains "timed out" / "aborted". Treat anything we can't
 * confidently classify as retryable to avoid permanently dead briefings
 * on novel error shapes.
 */
function classifyError(err: unknown): { reason: FailureReason; retryable: boolean } {
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message.toLowerCase();
    if (name === "TimeoutError" || msg.includes("timed out") || msg.includes("aborted")) {
      return { reason: "timeout", retryable: true };
    }
    const status =
      (err as { statusCode?: number; status?: number }).statusCode ??
      (err as { statusCode?: number; status?: number }).status;
    if (typeof status === "number") {
      if (status === 401 || status === 403 || status === 404) {
        return { reason: "auth", retryable: false };
      }
      if (status === 429) {
        return { reason: "rate_limit", retryable: true };
      }
      if (status >= 500) {
        return { reason: "server", retryable: true };
      }
      if (status >= 400) {
        // Other 4xx — 400 BadRequest, 422 Unprocessable, etc. Same
        // retry decision as auth (don't retry with the same payload)
        // but distinct in logs so operators triage the right thing.
        return { reason: "bad_request", retryable: false };
      }
    }
  }
  return { reason: "unknown", retryable: true };
}

/**
 * Convert facet results into briefing sections deterministically. Used
 * only for the heuristic fallback — the LLM path produces richer prose
 * and tighter selection. Skips facets whose data string indicates an
 * empty result ("0 matching", etc.) to match the prompt's "skip empty
 * facets" rule.
 */
function facetsToSections(facets: FacetResult[]): BriefingSection[] {
  const sections: BriefingSection[] = [];
  for (const f of facets) {
    if (!f.ok) continue;
    if (isEmptyFacetData(f.data)) continue;

    const summary = summarizeFacetData(f.data);
    if (!summary) continue;

    const category: BriefingSection["category"] =
      f.facet.type === "attention"
        ? "attention"
        : f.facet.type === "upcoming"
          ? "upcoming"
          : "recent";

    const type: BriefingSection["type"] = f.facet.type === "attention" ? "warning" : "neutral";

    const section: BriefingSection = {
      id: slugify(`${f.appName}-${f.facet.label}`),
      text: `${f.facet.label}: ${summary}`,
      type,
      category,
    };

    if (f.appRoute) {
      section.action = {
        label: `Open ${f.appName}`,
        type: "navigate",
        value: f.appRoute,
      };
    }

    sections.push(section);
  }
  return sections;
}

function buildHeuristicLede(sections: BriefingSection[]): string {
  const attention = sections.filter((s) => s.category === "attention").length;
  const upcoming = sections.filter((s) => s.category === "upcoming").length;
  if (attention > 0) {
    return `${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention.`;
  }
  if (upcoming > 0) {
    return `${upcoming} upcoming item${upcoming === 1 ? "" : "s"} on deck.`;
  }
  return `${sections.length} update${sections.length === 1 ? "" : "s"} from your apps.`;
}

function isEmptyFacetData(data: string): boolean {
  // Entity facet output starts with "N matching ..." — pull out N to detect 0.
  const match = data.match(/^(\d+)\s+matching/);
  if (match && match[1] === "0") return true;
  return data.length === 0;
}

function summarizeFacetData(data: string): string {
  // Entity facet: "5 matching task entities (12 total). Matching: [...]"
  // Take the prefix before "Matching:" or the first sentence.
  const prefix = data.split(/\.\s*(?:Matching:|$)/)[0]?.trim() ?? "";
  if (prefix.length > 0 && prefix.length <= 160) return prefix;
  if (prefix.length > 160) return `${prefix.slice(0, 157)}…`;
  // Tool/resource facet: take first 120 chars.
  return data.slice(0, 120).trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
