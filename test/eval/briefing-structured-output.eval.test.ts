/**
 * Briefing structured output eval — validates that BriefingGenerator produces
 * valid, parseable briefings across all three LLM providers.
 *
 * Requires env vars (skip gracefully if missing):
 *   ANTHROPIC_API_KEY — Anthropic (Claude)
 *   OPENAI_API_KEY    — OpenAI (GPT-4o-mini)
 *   GOOGLE_API_KEY    — Google (Gemini)
 *
 * Run: bun run eval
 */
import { describe, expect, it } from "bun:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { buildModelResolver } from "../../src/model/registry.ts";
import type { BriefingContext } from "../../src/services/briefing-collector.ts";
import { BriefingGenerator } from "../../src/services/briefing-generator.ts";
import type { BriefingOutput } from "../../src/services/home-types.ts";

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

interface ProviderSpec {
  name: string;
  envVar: string;
  modelString: string;
}

const PROVIDERS: ProviderSpec[] = [
  { name: "anthropic", envVar: "ANTHROPIC_API_KEY", modelString: "anthropic:claude-haiku-4-5-20251001" },
  { name: "openai", envVar: "OPENAI_API_KEY", modelString: "openai:gpt-4o-mini" },
  { name: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY", modelString: "google:gemini-2.0-flash" },
];

// ---------------------------------------------------------------------------
// Test fixtures — realistic facet data matching production patterns
// ---------------------------------------------------------------------------

/** Facet context simulating installed apps with briefing data. */
function richFacetContext(): BriefingContext {
  return {
    period: { since: "2026-04-13T00:00:00Z", until: "2026-04-14T00:00:00Z" },
    facets: [
      {
        facet: { name: "overdue_followups", label: "Overdue follow-ups", type: "attention" as const },
        appName: "CRM",
        serverName: "synapse-crm",
        appRoute: "@nimblebraininc/synapse-crm",
        data: JSON.stringify({ count: 13, oldest: "2026-04-01", contacts: ["Jane Smith", "Bob Chen", "Acme Corp"] }),
        ok: true,
      },
      {
        facet: { name: "tasks_due_today", label: "Tasks due today", type: "upcoming" as const },
        appName: "Tasks",
        serverName: "synapse-todo",
        appRoute: "@nimblebraininc/synapse-todo-board",
        data: JSON.stringify({ count: 1, tasks: [{ title: "Send Acme proposal", priority: "high" }] }),
        ok: true,
      },
      {
        facet: { name: "recent_meetings", label: "Recent meetings", type: "activity" as const },
        appName: "Granola",
        serverName: "granola",
        appRoute: null,
        data: JSON.stringify({ count: 3, latest: "Standup with engineering team" }),
        ok: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertValidBriefing(briefing: BriefingOutput, label: string): void {
  // Core structure
  expect(typeof briefing.lede).toBe("string");
  expect(briefing.lede.length).toBeGreaterThan(0);
  expect(briefing.lede.length).toBeLessThanOrEqual(200); // prompt says 120, allow some slack
  expect(Array.isArray(briefing.sections)).toBe(true);
  expect(briefing.sections.length).toBeGreaterThanOrEqual(1);
  expect(briefing.sections.length).toBeLessThanOrEqual(6);

  // Each section
  for (const section of briefing.sections) {
    expect(typeof section.id).toBe("string");
    expect(section.id.length).toBeGreaterThan(0);
    expect(typeof section.text).toBe("string");
    expect(section.text.length).toBeGreaterThan(0);
    expect(["positive", "neutral", "warning"]).toContain(section.type);
    expect(["recent", "upcoming", "attention"]).toContain(section.category);

    // Action is optional (null or object). When present, the LLM must
    // discriminate by `type`: navigate carries a route (prompt is
    // null); startChat carries a prompt (route is null). This pins
    // the wire contract the host bridge depends on — a future schema
    // tweak that lets the LLM fabricate both fields would silently
    // ship dead "Open …" buttons (the bug fixed by C1).
    if (section.action != null) {
      expect(typeof section.action).toBe("object");
      expect(["navigate", "startChat"]).toContain(section.action.type);
      expect(typeof section.action.label).toBe("string");
      if (section.action.type === "navigate") {
        expect(typeof section.action.route).toBe("string");
        expect(section.action.route).not.toBe("");
        expect(section.action.prompt).toBeNull();
      } else if (section.action.type === "startChat") {
        expect(typeof section.action.prompt).toBe("string");
        expect(section.action.prompt).not.toBe("");
        expect(section.action.route).toBeNull();
      }
    }
  }

  // State derivation
  expect(["empty", "quiet", "all-clear", "normal", "attention"]).toContain(briefing.state);
  expect(typeof briefing.generated_at).toBe("string");
  expect(briefing.cached).toBe(false);

  console.log(`  [${label}] lede: "${briefing.lede}"`);
  console.log(`  [${label}] sections: ${briefing.sections.length}, state: ${briefing.state}`);
}

// ---------------------------------------------------------------------------
// Eval suite
// ---------------------------------------------------------------------------

function resolveModel(spec: ProviderSpec): LanguageModelV4 | null {
  const apiKey = process.env[spec.envVar];
  if (!apiKey) return null;

  const resolver = buildModelResolver({
    providers: { [spec.name]: { apiKey } },
  });
  return resolver(spec.modelString);
}

describe("briefing structured output", () => {
  for (const spec of PROVIDERS) {
    const apiKey = process.env[spec.envVar];

    describe(spec.name, () => {
      const skipReason = apiKey ? undefined : `${spec.envVar} not set`;

      it.skipIf(!apiKey)(
        "generates valid briefing from facets",
        async () => {
          const model = resolveModel(spec)!;
          const gen = new BriefingGenerator(model, spec.modelString);
          const briefing = await gen.generate(richFacetContext());
          assertValidBriefing(briefing, spec.name);

          // With 13 overdue follow-ups, at least one section should be a warning
          const hasWarning = briefing.sections.some((s) => s.type === "warning");
          expect(hasWarning).toBe(true);
        },
        30_000,
      );

      if (skipReason) {
        it.skip(`skipped: ${skipReason}`, () => {});
      }
    });
  }
});
