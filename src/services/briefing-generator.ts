import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { BriefingContext } from "./briefing-collector.ts";
import type {
  ActivityOutput,
  BriefingOutput,
  BriefingSection,
  BriefingState,
  HomeConfig,
} from "./home-types.ts";

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
    private model: LanguageModelV3,
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
    try {
      // Build the user message with facet context (primary) and activity (secondary)
      const userPayload: Record<string, unknown> = {};
      if (facetContext && facetContext.facets.length > 0) {
        userPayload.app_facets = facetContext.facets.map((f) => ({
          app: f.appName,
          route: f.appRoute,
          label: f.facet.label,
          type: f.facet.type,
          data: f.data,
          ok: f.ok,
        }));
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

      const abort = AbortSignal.timeout(15_000);
      const response = await this.model.doGenerate({
        prompt: [
          { role: "system", content: BRIEFING_SYSTEM_PROMPT },
          {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(userPayload) }],
          },
        ],
        responseFormat: {
          type: "json",
          schema: BRIEFING_RESPONSE_SCHEMA,
          name: "briefing",
          description: "Daily workspace briefing with sections",
        },
        maxOutputTokens: 4000,
        abortSignal: abort,
      });

      const finishReason = response.finishReason?.unified ?? "unknown";
      if (finishReason === "length") {
        console.warn("[briefing] LLM response truncated (hit token limit)");
      }

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        console.error("[briefing] no text block in LLM response");
        return this.fallbackBriefing(greeting, date, now);
      }

      const parsed = this.parseJson(textBlock.text, finishReason === "length");
      if (!parsed || typeof parsed.lede !== "string" || !Array.isArray(parsed.sections)) {
        console.error(
          "[briefing] failed to parse briefing JSON. finishReason=%s, first 500 chars: %s",
          finishReason,
          textBlock.text.slice(0, 500),
        );
        return this.fallbackBriefing(greeting, date, now);
      }

      const sections: BriefingSection[] = parsed.sections;
      const state = this.deriveState(sections);

      return {
        greeting,
        date,
        lede: parsed.lede,
        sections,
        state,
        generated_at: now,
        cached: false,
      };
    } catch (err) {
      console.error("[briefing] LLM generation failed:", err instanceof Error ? err.message : err);
      return this.fallbackBriefing(greeting, date, now);
    }
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

  private fallbackBriefing(greeting: string, date: string, now: string): BriefingOutput {
    return {
      greeting,
      date,
      lede: "Activity summary is available.",
      sections: [],
      state: "normal",
      generated_at: now,
      cached: false,
    };
  }
}
