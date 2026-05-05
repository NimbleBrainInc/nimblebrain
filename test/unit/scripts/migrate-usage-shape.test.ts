import { describe, expect, test } from "bun:test";
import { migrateLine } from "../../../scripts/migrate-usage-shape.ts";

/**
 * Table-driven coverage for the migration script's per-line transform.
 *
 * `migrateLine` is the kernel of `scripts/migrate-usage-shape.ts` — a
 * pure function that takes one JSONL line and returns the (possibly
 * rewritten) line plus per-change booleans. The script touches
 * production conversation data, so this nails down the documented
 * behavior matrix at CI time rather than at 2 a.m. when an operator
 * runs it on a corrupted corpus.
 *
 * Cases mirror the docstring at scripts/migrate-usage-shape.ts:30-60.
 */

interface Case {
  name: string;
  input: Record<string, unknown> | string;
  expect: {
    rewroteEvent?: boolean;
    rewroteMessage?: boolean;
    droppedCostUsd?: boolean;
    malformed?: boolean;
    /** Optional shape assertion on the rewritten JSON (parsed). */
    output?: (parsed: Record<string, unknown>) => void;
  };
}

const CASES: Case[] = [
  // ---- Event-format llm.response ----
  {
    name: "rewrites flat fields into nested usage with cacheCreation→cacheWrite rename",
    input: {
      ts: "2025-01-01T00:00:00Z",
      type: "llm.response",
      runId: "r1",
      model: "m1",
      content: [{ type: "text", text: "ok" }],
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 30,
      reasoningTokens: 5,
      llmMs: 200,
    },
    expect: {
      rewroteEvent: true,
      output: (p) => {
        expect(p.usage).toEqual({
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 30,
          reasoningTokens: 5,
        });
        // Flat fields must be GONE so subsequent reads don't see both shapes.
        expect(p.inputTokens).toBeUndefined();
        expect(p.outputTokens).toBeUndefined();
        expect(p.cacheReadTokens).toBeUndefined();
        expect(p.cacheCreationTokens).toBeUndefined();
        expect(p.reasoningTokens).toBeUndefined();
        // Non-token fields preserved.
        expect(p.runId).toBe("r1");
        expect(p.model).toBe("m1");
        expect(p.llmMs).toBe(200);
      },
    },
  },
  {
    name: "elides zero-valued optional cache/reasoning fields in usage",
    input: {
      type: "llm.response",
      ts: "t",
      runId: "r1",
      model: "m",
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      llmMs: 150,
    },
    expect: {
      rewroteEvent: true,
      output: (p) => {
        expect(p.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
      },
    },
  },
  {
    name: "leaves event-format already-migrated lines untouched (idempotent)",
    input: {
      type: "llm.response",
      ts: "t",
      runId: "r1",
      model: "m",
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 50, outputTokens: 25 },
      llmMs: 100,
    },
    expect: {
      rewroteEvent: false,
      output: (p) => {
        // Untouched
        expect(p.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
      },
    },
  },
  {
    name: "skips llm.response events that have no token data at all",
    input: { type: "llm.response", ts: "t", runId: "r1", model: "m", llmMs: 0 },
    expect: { rewroteEvent: false },
  },
  {
    name: "treats `usage: null` as not-yet-migrated (typeof null === object guard)",
    input: {
      type: "llm.response",
      ts: "t",
      runId: "r1",
      model: "m",
      inputTokens: 40,
      outputTokens: 20,
      usage: null,
      llmMs: 50,
    },
    expect: {
      rewroteEvent: true,
      output: (p) => {
        expect(p.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
      },
    },
  },

  // ---- Legacy StoredMessage assistant.metadata ----
  {
    name: "rewrites assistant metadata flat fields into metadata.usage; drops costUsd",
    input: {
      role: "assistant",
      content: "ok",
      timestamp: "t",
      metadata: {
        inputTokens: 150,
        outputTokens: 80,
        cacheReadTokens: 10,
        costUsd: 0.005,
        model: "claude-sonnet-4-5-20250929",
        llmMs: 300,
      },
    },
    expect: {
      rewroteMessage: true,
      droppedCostUsd: true,
      output: (p) => {
        const meta = p.metadata as Record<string, unknown>;
        expect(meta.usage).toEqual({
          inputTokens: 150,
          outputTokens: 80,
          cacheReadTokens: 10,
        });
        expect(meta.inputTokens).toBeUndefined();
        expect(meta.costUsd).toBeUndefined();
        expect(meta.model).toBe("claude-sonnet-4-5-20250929");
        expect(meta.llmMs).toBe(300);
      },
    },
  },
  {
    name: "drops only costUsd when usage is already nested (no flat fields)",
    input: {
      role: "assistant",
      content: "ok",
      timestamp: "t",
      metadata: {
        usage: { inputTokens: 100, outputTokens: 50 },
        costUsd: 0.003,
        model: "m1",
      },
    },
    expect: {
      rewroteMessage: false,
      droppedCostUsd: true,
      output: (p) => {
        const meta = p.metadata as Record<string, unknown>;
        expect(meta.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
        expect(meta.costUsd).toBeUndefined();
      },
    },
  },
  {
    name: "drops flat fields when both shapes coexist (partial-prior-migration)",
    input: {
      role: "assistant",
      content: "ok",
      timestamp: "t",
      metadata: {
        inputTokens: 999, // stale flat — should be dropped
        outputTokens: 999,
        usage: { inputTokens: 100, outputTokens: 50 }, // canonical — kept
        model: "m1",
      },
    },
    expect: {
      rewroteMessage: true,
      output: (p) => {
        const meta = p.metadata as Record<string, unknown>;
        // Existing nested usage trusted over stale flat fields.
        expect(meta.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
        expect(meta.inputTokens).toBeUndefined();
        expect(meta.outputTokens).toBeUndefined();
      },
    },
  },
  {
    name: "treats metadata.usage === null as not-yet-migrated and rewrites flat fields",
    input: {
      role: "assistant",
      content: "ok",
      timestamp: "t",
      metadata: {
        inputTokens: 40,
        outputTokens: 20,
        usage: null,
        model: "m1",
      },
    },
    expect: {
      rewroteMessage: true,
      output: (p) => {
        const meta = p.metadata as Record<string, unknown>;
        expect(meta.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
        expect(meta.inputTokens).toBeUndefined();
      },
    },
  },
  {
    name: "leaves messages with no migration-relevant fields untouched",
    input: {
      role: "assistant",
      content: "ok",
      timestamp: "t",
      metadata: { model: "m1", skill: "test" },
    },
    expect: { rewroteMessage: false, droppedCostUsd: false },
  },
  {
    name: "leaves user messages alone",
    input: { role: "user", content: "hi", timestamp: "t" },
    expect: { rewroteMessage: false },
  },

  // ---- Edge cases ----
  {
    name: "preserves malformed JSON lines verbatim",
    input: "NOT { VALID JSON",
    expect: { malformed: true },
  },
  {
    name: "ignores non-llm.response, non-message events (run.start, tool.done, etc.)",
    input: { type: "run.start", ts: "t", runId: "r1", model: "m1" },
    expect: { rewroteEvent: false, rewroteMessage: false },
  },
];

describe("migrateLine — documented behavior matrix", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const inputLine = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
      const result = migrateLine(inputLine);

      expect(result.rewroteEvent).toBe(c.expect.rewroteEvent ?? false);
      expect(result.rewroteMessage).toBe(c.expect.rewroteMessage ?? false);
      expect(result.droppedCostUsd).toBe(c.expect.droppedCostUsd ?? false);
      expect(result.malformed).toBe(c.expect.malformed ?? false);

      // Untouched lines (including malformed) must come back byte-identical.
      const expectsNoChange =
        !c.expect.rewroteEvent && !c.expect.rewroteMessage && !c.expect.droppedCostUsd;
      if (expectsNoChange) {
        expect(result.text).toBe(inputLine);
      }

      if (c.expect.output) {
        const parsed = JSON.parse(result.text) as Record<string, unknown>;
        c.expect.output(parsed);
      }
    });
  }

  test("idempotent: re-migrating a previously-migrated line is a no-op", () => {
    const original = JSON.stringify({
      type: "llm.response",
      ts: "t",
      runId: "r1",
      model: "m",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 30,
      llmMs: 200,
    });
    const first = migrateLine(original);
    expect(first.rewroteEvent).toBe(true);

    const second = migrateLine(first.text);
    expect(second.rewroteEvent).toBe(false);
    expect(second.text).toBe(first.text);
  });
});
