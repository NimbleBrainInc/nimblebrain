/**
 * The attribution seam: `origin` and `delegated` are derived from the ambient
 * request context and the emitting event, never from the caller.
 *
 * These assert the two orthogonality properties the label exists for. The one
 * that matters most is `origin: "task", delegated: true` — a sub-agent spawned
 * inside an automation is both, and an enum that collapsed them would file that
 * spend under `delegate` and drop it from the automation total, which is the
 * same shape as the defect the ledger exists to fix.
 *
 * Every test uses a model name unique to it and reads that series directly, so
 * nothing here resets the process-global registry that the rest of the suite
 * shares (the convention documented in `test/unit/metrics.test.ts`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { llmCallsTotal, llmTokensTotal } from "../../../src/api/metrics.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { UsageLedger } from "../../../src/usage/ledger.ts";
import { usageMonthOf, usageShardPath } from "../../../src/usage/paths.ts";
import {
  clearUsageLedger,
  isDelegated,
  originOf,
  recordLlmCall,
  setUsageLedger,
} from "../../../src/usage/record.ts";
import type { TokenUsage } from "../../../src/usage/types.ts";

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

/** The `nb_llm_calls_total` sample matching every label in `want`, if any. */
async function callSample(want: Record<string, string>) {
  const metric = await llmCallsTotal.get();
  return metric.values.find((v) =>
    Object.entries(want).every(([k, expected]) => v.labels[k] === expected),
  );
}

/** Every `nb_llm_tokens_total` sample for one model. */
async function tokenSamples(model: string) {
  const metric = await llmTokensTotal.get();
  return metric.values.filter((v) => v.labels.model === model);
}

describe("originOf", () => {
  test("no request scope at all is `system`, not a guessed default", () => {
    expect(originOf()).toBe("system");
  });

  test("a conversation in scope is `chat`", () => {
    runWithRequestContext({ identity: null, conversationId: "conv-1" }, () => {
      expect(originOf()).toBe("chat");
    });
  });

  test("unattended is `task`, and a run carries no conversation to confuse it", () => {
    // A run stamps `runId`, not `conversationId` — the two are different
    // questions. `unattended` is still checked first, so the answer does not
    // depend on that: a context that somehow carried both would still be a task.
    runWithRequestContext({ identity: null, runId: "run-1", unattended: true }, () => {
      expect(originOf()).toBe("task");
    });
    runWithRequestContext(
      { identity: null, conversationId: "conv-1", unattended: true },
      () => {
        expect(originOf()).toBe("task");
      },
    );
  });
});

describe("each id in the ledger lands under its own name", () => {
  // `sessionId` used to hold a conversation-or-run union told apart by
  // `origin`. Each fact now has its own field, and `runId` — the engine's, per
  // turn — is the one the union could not express at all.
  function fieldsFor(
    ctx: Parameters<typeof runWithRequestContext>[0],
    event?: Record<string, unknown>,
  ): Record<string, unknown> {
    const dir = mkdtempSync(join(tmpdir(), "nb-session-"));
    const month = usageMonthOf(new Date().toISOString());
    const ledger = new UsageLedger(dir, "inst", { retentionMonths: 0 });
    setUsageLedger(ledger);
    try {
      runWithRequestContext(ctx, () => {
        recordLlmCall({
          source: "main",
          model: "test-model-session",
          usage: USAGE,
          ...(event ? { event } : {}),
        });
      });
    } finally {
      clearUsageLedger(ledger);
    }
    const path = usageShardPath(dir, month, "inst");
    const line = readFileSync(path, "utf-8").split("\n").filter(Boolean)[0]!;
    return JSON.parse(line) as Record<string, unknown>;
  }

  test("a chat's conversation id lands in conversationId", () => {
    const rec = fieldsFor({ identity: null, conversationId: "conv-42" });
    expect(rec.conversationId).toBe("conv-42");
    expect(rec.taskRunId).toBeUndefined();
  });

  test("an automation's run id lands in taskRunId, not conversationId", () => {
    // The original defect one layer up: a run id occupying a conversation
    // field. It must not reappear as a conversation under a new name.
    const rec = fieldsFor({ identity: null, runId: "run-42", unattended: true });
    expect(rec.taskRunId).toBe("run-42");
    expect(rec.conversationId).toBeUndefined();
  });

  test("the engine's run id lands in runId — the per-turn grain", () => {
    // Read off the emitting event, where it already was; `parentRunId` beside
    // it has the same referent, which is what makes the delegation tree join.
    const rec = fieldsFor({ identity: null, conversationId: "conv-42" }, { runId: "engine-run-7" });
    expect(rec.runId).toBe("engine-run-7");
    expect(rec.conversationId).toBe("conv-42");
  });

  test("a chat and its turn are recorded together, not as one id", () => {
    const rec = fieldsFor({ identity: null, conversationId: "conv-42" }, { runId: "engine-run-7" });
    expect([rec.conversationId, rec.runId]).toEqual(["conv-42", "engine-run-7"]);
  });

  test("a forked fast-slot call has no turn of its own", () => {
    // Title/compaction/briefing emit no event, so there is no engine run to
    // attribute them to — they belong to the scope they ran in.
    const rec = fieldsFor({ identity: null, conversationId: "conv-42" });
    expect(rec.runId).toBeUndefined();
  });

  test("sessionId is no longer written", () => {
    expect(fieldsFor({ identity: null, conversationId: "conv-42" }).sessionId).toBeUndefined();
    expect(
      fieldsFor({ identity: null, runId: "run-42", unattended: true }).sessionId,
    ).toBeUndefined();
  });

  test("nothing in scope leaves all three unset", () => {
    const rec = fieldsFor({ identity: null });
    expect(rec.conversationId).toBeUndefined();
    expect(rec.taskRunId).toBeUndefined();
    expect(rec.runId).toBeUndefined();
  });
});

describe("isDelegated", () => {
  test("a parentRunId on the event means delegated", () => {
    expect(isDelegated({ parentRunId: "run-1" })).toBe(true);
  });

  test("no event and no parentRunId mean not delegated", () => {
    expect(isDelegated(undefined)).toBe(false);
    expect(isDelegated({})).toBe(false);
  });

  test("an empty parentRunId is not delegation", () => {
    // `DelegateTracker.currentRunId` initializes to "", so a null check alone
    // would label a child that ran before any top-level run.start.
    expect(isDelegated({ parentRunId: "" })).toBe(false);
  });
});

describe("recordLlmCall", () => {
  test("a delegated call inside an automation is task + delegated, not one or the other", async () => {
    runWithRequestContext({ identity: null, runId: "run-7", unattended: true }, () => {
      recordLlmCall({
        source: "main",
        model: "test-model-a",
        usage: USAGE,
        event: { parentRunId: "run-7" },
      });
    });

    const sample = await callSample({ model: "test-model-a" });
    expect(sample?.labels.origin).toBe("task");
    expect(sample?.labels.delegated).toBe("true");
    // The point of the split: this call is still recoverable as automation
    // spend. Under a collapsed enum it would read `delegate` and vanish from
    // the automation total.
    expect(sample?.labels.source).toBe("main");
  });

  test("an interactive turn is chat + not delegated", async () => {
    runWithRequestContext({ identity: null, conversationId: "conv-9" }, () => {
      recordLlmCall({ source: "main", model: "test-model-b", usage: USAGE, event: {} });
    });

    const sample = await callSample({ model: "test-model-b" });
    expect(sample?.labels.origin).toBe("chat");
    expect(sample?.labels.delegated).toBe("false");
  });

  test("token counters carry the same attribution as the call counter", async () => {
    runWithRequestContext({ identity: null, unattended: true }, () => {
      recordLlmCall({ source: "main", model: "test-model-d", usage: USAGE });
    });

    const samples = await tokenSamples("test-model-d");
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.labels.origin).toBe("task");
      expect(s.labels.delegated).toBe("false");
    }
  });
});

/**
 * `origin` follows the request scope, not the `source`. The forked fast-slot
 * calls are where that distinction bites: a compaction summary and an auto-title
 * are chat spend, but they run outside the wrap around `engine.run` — the fold
 * before it opens, the title after the turn returns — so they carry the
 * conversation only because `chat()` opens the turn's own scope around them.
 *
 * These tests pin the *derivation*: that `originOf()` answers by scope, whatever
 * the `source`. They call `recordLlmCall` inside a hand-built scope and reach
 * neither `runtime.ts` nor `engine.ts`, so they cannot detect a call escaping
 * the real scope. That is pinned end-to-end instead, by
 * `test/integration/compaction-wiring.test.ts` (both folds and the title) and
 * `mid-turn-compaction-wiring.test.ts`, which drive real turns and read
 * `/metrics`.
 */
describe("origin follows the scope, whatever the source", () => {
  test("a fast-slot call inside a conversation's scope records chat", async () => {
    runWithRequestContext({ identity: null, conversationId: "conv-mid" }, () => {
      recordLlmCall({ source: "compaction", model: "test-model-e", usage: USAGE });
    });

    const sample = await callSample({ model: "test-model-e" });
    expect(sample?.labels.source).toBe("compaction");
    expect(sample?.labels.origin).toBe("chat");
  });

  test("the same call inside an automation records task", async () => {
    runWithRequestContext({ identity: null, runId: "run-mid", unattended: true }, () => {
      recordLlmCall({ source: "compaction", model: "test-model-f", usage: USAGE });
    });

    const sample = await callSample({ model: "test-model-f" });
    expect(sample?.labels.origin).toBe("task");
  });

  test("with no scope at all it records system — still reachable, via the background briefing", async () => {
    // `scheduleBriefingRefresh` runs its own context of `{identity, workspaceId}`
    // with no `conversationId`, so `system` is a live value, not dead code.
    recordLlmCall({ source: "briefing", model: "test-model-c", usage: USAGE });

    const sample = await callSample({ model: "test-model-c" });
    expect(sample?.labels.origin).toBe("system");
    expect(sample?.labels.delegated).toBe("false");
  });
});

/**
 * The process ledger is one module-level handle and a process can hold two
 * runtimes, so releasing it has to be ownership-checked. An unconditional
 * release is how the runtime that shuts down first silently disables the other
 * one's writes: `recordLlmCall` falls through to the Prometheus half and leaves
 * no durable line — an undercount of exactly the kind the ledger exists to
 * remove, and one nothing would report.
 */
describe("ledger ownership", () => {
  test("releasing a replaced ledger leaves the installed one recording", () => {
    const dirA = mkdtempSync(join(tmpdir(), "nb-own-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "nb-own-b-"));
    const month = usageMonthOf(new Date().toISOString());
    const a = new UsageLedger(dirA, "inst-a", { retentionMonths: 0 });
    const b = new UsageLedger(dirB, "inst-b", { retentionMonths: 0 });

    setUsageLedger(a);
    setUsageLedger(b); // a second runtime starts and takes the global
    clearUsageLedger(a); // the first one shuts down

    recordLlmCall({ source: "main", model: "test-model-own-1", usage: USAGE });
    expect(existsSync(usageShardPath(dirB, month, "inst-b"))).toBe(true);
    expect(existsSync(usageShardPath(dirA, month, "inst-a"))).toBe(false);

    clearUsageLedger(b); // now the owner releases it
    recordLlmCall({ source: "main", model: "test-model-own-2", usage: USAGE });
    const lines = readFileSync(usageShardPath(dirB, month, "inst-b"), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});
