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
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { buildModelResolver } from "../../src/model/registry.ts";
import { BriefingGenerator } from "../../src/services/briefing-generator.ts";
import type { BriefingContext } from "../../src/services/briefing-collector.ts";
import type {
  ActivityOutput,
  BriefingOutput,
  HomeConfig,
} from "../../src/services/home-types.ts";

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
// Test fixtures — realistic activity data matching production patterns
// ---------------------------------------------------------------------------

function makeConfig(): HomeConfig {
  return {
    enabled: true,
    model: null,
    userName: "Mat",
    timezone: "Pacific/Honolulu",
    cacheTtlMinutes: 15,
  };
}

/** Activity with multiple data points — exercises all section types. */
function richActivity(): ActivityOutput {
  return {
    period: { since: "2026-04-13T00:00:00Z", until: "2026-04-14T00:00:00Z" },
    conversations: [
      {
        id: "conv-1",
        created_at: "2026-04-13T09:00:00Z",
        updated_at: "2026-04-13T09:15:00Z",
        message_count: 8,
        tool_call_count: 5,
        input_tokens: 3200,
        output_tokens: 1800,
        preview: "Review Q2 pipeline and update CRM contacts",
        had_errors: false,
      },
      {
        id: "conv-2",
        created_at: "2026-04-13T14:00:00Z",
        updated_at: "2026-04-13T14:30:00Z",
        message_count: 12,
        tool_call_count: 8,
        input_tokens: 5000,
        output_tokens: 3000,
        preview: "Draft proposal for Acme Corp engagement",
        had_errors: true,
      },
    ],
    bundle_events: [
      { bundle: "@nimblebraininc/granola", event: "crashed", timestamp: "2026-04-13T11:00:00Z", detail: "Connection timeout" },
      { bundle: "@nimblebraininc/granola", event: "recovered", timestamp: "2026-04-13T11:02:00Z" },
    ],
    tool_usage: [
      { tool: "search_meetings", server: "granola", call_count: 6, error_count: 1, avg_latency_ms: 250 },
      { tool: "list_contacts", server: "synapse-crm", call_count: 4, error_count: 0, avg_latency_ms: 80 },
      { tool: "create_draft", server: "gmail", call_count: 2, error_count: 0, avg_latency_ms: 400 },
    ],
    errors: [
      { timestamp: "2026-04-13T14:20:00Z", source: "tool", message: "granola search_meetings: timeout after 5000ms", context: "conv-2" },
    ],
    totals: {
      conversations: 2,
      tool_calls: 12,
      input_tokens: 8200,
      output_tokens: 4800,
      errors: 1,
    },
  };
}

/** Facet context simulating installed apps with briefing data. */
function richFacetContext(): BriefingContext {
  return {
    period: { since: "2026-04-13T00:00:00Z", until: "2026-04-14T00:00:00Z" },
    facets: [
      {
        facet: { label: "Overdue follow-ups", type: "attention" as const },
        appName: "CRM",
        serverName: "synapse-crm",
        appRoute: "@nimblebraininc/synapse-crm",
        data: JSON.stringify({ count: 13, oldest: "2026-04-01", contacts: ["Jane Smith", "Bob Chen", "Acme Corp"] }),
        ok: true,
      },
      {
        facet: { label: "Tasks due today", type: "upcoming" as const },
        appName: "Tasks",
        serverName: "synapse-todo",
        appRoute: "@nimblebraininc/synapse-todo-board",
        data: JSON.stringify({ count: 1, tasks: [{ title: "Send Acme proposal", priority: "high" }] }),
        ok: true,
      },
      {
        facet: { label: "Recent meetings", type: "activity" as const },
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

    // Action is optional (null or object)
    if (section.action != null) {
      expect(typeof section.action).toBe("object");
      expect(typeof section.action.type).toBe("string");
      expect(typeof section.action.label).toBe("string");
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

function resolveModel(spec: ProviderSpec): LanguageModelV3 | null {
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
        "generates valid briefing from rich activity + facets",
        async () => {
          const model = resolveModel(spec)!;
          const gen = new BriefingGenerator(model, makeConfig());
          const briefing = await gen.generate(richActivity(), richFacetContext());
          assertValidBriefing(briefing, spec.name);

          // With 13 overdue follow-ups, at least one section should be a warning
          const hasWarning = briefing.sections.some((s) => s.type === "warning");
          expect(hasWarning).toBe(true);
        },
        30_000,
      );

      it.skipIf(!apiKey)(
        "generates valid briefing from activity only (no facets)",
        async () => {
          const model = resolveModel(spec)!;
          const gen = new BriefingGenerator(model, makeConfig());
          const briefing = await gen.generate(richActivity());
          assertValidBriefing(briefing, `${spec.name}/no-facets`);
        },
        30_000,
      );

      if (skipReason) {
        it.skip(`skipped: ${skipReason}`, () => {});
      }
    });
  }
});
