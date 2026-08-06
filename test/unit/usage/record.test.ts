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
import { describe, expect, test } from "bun:test";
import { llmCallsTotal, llmTokensTotal } from "../../../src/api/metrics.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { isDelegated, originOf, recordLlmCall } from "../../../src/usage/record.ts";
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

  test("unattended is `task` even though the context also carries a conversationId", () => {
    // `executeTask` stamps the run id into `conversationId` for traceability, so
    // a conversation-first test would file every automation call under `chat`.
    // This is the precedence that makes the automation total correct.
    runWithRequestContext({ identity: null, conversationId: "run-1", unattended: true }, () => {
      expect(originOf()).toBe("task");
    });
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
    runWithRequestContext({ identity: null, conversationId: "run-7", unattended: true }, () => {
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
 * `origin` follows the request scope, not the `source`. Compaction is the case
 * where that distinction is observable: the runtime folds history in two
 * places, and only one of them runs inside a scope.
 *
 *   between-turns — `maybeCompactHistory` runs in `chat()` BEFORE the
 *     `runWithRequestContext` that wraps `engine.run`, so there is no scope and
 *     the fold records `system`.
 *   mid-turn — the `rewriteHistory` hook is awaited by `engine.applyHistoryRewrite`
 *     INSIDE `engine.run`, so the scope is live and the fold records `chat`
 *     (or `task`, in an automation).
 *
 * Both attributions are individually honest, and the split is a real property
 * of where the two folds sit rather than a bug in the derivation. It is pinned
 * here so a change to either fold's placement shows up as a failing test rather
 * than as a quietly moved number. Making compaction uniform means opening a
 * scope around the between-turns fold, which is a change to request scoping in
 * `chat()` and belongs in its own PR.
 */
describe("compaction attribution follows the scope, not the source", () => {
  test("the between-turns fold, with no scope open, records system", async () => {
    recordLlmCall({ source: "compaction", model: "test-model-c", usage: USAGE });

    const sample = await callSample({ model: "test-model-c" });
    expect(sample?.labels.source).toBe("compaction");
    expect(sample?.labels.origin).toBe("system");
    expect(sample?.labels.delegated).toBe("false");
  });

  test("the mid-turn fold, inside the engine's scope, records chat", async () => {
    runWithRequestContext({ identity: null, conversationId: "conv-mid" }, () => {
      recordLlmCall({ source: "compaction", model: "test-model-e", usage: USAGE });
    });

    const sample = await callSample({ model: "test-model-e" });
    expect(sample?.labels.source).toBe("compaction");
    expect(sample?.labels.origin).toBe("chat");
  });

  test("the same fold inside an automation records task", async () => {
    runWithRequestContext({ identity: null, conversationId: "run-mid", unattended: true }, () => {
      recordLlmCall({ source: "compaction", model: "test-model-f", usage: USAGE });
    });

    const sample = await callSample({ model: "test-model-f" });
    expect(sample?.labels.origin).toBe("task");
  });
});
