import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createDirectExecutor,
  type ExecutorContext,
  type TaskFn,
  type TaskFnResult,
  type TaskFnToolCall,
} from "../../../../src/platform/automations/executor.ts";
import type { Automation, AutomationRun } from "../../../../src/platform/automations/types.ts";
import { fakeFetch } from "../../../helpers/fake-fetch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "daily-summary",
    name: "Daily Summary",
    prompt: "Summarize today's activity",
    schedule: { type: "cron", expression: "0 9 * * *" },
    enabled: true,
    source: "user",
    createdAt: "2025-06-01T00:00:00.000Z",
    updatedAt: "2025-06-01T00:00:00.000Z",
    runCount: 3,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
}

function chatResponse(overrides: Record<string, unknown> = {}) {
  return {
    response: "Here is your summary.",
    conversationId: "conv_abc123",
    skillName: null,
    toolCalls: [
      { id: "tc1", name: "nb__briefing", input: {}, output: "ok", ok: true, ms: 100 },
      { id: "tc2", name: "nb__workspace_info", input: {}, output: "ok", ok: true, ms: 50 },
    ],
    inputTokens: 1200,
    outputTokens: 350,
    stopReason: "complete",
    usage: {
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadTokens: 0,
      costUsd: 0.01,
      model: "claude-sonnet-4-5-20250929",
      llmMs: 2500,
      iterations: 3,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  process.env.NB_HOST_URL = "http://test-host:3000";
  mockFetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(chatResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = fakeFetch(mockFetch);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NB_HOST_URL;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createDirectExecutor — context resolution
// ---------------------------------------------------------------------------

function makeDirectTaskFn(): TaskFn {
  return async (req): Promise<TaskFnResult> => ({
    output: `echo: ${req.prompt}`,
    runId: "run_test000000",
    toolCalls: [],
    stopReason: "complete",
    usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
  });
}

describe("createDirectExecutor", () => {
  test("passes the automation object to getContext callback", async () => {
    let receivedAutomation: Automation | undefined;

    const getContext = (auto?: Automation): ExecutorContext => {
      receivedAutomation = auto;
      return { workspaceId: "ws_test", identity: { id: "usr_owner" } };
    };

    const executor = createDirectExecutor(makeDirectTaskFn(), getContext);
    const automation = makeAutomation({
      ownerId: "usr_owner",
      workspaceId: "ws_test",
    });

    await executor(automation);

    expect(receivedAutomation).toBeDefined();
    expect(receivedAutomation!.id).toBe("daily-summary");
    expect(receivedAutomation!.ownerId).toBe("usr_owner");
    expect(receivedAutomation!.workspaceId).toBe("ws_test");
  });

  test("forwards workspaceId and identity from context to task request", async () => {
    let capturedWsId: string | undefined;
    let capturedIdentity: { id: string } | undefined;

    const taskFn: TaskFn = async (req) => {
      capturedWsId = req.workspaceId;
      capturedIdentity = req.identity;
      return {
        output: "ok",
        runId: "run_test000000",
        toolCalls: [],
        stopReason: "complete",
        usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
      };
    };

    const getContext = (): ExecutorContext => ({
      workspaceId: "ws_eng",
      identity: { id: "usr_alice" },
    });

    const executor = createDirectExecutor(taskFn, getContext);
    await executor(makeAutomation());

    expect(capturedWsId).toBe("ws_eng");
    expect(capturedIdentity?.id).toBe("usr_alice");
  });

  test("omits workspaceId and identity when context is empty", async () => {
    let capturedRequest: Record<string, unknown> | undefined;

    const taskFn: TaskFn = async (req) => {
      capturedRequest = req as unknown as Record<string, unknown>;
      return {
        output: "ok",
        runId: "run_test000000",
        toolCalls: [],
        stopReason: "complete",
        usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
      };
    };

    const getContext = (): ExecutorContext => ({});

    const executor = createDirectExecutor(taskFn, getContext);
    await executor(makeAutomation());

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.workspaceId).toBeUndefined();
    expect(capturedRequest!.identity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stopReason → AutomationRun.status mapping (the LIVE scheduled path:
// createDirectExecutor → mapResultToRun → mapStopReasonToStatus). Run status
// drives backoff — if a fail-closed branch silently regressed to "success", a
// perpetually-failing automation would never back off and would hammer the LLM
// every tick. The mapping isn't exported, so exercise it via the executor.
// (Restores coverage lost when the executeHttp tests were deleted.)
// ---------------------------------------------------------------------------

describe("createDirectExecutor — the run input cap", () => {
  async function requestFor(overrides: Partial<Automation>) {
    let seen: Parameters<TaskFn>[0] | undefined;
    const taskFn: TaskFn = async (req) => {
      seen = req;
      return makeDirectTaskFn()(req);
    };
    await createDirectExecutor(taskFn, () => ({}))(makeAutomation(overrides));
    return seen;
  }

  test("an automation's maxInputTokens reaches the runtime as the run's total cap", async () => {
    const req = await requestFor({ maxInputTokens: 150_000 });
    expect(req?.maxRunInputTokens).toBe(150_000);
  });

  test("an automation without maxInputTokens sends no cap", async () => {
    const req = await requestFor({});
    expect(req?.maxRunInputTokens).toBeUndefined();
  });
});

describe("createDirectExecutor — stopReason → status", () => {
  function taskFnWithStop(stopReason: string): TaskFn {
    return async (): Promise<TaskFnResult> => ({
      output: "done",
      runId: "run_test000000",
      toolCalls: [],
      stopReason,
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
    });
  }

  async function statusFor(stopReason: string): Promise<string> {
    const executor = createDirectExecutor(taskFnWithStop(stopReason), () => ({}));
    const { run } = await executor(makeAutomation());
    return run.status;
  }

  test("complete → success", async () => {
    expect(await statusFor("complete")).toBe("success");
  });

  test("max_iterations → timeout", async () => {
    expect(await statusFor("max_iterations")).toBe("timeout");
  });

  test("max_input_tokens → failure, naming the cap", async () => {
    const executor = createDirectExecutor(taskFnWithStop("max_input_tokens"), () => ({}));
    const { run, result } = await executor(makeAutomation({ maxInputTokens: 200_000 }));
    expect(run.status).toBe("failure");
    expect(run.stopReason).toBe("max_input_tokens");
    expect(result?.stopReason).toBe("max_input_tokens");
    expect(run.error).toContain("input-token cap");
    expect(run.error).toContain("200,000");
  });

  test("length → failure (fail-closed default)", async () => {
    expect(await statusFor("length")).toBe("failure");
  });

  test("content_filter → failure (fail-closed default)", async () => {
    expect(await statusFor("content_filter")).toBe("failure");
  });

  test("unrecognized stopReason → failure (fail-closed default)", async () => {
    expect(await statusFor("some_future_reason")).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// stopReason "other" is shared by several provider outcomes, so a failed run
// carries the model call's raw stop reason in `error`.
// ---------------------------------------------------------------------------

describe("createDirectExecutor — stopReason other names the raw stop reason", () => {
  function taskFnWith(result: Partial<TaskFnResult>): TaskFn {
    return async (): Promise<TaskFnResult> => ({
      output: "done",
      runId: "run_test000000",
      toolCalls: [],
      stopReason: "other",
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
      ...result,
    });
  }

  test("sets error naming the provider stop reason", async () => {
    const executor = createDirectExecutor(
      taskFnWith({ finishReasonRaw: "compaction" }),
      () => ({}),
    );
    const { run } = await executor(makeAutomation());
    expect(run.status).toBe("failure");
    expect(run.stopReason).toBe("other");
    expect(run.error).toBe(
      "Model turn ended without a recognized stop (provider stop reason: compaction).",
    );
  });

  test("says so when the provider reported no stop reason", async () => {
    const executor = createDirectExecutor(taskFnWith({}), () => ({}));
    const { run } = await executor(makeAutomation());
    expect(run.error).toBe(
      "Model turn ended without a recognized stop (provider stop reason: not reported).",
    );
  });

  test("names a declared tool call that could not be read", async () => {
    const executor = createDirectExecutor(
      taskFnWith({ finishReason: "tool-calls", finishReasonRaw: "tool_use" }),
      () => ({}),
    );
    const { run } = await executor(makeAutomation());
    expect(run.status).toBe("failure");
    expect(run.error).toBe(
      "Model ended its turn to call a tool, but no tool call could be read from the response (provider stop reason: tool_use).",
    );
  });

  test("leaves other stop reasons' error unset", async () => {
    const executor = createDirectExecutor(
      taskFnWith({ stopReason: "length", finishReasonRaw: "max_tokens" }),
      () => ({}),
    );
    const { run } = await executor(makeAutomation());
    expect(run.status).toBe("failure");
    expect(run.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connector-unreachable de-masking. A run can end `complete` (→ would-be
// `success`) while a tool call hit a connector that couldn't be routed — the
// agent "completes" by writing around the gap. That is the silent failure
// operators reported (a standup summary that never reached Teams, recorded as
// success). mapResultToRun downgrades such runs to `failure` and names the
// tool, keyed on the orchestrator routing reason carried per tool call
// (`errorReason`), NOT on a generic `ok: false` (which would flag healthy
// runs where the agent probed and self-corrected).
// ---------------------------------------------------------------------------

describe("createDirectExecutor — connector-unreachable de-masking", () => {
  function taskFnWithToolCalls(toolCalls: TaskFnToolCall[]): TaskFn {
    return async (): Promise<TaskFnResult> => ({
      output: "I documented the gap in the deliverable.",
      runId: "run_test000000",
      toolCalls,
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
    });
  }

  async function runWith(toolCalls: TaskFnToolCall[]): Promise<AutomationRun> {
    const executor = createDirectExecutor(taskFnWithToolCalls(toolCalls), () => ({}));
    const { run } = await executor(makeAutomation());
    return run;
  }

  test("complete + unknown_tool_source → failure naming the tool", async () => {
    const run = await runWith([
      { id: "t1", name: "nb__search", input: {}, output: "ok", ok: true, ms: 20 },
      {
        id: "t2",
        name: "ws_x-teams__send_message",
        input: {},
        output: "[orchestrator] no source …",
        ok: false,
        ms: 15,
        errorReason: "unknown_tool_source",
      },
    ]);
    expect(run.status).toBe("failure");
    expect(run.error).toMatch(/Connector unavailable/);
    expect(run.error).toMatch(/ws_x-teams__send_message/);
  });

  test("complete + workspace_access_denied → failure", async () => {
    const run = await runWith([
      {
        id: "t1",
        name: "ws_other-teams__send_message",
        input: {},
        output: "[orchestrator] not a member …",
        ok: false,
        ms: 12,
        errorReason: "workspace_access_denied",
      },
    ]);
    expect(run.status).toBe("failure");
    expect(run.error).toMatch(/Connector unavailable/);
  });

  test("complete + reauth_required (installed connector, auth expired) → failure", async () => {
    // reauth_required is emitted by the connector auth-loss path
    // (McpSource.execute), proven to flow onto errorReason by the engine test
    // in engine.test.ts. Here: a run that attempted such a connector and got
    // the reauth result must not be a green success.
    const run = await runWith([
      {
        id: "t1",
        name: "ws_founders-teams__send_message",
        input: {},
        output: "teams needs to be reconnected — its authorization has expired",
        ok: false,
        ms: 14,
        errorReason: "reauth_required",
      },
    ]);
    expect(run.status).toBe("failure");
    expect(run.error).toMatch(/Connector unavailable/);
  });

  test("complete + all tool calls ok → success (no false downgrade)", async () => {
    const run = await runWith([
      { id: "t1", name: "nb__briefing", input: {}, output: "ok", ok: true, ms: 20 },
      { id: "t2", name: "synapse-crm__list", input: {}, output: "ok", ok: true, ms: 30 },
    ]);
    expect(run.status).toBe("success");
    expect(run.error).toBeUndefined();
  });

  test("complete + a non-routing tool error → degraded, not failure", async () => {
    // `invalid_tool_name` is deliberately NOT in the unreachable set: it's
    // usually the agent probing a wrong name and recovering, not a real
    // connector gap, so it counts for nothing. A logical tool error with no
    // errorReason is not a connector gap either, so the run is not failed;
    // the create was never retried, so it is degraded.
    const run = await runWith([
      {
        id: "t1",
        name: "nb__search",
        input: {},
        output: "bad name",
        ok: false,
        ms: 10,
        errorReason: "invalid_tool_name",
      },
      {
        id: "t2",
        name: "synapse-crm__create",
        input: {},
        output: "validation error",
        ok: false,
        ms: 10,
      },
    ]);
    expect(run.status).toBe("degraded");
    expect(run.error).toMatch(/synapse-crm__create ×1/);
    expect(run.error).not.toMatch(/nb__search/);
  });
});

// ---------------------------------------------------------------------------
// Aborted-run telemetry — the timeout/cancel path now RETURNS a result (not a
// throw) carrying the partial usage accumulated before the abort. Regression
// for the 0/0/0/0 "timeout" records: a run that did real work (even sent its
// email) before the wall clock killed it must report its real counters +
// conversationId, not zeros — otherwise cost monitoring and budget auto-disable
// are blind. runtime.executeTask honors its contract by returning
// `stopReason: "aborted"`; the executor classifies timeout-vs-cancel from its
// own cancellation flags.
// ---------------------------------------------------------------------------

describe("createDirectExecutor — abandoned-tool de-masking", () => {
  /** One tool call; `ok` decides success. Carries no errorReason, so the
   *  connector-unreachable path never fires and this exercises the general one. */
  function tc(name: string, ok: boolean, id = `t${Math.random()}`) {
    return { id, name, input: {}, output: ok ? "{}" : "validation error", ok, ms: 10 };
  }

  async function runWith(toolCalls: TaskFnToolCall[]): Promise<AutomationRun> {
    const taskFn: TaskFn = async (): Promise<TaskFnResult> => ({
      output: "Here is the summary. Some items could not be recorded.",
      runId: "run_test000000",
      toolCalls,
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
    });
    const executor = createDirectExecutor(taskFn, () => ({}));
    const { run } = await executor(makeAutomation());
    return run;
  }

  test("a tool that failed every one of its many calls → failure naming it", async () => {
    const run = await runWith([
      tc("nb__search", true),
      ...Array.from({ length: 14 }, () => tc("people__log_interaction", false)),
    ]);
    expect(run.status).toBe("failure");
    expect(run.error).toMatch(/never succeeded/);
    expect(run.error).toMatch(/people__log_interaction/);
  });

  test("a tool that failed then recovered stays success", async () => {
    // The healthy shape this must not flag: three rejected argument shapes,
    // then a correct one. The work happened.
    const run = await runWith([
      tc("granola__list_meetings", false),
      tc("granola__list_meetings", false),
      tc("granola__list_meetings", false),
      tc("granola__list_meetings", true),
    ]);
    expect(run.status).toBe("success");
    expect(run.error).toBeUndefined();
  });

  test("a couple of failures below the threshold are degraded, not failed", async () => {
    // Two all-failing calls is not yet evidence of abandonment, so the run is
    // not a failure. It is still work that did not happen.
    const run = await runWith([tc("people__search", false), tc("people__search", false)]);
    expect(run.status).toBe("degraded");
  });

  test("all-succeeding calls stay success", async () => {
    const run = await runWith([tc("a", true), tc("a", true), tc("a", true), tc("b", true)]);
    expect(run.status).toBe("success");
    expect(run.error).toBeUndefined();
  });

  test("names every abandoned tool, and only those", async () => {
    const run = await runWith([
      ...Array.from({ length: 3 }, () => tc("alpha", false)),
      ...Array.from({ length: 3 }, () => tc("beta", false)),
      ...Array.from({ length: 3 }, () => tc("gamma", true)),
    ]);
    expect(run.error).toMatch(/alpha/);
    expect(run.error).toMatch(/beta/);
    expect(run.error).not.toMatch(/gamma/);
  });

  test("connector-unreachable wins the message when both hold", async () => {
    // The routing diagnosis is the more specific one, so it must not be
    // displaced by the general "never succeeded" wording.
    const run = await runWith([
      {
        id: "t1",
        name: "ws_x-teams__send_message",
        input: {},
        output: "[orchestrator] no source …",
        ok: false,
        ms: 15,
        errorReason: "unknown_tool_source",
      },
      ...Array.from({ length: 3 }, () => tc("people__log_interaction", false)),
    ]);
    expect(run.status).toBe("failure");
    expect(run.error).toMatch(/Connector unavailable/);
  });

  test("does not override an already-failing status", async () => {
    const taskFn: TaskFn = async (): Promise<TaskFnResult> => ({
      output: "",
      runId: "run_test000000",
      toolCalls: Array.from({ length: 3 }, () => tc("people__log_interaction", false)),
      stopReason: "max_iterations",
      usage: { inputTokens: 10, outputTokens: 5, iterations: 25 },
    });
    const executor = createDirectExecutor(taskFn, () => ({}));
    const { run } = await executor(makeAutomation());
    expect(run.status).toBe("timeout");
  });
});

describe("createDirectExecutor — degraded runs", () => {
  function call(name: string, input: unknown, ok: boolean, extra: Record<string, unknown> = {}) {
    return {
      id: `t${Math.random()}`,
      name,
      input,
      output: ok ? "{}" : "404",
      ok,
      ms: 10,
      ...extra,
    };
  }

  async function runWith(toolCalls: TaskFnToolCall[]): Promise<AutomationRun> {
    const taskFn: TaskFn = async (): Promise<TaskFnResult> => ({
      output: "All records created.",
      runId: "run_test000000",
      toolCalls,
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
    });
    const executor = createDirectExecutor(taskFn, () => ({}));
    const { run } = await executor(makeAutomation());
    return run;
  }

  test("a single failed send is degraded and names the tool", async () => {
    const run = await runWith([
      call("outlook__list_messages", {}, true),
      call("outlook__send_mail", { to: "a@example.com" }, false),
    ]);
    expect(run.status).toBe("degraded");
    expect(run.error).toMatch(/outlook__send_mail ×1/);
    expect(run.error).not.toMatch(/list_messages/);
  });

  test("a failed write among successful writes is degraded, whatever the final answer says", async () => {
    const run = await runWith([
      call("records__create", { id: "a" }, true),
      call("records__create", { id: "b" }, false),
      call("records__create", { id: "c" }, true),
      call("records__create", { id: "d" }, false),
      call("records__create", { id: "e" }, true),
    ]);
    expect(run.status).toBe("degraded");
    expect(run.error).toMatch(/2 tool call\(s\)/);
    expect(run.error).toMatch(/records__create ×2/);
  });

  test("a failed write retried to success on the same input stays success", async () => {
    const run = await runWith([
      call("records__create", { id: "a" }, true),
      call("records__create", { id: "b", n: 1 }, false),
      call("records__create", { id: "c" }, true),
      // Same input, keys in another order: the same job.
      call("records__create", { n: 1, id: "b" }, true),
    ]);
    expect(run.status).toBe("success");
    expect(run.error).toBeUndefined();
  });

  test("rejected arguments corrected on a one-job tool stay success", async () => {
    const run = await runWith([
      call("granola__list_meetings", { since: "yesterday" }, false),
      call("granola__list_meetings", { since: "last week" }, false),
      call("granola__list_meetings", { since: "2026-09-25" }, true),
    ]);
    expect(run.status).toBe("success");
  });

  test("rejected arguments corrected on a many-job tool stay success", async () => {
    const run = await runWith([
      call("records__create", { id: "a" }, true),
      call("records__create", { record_id: "b" }, false),
      call("records__create", { id: "b" }, true),
      call("records__create", { id: "c" }, true),
    ]);
    expect(run.status).toBe("success");
  });

  test("a failed write is not resolved by a later success of the same shape on another item", async () => {
    const run = await runWith([
      call("records__create", { id: "a", note: "x" }, false),
      call("records__create", { id: "b", note: "y" }, true),
      call("records__create", { id: "c", note: "z" }, true),
    ]);
    expect(run.status).toBe("degraded");
    expect(run.error).toMatch(/records__create ×1/);
  });

  test("a failure after a one-job tool's only success is degraded", async () => {
    // The success came first, so it cannot have been the retry of the failure.
    const run = await runWith([
      call("crm__update", { id: "a" }, true),
      call("crm__update", { id: "b" }, false),
    ]);
    expect(run.status).toBe("degraded");
  });

  test("a misnamed tool the agent corrected is not counted", async () => {
    const run = await runWith([
      call("people_search", {}, false, { errorReason: "invalid_tool_name" }),
      call("people__search", {}, true),
    ]);
    expect(run.status).toBe("success");
  });

  test("the stronger failure signals still win", async () => {
    const run = await runWith([
      ...Array.from({ length: 3 }, () => call("people__log_interaction", {}, false)),
      call("outlook__send_mail", {}, false),
    ]);
    expect(run.status).toBe("failure");
    expect(run.error).toMatch(/never succeeded/);
  });
});

describe("createDirectExecutor — aborted run preserves partial usage", () => {
  // Mirrors runtime.executeTask under signal-driven abort: wait for the
  // abort, then RETURN the work done so far tagged "aborted" instead of
  // throwing it away.
  function abortingTaskFn(): TaskFn {
    return async (req): Promise<TaskFnResult> => {
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        output: "",
        runId: "run_partial0001",
        toolCalls: [
          { id: "t1", name: "gmail__send_message", input: {}, output: "sent", ok: true, ms: 80 },
        ],
        stopReason: "aborted",
        usage: { inputTokens: 4096, outputTokens: 512, iterations: 4 },
      };
    };
  }

  test("wall-clock timeout records status=timeout with the real counters and runId; result is non-null", async () => {
    const executor = createDirectExecutor(abortingTaskFn(), () => ({ workspaceId: "ws_test" }));
    const { run, result } = await executor(makeAutomation({ maxRunDurationMs: 30 }));

    expect(run.status).toBe("timeout");
    expect(run.inputTokens).toBe(4096);
    expect(run.outputTokens).toBe(512);
    expect(run.iterations).toBe(4);
    expect(run.toolCalls).toBe(1);
    // The run adopts the runtime's runId verbatim.
    expect(run.id).toBe("run_partial0001");
    expect(run.error).toMatch(/timed out after/);
    // "aborted" is not a valid persisted stopReason — normalized to "other".
    expect(run.stopReason).toBe("other");
    // The aborted-partial path still builds a result sidecar from the partial data.
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("run_partial0001");
    expect(result!.usage.iterations).toBe(4);
    expect(result!.stopReason).toBe("other");
  });

  test("external cancel records status=cancelled with the real counters", async () => {
    // Already-aborted external signal → executor sets externallyAborted and
    // aborts the run controller immediately; the timer never fires.
    const externalSignal = AbortSignal.abort();
    const executor = createDirectExecutor(abortingTaskFn(), () => ({ workspaceId: "ws_test" }));
    const { run, result } = await executor(
      makeAutomation({ maxRunDurationMs: 600_000 }),
      externalSignal,
    );

    expect(run.status).toBe("cancelled");
    expect(run.inputTokens).toBe(4096);
    expect(run.outputTokens).toBe(512);
    expect(run.iterations).toBe(4);
    expect(run.id).toBe("run_partial0001");
    expect(run.error).toBe("Cancelled by user");
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("run_partial0001");
  });
});

// ---------------------------------------------------------------------------
// Recursive-call guard at the executor
// ---------------------------------------------------------------------------
//
// The create and update tools refuse a recursive `allowedTools`, but operator
// file edits and connector-contributed schedules can still set one. The guard
// also lives at the executor — closest to the actual run — so it sees the
// merged Automation regardless of how the field got there.

describe("createDirectExecutor — recursive-call guard", () => {
  test("refuses to run when allowedTools includes automations__create", async () => {
    const executor = createDirectExecutor(makeDirectTaskFn(), () => ({
      workspaceId: "ws_test",
      identity: { id: "u" },
    }));
    const automation = makeAutomation({
      allowedTools: ["files__*", "automations__create"],
    });

    await expect(executor(automation)).rejects.toThrow(/allowedTools/);
  });

  test("refuses to run when allowedTools includes automations__update", async () => {
    const executor = createDirectExecutor(makeDirectTaskFn(), () => ({
      workspaceId: "ws_test",
      identity: { id: "u" },
    }));
    const automation = makeAutomation({
      allowedTools: ["automations__update"],
    });

    await expect(executor(automation)).rejects.toThrow(/allowedTools/);
  });

  test("sends allowedTools to the run, and none for an empty list", async () => {
    const seen: Array<string[] | undefined> = [];
    const taskFn: TaskFn = async (req) => {
      seen.push(req.allowedTools);
      return makeDirectTaskFn()(req);
    };
    const executor = createDirectExecutor(taskFn, () => ({
      workspaceId: "ws_test",
      identity: { id: "u" },
    }));

    await executor(makeAutomation({ allowedTools: ["crm__*"] }));
    await executor(makeAutomation({ allowedTools: [] }));

    expect(seen).toEqual([["crm__*"], undefined]);
  });

  test("permits non-recursive allowedTools", async () => {
    const executor = createDirectExecutor(makeDirectTaskFn(), () => ({
      workspaceId: "ws_test",
      identity: { id: "u" },
    }));
    const automation = makeAutomation({
      allowedTools: ["files__*", "skills__list", "conversations__search"],
    });

    const { run } = await executor(automation);
    expect(run.status).toBe("success");
  });

  test("forwards a combined signal into taskFn so timeouts cancel in-flight task work", async () => {
    // Regression: the old Promise.race pattern rejected at the timeout
    // but didn't propagate cancellation to the task fn. The task kept
    // running, finished cleanly minutes later, and the result was
    // silently discarded. Now the taskFn receives a signal that
    // aborts on the same timeout — so it can cooperatively stop.
    let receivedSignal: AbortSignal | undefined;
    let signalFiredDuringTask = false;

    const slowTaskFn: TaskFn = async (req) => {
      receivedSignal = req.signal;
      // Wait up to 500ms but bail on abort so the test runs fast.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        req.signal?.addEventListener(
          "abort",
          () => {
            signalFiredDuringTask = true;
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      // On abort the task throws — matches engine.run behavior under
      // signal-driven cancellation.
      if (req.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return {
        output: "ok",
        runId: "run_test000000",
        toolCalls: [],
        stopReason: "complete",
        usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
      };
    };

    const executor = createDirectExecutor(slowTaskFn, () => ({
      workspaceId: "ws_test",
    }));
    const automation = makeAutomation({ maxRunDurationMs: 50 });

    await expect(executor(automation)).rejects.toThrow(/timed out after/);
    expect(receivedSignal).toBeDefined();
    expect(signalFiredDuringTask).toBe(true);
  });

  test("external cancel propagates into taskFn signal as AbortError", async () => {
    // Symmetric to the timeout case: when the scheduler aborts the
    // run controller (manual cancel, scheduler.stop()), the taskFn's
    // signal must also fire so the in-flight engine work cancels.
    let taskSawAbort = false;
    const slowTaskFn: TaskFn = async (req) => {
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener(
          "abort",
          () => {
            taskSawAbort = true;
            resolve();
          },
          { once: true },
        );
        setTimeout(resolve, 5000);
      });
      throw new DOMException("The operation was aborted.", "AbortError");
    };

    const executor = createDirectExecutor(slowTaskFn, () => ({ workspaceId: "ws_test" }));
    const externalController = new AbortController();
    const automation = makeAutomation({ maxRunDurationMs: 10_000 });

    const runPromise = executor(automation, externalController.signal);
    // Give the task a tick to start, then cancel.
    await new Promise((r) => setTimeout(r, 10));
    externalController.abort();

    await expect(runPromise).rejects.toThrow();
    expect(taskSawAbort).toBe(true);
  });

  test("external-cancel wins the race when timeout fires concurrently — no false 'timeout' status", async () => {
    // Race regression: external abort + timeout firing in the same
    // tick. Without the `externallyAborted` flag, `timedOut` flips
    // true under both paths and the catch rewrites the error to
    // "timed out after Ns" — so the scheduler stamps `status:
    // "timeout"` on what was really a cancel. Narrow window, but
    // the whole point of the PR is honest status records.
    const taskFn: TaskFn = async (req) => {
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5000);
      });
      throw new DOMException("The operation was aborted.", "AbortError");
    };

    const executor = createDirectExecutor(taskFn, () => ({ workspaceId: "ws_test" }));
    const externalController = new AbortController();
    // Make the timeout extremely tight so it fires very close to the
    // external cancel — exercises the race the flag is meant to
    // disambiguate.
    const automation = makeAutomation({ maxRunDurationMs: 5 });

    const runPromise = executor(automation, externalController.signal);
    // Cancel externally in the same tick — both abort sources fire
    // near-simultaneously.
    externalController.abort();

    // External cancel must dominate: the error must NOT be the
    // timeout-shape that `Scheduler.dispatchRun` keys off via
    // `errorMsg.includes("timed out")`.
    let caughtMessage = "";
    try {
      await runPromise;
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : String(e);
    }
    expect(caughtMessage).not.toMatch(/timed out after/);
  });
});

// ---------------------------------------------------------------------------
// createDirectExecutor — per-run input
// ---------------------------------------------------------------------------

describe("createDirectExecutor — an event run's input", () => {
  function capturing(): { taskFn: TaskFn; seen: { prompt?: string; trigger?: string } } {
    const seen: { prompt?: string; trigger?: string } = {};
    const taskFn: TaskFn = async (req) => {
      seen.prompt = req.prompt;
      seen.trigger = req.trigger;
      return {
        output: "ok",
        runId: "run_test000000",
        toolCalls: [],
        stopReason: "complete",
        usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
      };
    };
    return { taskFn, seen };
  }

  test("goes ahead of the stored prompt, and the stored prompt is not rewritten", async () => {
    const { taskFn, seen } = capturing();
    const executor = createDirectExecutor(taskFn, () => ({}));
    const automation = makeAutomation({ prompt: "Triage the replies." });

    const { run } = await executor(automation, undefined, "event", {
      preamble: "<event>\nOne notification matched.\n</event>",
    });

    expect(seen.prompt).toBe("<event>\nOne notification matched.\n</event>\n\nTriage the replies.");
    // The batch is one run's input. It must not reach the definition, which
    // is what would put inbox content in every later run and in the prefix.
    expect(automation.prompt).toBe("Triage the replies.");
    expect(run.trigger).toBe("event");
  });

  test("translates the trigger into the runtime's vocabulary", async () => {
    const { taskFn, seen } = capturing();
    const executor = createDirectExecutor(taskFn, () => ({}));

    await executor(makeAutomation(), undefined, "event");
    expect(seen.trigger).toBe("event");

    await executor(makeAutomation(), undefined, "scheduled");
    expect(seen.trigger).toBe("schedule");

    await executor(makeAutomation(), undefined, "manual");
    expect(seen.trigger).toBe("manual");
  });

  test("a run with no per-run input sends the prompt unchanged", async () => {
    const { taskFn, seen } = capturing();
    const executor = createDirectExecutor(taskFn, () => ({}));
    await executor(makeAutomation({ prompt: "Just this." }), undefined, "scheduled");
    expect(seen.prompt).toBe("Just this.");
  });
});
