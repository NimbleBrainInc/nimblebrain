/**
 * The attribution seam: `origin` and `delegated` are derived from the ambient
 * request context and the emitting event, never from the caller.
 *
 * These assert the two orthogonality properties the label exists for. The one
 * that matters most is `origin: "task", delegated: true` — a sub-agent spawned
 * inside an automation is both, and an enum that collapsed them would file that
 * spend under `delegate` and drop it from the automation total, which is the
 * same shape as the defect the ledger exists to fix.
 */
import { describe, expect, test } from "bun:test";
import { llmCallsTotal, metricsRegistry } from "../../../src/api/metrics.ts";
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
    metricsRegistry.resetMetrics();
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
    metricsRegistry.resetMetrics();
    runWithRequestContext({ identity: null, conversationId: "conv-9" }, () => {
      recordLlmCall({ source: "main", model: "test-model-b", usage: USAGE, event: {} });
    });

    const sample = await callSample({ model: "test-model-b" });
    expect(sample?.labels.origin).toBe("chat");
    expect(sample?.labels.delegated).toBe("false");
  });

  test("a detached fast-slot call records as system rather than being dropped", async () => {
    metricsRegistry.resetMetrics();
    // Compaction and title run outside the request scope `chat()` opens — before
    // it opens and after it closes respectively. `system` is the honest label
    // for Phase 0; Phase 1 must bring them into a scope so the spend attaches
    // to its conversation.
    recordLlmCall({ source: "compaction", model: "test-model-c", usage: USAGE });

    const sample = await callSample({ model: "test-model-c" });
    expect(sample?.labels.origin).toBe("system");
    expect(sample?.labels.delegated).toBe("false");
    expect(sample?.labels.source).toBe("compaction");
  });

  test("token counters carry the same attribution as the call counter", async () => {
    metricsRegistry.resetMetrics();
    runWithRequestContext({ identity: null, unattended: true }, () => {
      recordLlmCall({ source: "main", model: "test-model-d", usage: USAGE });
    });

    const metric = await metricsRegistry.getSingleMetricAsString("nb_llm_tokens_total");
    expect(metric).toContain('origin="task"');
    expect(metric).toContain('delegated="false"');
  });
});
