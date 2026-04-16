import type { LanguageModelV3 } from "@ai-sdk/provider";
import { buildModelResolver, resolveModelString } from "../../../../model/registry.ts";
import type { ActivityOutput, BriefingOutput, BriefingSection, BriefingState } from "./types.ts";

const BRIEFING_SYSTEM_PROMPT = `You are a workspace briefing generator for NimbleBrain, an AI agent runtime.

Given a JSON object describing workspace activity over the last 24 hours, produce a briefing as a JSON object with two fields:

1. "lede" — A single sentence (max 120 chars) summarizing the most important thing. Be specific, not generic.
2. "sections" — An array of 1–5 briefing sections, each with:
   - "id": a short kebab-case identifier (e.g., "tool-errors", "new-bundles")
   - "text": 1–2 sentences describing what happened
   - "type": "positive" | "neutral" | "warning"
   - "category": "recent" | "upcoming" | "attention"
   - "action" (optional): semantic action object, one of:
     - { "type": "openConversation", "id": "<conversationId>", "label": "View conversation" }
     - { "type": "startChat", "prompt": "<natural language prompt>", "label": "Ask about this" }
     - { "type": "openApp", "name": "<serverName>", "label": "Open app" }

Rules:
- Prioritize warnings (errors, crashes) first, then notable activity, then routine.
- Use concrete numbers ("3 tool errors in granola") not vague language ("some issues").
- If there are errors or crashes, at least one section must have type "warning" and category "attention".
- If everything went well, use type "positive".
- Keep the total output under 800 tokens.
- Return ONLY valid JSON. No markdown, no explanation.
- Actions are semantic — never include route paths or URLs. The shell handles navigation.`;

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
    lede: { type: "string" as const },
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
                  type: {
                    type: "string" as const,
                    enum: ["openConversation", "startChat", "openApp"],
                  },
                  id: {
                    type: "string" as const,
                    description: "Conversation ID for openConversation",
                  },
                  prompt: { type: "string" as const, description: "Prompt for startChat" },
                  name: { type: "string" as const, description: "Server name for openApp" },
                  label: { type: "string" as const },
                },
                required: ["type", "id", "prompt", "name", "label"],
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
 * Read providers config from nimblebrain.json (derived from NB_WORK_DIR).
 * Falls back to anthropic-only if config isn't available.
 */
function loadProvidersFromConfig(): {
  providers: Record<string, { apiKey?: string }>;
  defaultModel: string;
} {
  const workDir = process.env.NB_WORK_DIR;
  if (workDir) {
    try {
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const raw = JSON.parse(readFileSync(join(workDir, "nimblebrain.json"), "utf-8"));
      return {
        providers: raw.providers ?? { anthropic: {} },
        defaultModel: raw.defaultModel ?? "anthropic:claude-sonnet-4-6",
      };
    } catch {
      // Config unreadable — fall through
    }
  }
  return {
    providers: { anthropic: {} },
    defaultModel: "anthropic:claude-sonnet-4-6",
  };
}

export class BriefingGenerator {
  private resolveModel: ((modelString: string) => LanguageModelV3) | null = null;
  private modelId: string;
  private userName: string;
  private timezone: string;

  constructor() {
    const config = loadProvidersFromConfig();
    this.modelId = process.env.NB_HOME_MODEL ?? config.defaultModel;
    this.userName = process.env.NB_HOME_USERNAME ?? "there";
    this.timezone = process.env.NB_HOME_TIMEZONE ?? "";

    try {
      this.resolveModel = buildModelResolver({
        providers: config.providers,
      });
    } catch {
      // Provider init failed — briefings will use fallback
    }
  }

  async generate(activity: ActivityOutput): Promise<BriefingOutput> {
    const greeting = this.buildGreeting();
    const date = this.formatDate();
    const now = new Date().toISOString();

    if (this.isEmpty(activity)) {
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

    return this.generateWithLlm(activity, greeting, date, now);
  }

  private buildGreeting(): string {
    const hour = this.getHourInTimezone();
    const name = this.userName;
    if (hour < 12) return `Good morning, ${name}`;
    if (hour < 17) return `Good afternoon, ${name}`;
    return `Good evening, ${name}`;
  }

  private getHourInTimezone(): number {
    const tz = this.timezone;
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
    const tz = this.timezone || undefined;
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
  ): Promise<BriefingOutput> {
    if (!this.resolveModel) {
      return this.fallbackBriefing(greeting, date, now);
    }

    try {
      const resolved = resolveModelString(this.modelId);
      const model = this.resolveModel(resolved);
      const response = await model.doGenerate({
        prompt: [
          {
            role: "system",
            content: BRIEFING_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(activity) }],
          },
        ],
        responseFormat: {
          type: "json",
          schema: BRIEFING_RESPONSE_SCHEMA,
          name: "briefing",
          description: "Daily workspace briefing with sections",
        },
        maxOutputTokens: 2000,
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return this.fallbackBriefing(greeting, date, now);
      }

      const parsed = this.parseJson(textBlock.text);
      if (!parsed || typeof parsed.lede !== "string" || !Array.isArray(parsed.sections)) {
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
    } catch {
      return this.fallbackBriefing(greeting, date, now);
    }
  }

  private parseJson(text: string): { lede: string; sections: BriefingSection[] } | null {
    let cleaned = text.trim();

    if (cleaned.startsWith("```")) {
      const firstNewline = cleaned.indexOf("\n");
      if (firstNewline !== -1) {
        cleaned = cleaned.slice(firstNewline + 1);
      }
      if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3).trimEnd();
      }
    }

    try {
      return JSON.parse(cleaned);
    } catch {
      // Strip trailing commas (common LLM JSON error) and retry
      try {
        return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        return null;
      }
    }
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
