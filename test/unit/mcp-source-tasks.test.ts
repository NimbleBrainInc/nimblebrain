import { describe, expect, it } from "bun:test";
import type { CallToolResult, Task } from "@modelcontextprotocol/server";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import {
  type TaskStreamMessage as ProductionTaskStreamMessage,
  TASKS_EXTENSION_ID,
} from "../../src/tools/mcp-task-client.ts";
import {
  TaskAlreadyTerminalError,
  TaskNotFoundError,
  type TaskOwnerContext,
} from "../../src/tools/types.ts";
import { payloadsOf } from "../helpers/engine-events.ts";

// Unit coverage for McpSource's task-augmented surface.
//
// We can't stand up a real MCP server inside a unit test, so we construct a
// McpSource and poke its private fields to install a scripted task client whose
// `callToolStream` yields a controlled message sequence. The scenarios mirror
// the task stream `mcp-task-client.ts` produces:
// `taskCreated → taskStatus* → (result | error)`, plus abort, ownership
// enforcement, TTL sweeping, and protocol-violation edge cases.

interface RecordingSink {
  sink: EventSink;
  events: EngineEvent[];
}

function recordingSink(): RecordingSink {
  const events: EngineEvent[] = [];
  return { events, sink: { emit: (e) => events.push(e) } };
}

function taskStatusEvents(events: EngineEvent[]) {
  return payloadsOf(events, "tool.task_status");
}

function healthEvents(events: EngineEvent[]) {
  return payloadsOf(events, "connector.health");
}

/**
 * The stream's message shape is the production one (`mcp-task-client.ts`), so a
 * fixture that drifts from what the runtime yields fails to compile rather than
 * passing against a shape production never produces.
 */
type TaskStreamMessage = ProductionTaskStreamMessage;

/**
 * Test-only stream driver. Resolves `next()` with the messages pushed via
 * `emit(...)` in order; `throwNext()` makes the next `next()` reject. This
 * lets a test step through the SDK's guarantee that the generator ends with
 * a terminal `result`/`error` message.
 */
interface StreamDriver {
  stream: AsyncGenerator<unknown, void, void>;
  emit(message: TaskStreamMessage): void;
  throwNext(err: Error): void;
  end(): void;
}

function streamDriver(): StreamDriver {
  const queue: Array<
    { kind: "value"; value: TaskStreamMessage } | { kind: "error"; error: Error } | { kind: "end" }
  > = [];
  let resolveNext: (() => void) | null = null;

  async function* gen(): AsyncGenerator<unknown, void, void> {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
      const next = queue.shift();
      if (!next) continue;
      if (next.kind === "end") return;
      if (next.kind === "error") throw next.error;
      yield next.value;
    }
  }

  function wake() {
    const r = resolveNext;
    resolveNext = null;
    r?.();
  }

  return {
    stream: gen(),
    emit(message: TaskStreamMessage) {
      queue.push({ kind: "value", value: message });
      wake();
    },
    throwNext(err: Error) {
      queue.push({ kind: "error", error: err });
      wake();
    },
    end() {
      queue.push({ kind: "end" });
      wake();
    },
  };
}

interface BuildOptions {
  /**
   * Fire-once scripted stream (legacy). Use `driver` for interactive
   * control. Typed against `TaskStreamMessage` so plain-object error
   * mocks fail to compile — they must construct real `McpError`
   * instances.
   */
  stream?: () => AsyncGenerator<TaskStreamMessage>;
  /** Drives the stream one message at a time so tests can interleave calls. */
  driver?: StreamDriver;
  /** Fake task client `getTask` (`tasks/get`) return value. */
  getTaskImpl?: (taskId: string) => Promise<Task>;
  onTryRestart?: () => Promise<boolean>;
}

function buildTaskAugmentedSource(sink: EventSink, opts: BuildOptions): McpSource {
  const source = new McpSource(
    "test",
    { type: "remote", url: new URL("http://localhost:0/mcp") },
    sink,
  );

  const fakeTaskClient = {
    callToolStream: (_params: unknown, _opts: unknown) =>
      opts.driver ? opts.driver.stream : (opts.stream?.() ?? emptyStream()),
    getTask: opts.getTaskImpl ?? (() => Promise.reject(new Error("getTask not mocked"))),
  };
  // McpSource.stop() awaits client.close(); without a no-op the stop()
  // path that's exercised by the cleanup test (and any flush in
  // afterEach under suite load) throws TypeError mid-teardown. The server
  // advertises the 2026-07-28 tasks extension, which is what puts every call
  // on the task path.
  const fakeClient = {
    close: async () => {},
    getServerCapabilities: () => ({ extensions: { [TASKS_EXTENSION_ID]: {} } }),
  };

  // Test-only: inject a fake 2026-07-28 client and task client, and pre-seed
  // the tool cache so findTool() resolves without having to hit
  // start()/tools().
  const internals = source as unknown as {
    client: unknown;
    taskClient: unknown;
    protocolEra: "legacy" | "modern";
    cachedTools: unknown;
    tryRestart: () => Promise<boolean>;
  };
  internals.client = fakeClient;
  internals.taskClient = fakeTaskClient;
  internals.protocolEra = "modern";
  internals.cachedTools = [
    { name: "test__do_work", description: "", inputSchema: {}, source: "mcp:test" },
  ];
  if (opts.onTryRestart) {
    internals.tryRestart = opts.onTryRestart;
  }

  return source;
}

async function* emptyStream(): AsyncGenerator<unknown, void, void> {
  // no-op
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    taskId: "t1",
    status: "working",
    ttl: 60_000,
    createdAt: now,
    lastUpdatedAt: now,
    ...overrides,
  };
}

const OWNER: TaskOwnerContext = { workspaceId: "ws_0002ee92e8791c13", identityId: "user_1" };

// ──────────────────────────────────────────────────────────────────────
// Existing agent-loop contract (callToolAsTask wrapper preserved)
// ──────────────────────────────────────────────────────────────────────

describe("McpSource agent-loop (callToolAsTask wrapper)", () => {
  it("happy path: taskCreated → taskStatus → result returns the tool result and emits progress", async () => {
    const { sink, events } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) };
        yield {
          type: "taskStatus",
          task: makeTask({ taskId: "t1", status: "working", statusMessage: "halfway" }),
        };
        yield {
          type: "result",
          result: { content: [{ type: "text", text: "done" }], isError: false },
        };
      },
    });

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);

    // taskCreated (emitted inline by startToolAsTask) + one taskStatus both
    // become tool.task_status events
    const progress = taskStatusEvents(events);
    expect(progress.length).toBe(2);
    expect(progress.every((d) => d.tool === "do_work")).toBe(true);
    expect(progress[1]!.message).toBe("halfway");
  });

  it("stream-level `error` message is surfaced as isError without restart", async () => {
    const { sink, events } = recordingSink();
    let restartCalled = false;
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) };
        yield { type: "error", error: { message: "research failed" } };
      },
      onTryRestart: async () => {
        restartCalled = true;
        return true;
      },
    });

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/research failed/);
    expect(restartCalled).toBe(false);
    expect(healthEvents(events).length).toBe(0);
  });

  it("abort mid-stream emits terminal tool.task_status(status=cancelled) and does NOT restart", async () => {
    const { sink, events } = recordingSink();
    const controller = new AbortController();
    let restartCalled = false;

    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) };
        // Simulate the SDK tearing down the stream on abort.
        controller.abort();
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      },
      onTryRestart: async () => {
        restartCalled = true;
        return true;
      },
    });

    const result = await source.execute("do_work", {}, controller.signal);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/cancelled/i);
    const cancelled = taskStatusEvents(events).filter((d) => d.status === "cancelled");
    expect(cancelled.length).toBe(1);
    expect(restartCalled).toBe(false);
    expect(healthEvents(events).length).toBe(0);
  });

  it("task-augmented transport failure is NOT auto-retried (no tryRestart, no inline fallback)", async () => {
    const { sink, events } = recordingSink();
    let restartCalled = false;

    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) };
        throw new Error("pipe exploded");
      },
      onTryRestart: async () => {
        restartCalled = true;
        return true;
      },
    });

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/cannot be auto-retried/);
    expect(restartCalled).toBe(false);
    const crashed = healthEvents(events).filter((d) => d.event === "source.crashed");
    expect(crashed.length).toBe(1);
  });

  it("stream that ends without a terminal message falls back to an error ToolResult", async () => {
    const { sink } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) };
        // No result, no error — protocol violation upstream.
      },
    });

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/stream ended without a terminal/);
  });

  it("taskCreated carries the taskId into subsequent progress events", async () => {
    const { sink, events } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: makeTask({ taskId: "task-42", status: "working" }) };
        yield {
          type: "taskStatus",
          task: makeTask({ taskId: "task-42", status: "working", statusMessage: "step 1" }),
        };
        yield {
          type: "result",
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        };
      },
    });

    await source.execute("do_work", {});

    const progress = taskStatusEvents(events);
    expect(progress.length).toBe(2);
    expect(progress.every((d) => d.taskId === "task-42")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase-1 API: startToolAsTask
// ──────────────────────────────────────────────────────────────────────

describe("McpSource.startToolAsTask", () => {
  it("returns a CreateTaskResult with a non-empty taskId and status working", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({
      type: "taskCreated",
      task: makeTask({ taskId: "t-alpha", status: "working" }),
    });

    const start = await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });
    expect(start.task.taskId).toBe("t-alpha");
    expect(start.task.status).toBe("working");

    // Clean up — drain the handle so the test exits cleanly.
    driver.emit({
      type: "result",
      result: { content: [{ type: "text", text: "ok" }], isError: false },
    });
    await source.awaitToolTaskResult("t-alpha", { ownerContext: OWNER });
  });

  it("rejects with a descriptive error when the stream ends before yielding taskCreated", async () => {
    const { sink } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        // Stream ends without any messages.
      },
    });

    await expect(source.startToolAsTask("do_work", {}, { ownerContext: OWNER })).rejects.toThrow(
      /before yielding taskCreated/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase-2 API: awaitToolTaskResult
// ──────────────────────────────────────────────────────────────────────

describe("McpSource.awaitToolTaskResult", () => {
  it("returns the full CallToolResult matching the server's final message", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({
      type: "taskCreated",
      task: makeTask({ taskId: "t1", status: "working" }),
    });
    const start = await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });
    expect(start.task.taskId).toBe("t1");

    const expected: CallToolResult = {
      content: [{ type: "text", text: "final payload" }],
      structuredContent: { score: 42 },
      isError: false,
    };
    driver.emit({ type: "result", result: expected });

    const result = await source.awaitToolTaskResult("t1", { ownerContext: OWNER });
    expect(result.content).toEqual([{ type: "text", text: "final payload" }]);
    expect(result.structuredContent).toEqual({ score: 42 });
    expect(result.isError).toBe(false);
  });

  it("rejects with descriptive error when cancelled mid-flight", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({ type: "taskCreated", task: makeTask({ taskId: "t-cancel", status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });

    const awaiting = source.awaitToolTaskResult("t-cancel", { ownerContext: OWNER });
    // Cancel triggers the SDK to abort — the drainer sees the error msg.
    void source.cancelTask("t-cancel", { ownerContext: OWNER });
    driver.emit({ type: "error", error: { message: "cancelled by client" } });

    await expect(awaiting).rejects.toThrow(/cancelled by client/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase-3 API: getTaskStatus
// ──────────────────────────────────────────────────────────────────────

describe("McpSource.getTaskStatus", () => {
  it("between start and terminal returns the latest streamed Task", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, {
      driver,
      // If the engine falls through to upstream, return the *same* cached
      // status so the test reflects the stream's latest value either way.
      getTaskImpl: async (taskId) =>
        makeTask({ taskId, status: "working", statusMessage: "phase-2" }),
    });

    driver.emit({ type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });
    driver.emit({
      type: "taskStatus",
      task: makeTask({ taskId: "t1", status: "working", statusMessage: "phase-2" }),
    });

    // Give the drainer a tick to absorb the status update.
    await new Promise((r) => setTimeout(r, 0));

    const status = await source.getTaskStatus("t1", { ownerContext: OWNER });
    expect(status.taskId).toBe("t1");
    expect(status.status).toBe("working");
    expect(status.statusMessage).toBe("phase-2");

    // Clean up.
    driver.emit({
      type: "result",
      result: { content: [], isError: false },
    });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });
  });

  it("after terminal returns the terminal Task (status=completed)", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({ type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });
    driver.emit({
      type: "result",
      result: { content: [{ type: "text", text: "done" }], isError: false },
    });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });

    const status = await source.getTaskStatus("t1", { ownerContext: OWNER });
    expect(status.status).toBe("completed");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase-4 API: cancelTask
// ──────────────────────────────────────────────────────────────────────

describe("McpSource.cancelTask", () => {
  it("on a running task transitions to cancelled and rejects in-flight await", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({ type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });

    const awaiting = source.awaitToolTaskResult("t1", { ownerContext: OWNER });
    const cancelPromise = source.cancelTask("t1", { ownerContext: OWNER });
    // SDK's normal reply to cancel is an `error` terminal message.
    driver.emit({ type: "error", error: { message: "cancelled" } });

    const final = await cancelPromise;
    expect(final.status).toBe("cancelled");

    await expect(awaiting).rejects.toThrow(/cancelled/);
  });

  it("on a terminal task throws TaskAlreadyTerminalError (mapped to -32602 at /mcp)", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({ type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });
    driver.emit({
      type: "result",
      result: { content: [{ type: "text", text: "done" }], isError: false },
    });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });

    let err: unknown;
    try {
      await source.cancelTask("t1", { ownerContext: OWNER });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskAlreadyTerminalError);
    expect((err as TaskAlreadyTerminalError).status).toBe("completed");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Owner context enforcement — uniform TaskNotFoundError on mismatch
// ──────────────────────────────────────────────────────────────────────

describe("McpSource owner-context enforcement", () => {
  async function startedSource(taskId = "t1") {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });
    driver.emit({ type: "taskCreated", task: makeTask({ taskId, status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });
    return { source, driver };
  }

  it("wrong workspaceId → getTaskStatus rejects with TaskNotFoundError", async () => {
    const { source, driver } = await startedSource();
    const bogus: TaskOwnerContext = { workspaceId: "ws_005820c54ca342ad", identityId: "user_1" };
    await expect(source.getTaskStatus("t1", { ownerContext: bogus })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    // Clean up.
    driver.emit({ type: "result", result: { content: [], isError: false } });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });
  });

  it("wrong identityId → awaitToolTaskResult rejects with TaskNotFoundError", async () => {
    const { source, driver } = await startedSource();
    const bogus: TaskOwnerContext = {
      workspaceId: "ws_0002ee92e8791c13",
      identityId: "user_other",
    };
    await expect(source.awaitToolTaskResult("t1", { ownerContext: bogus })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    driver.emit({ type: "result", result: { content: [], isError: false } });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });
  });

  it("wrong workspaceId → cancelTask rejects with TaskNotFoundError", async () => {
    const { source, driver } = await startedSource();
    const bogus: TaskOwnerContext = { workspaceId: "ws_005820c54ca342ad" };
    await expect(source.cancelTask("t1", { ownerContext: bogus })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    driver.emit({ type: "result", result: { content: [], isError: false } });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });
  });

  it("nonexistent taskId → TaskNotFoundError (does NOT leak existence)", async () => {
    const { source, driver } = await startedSource();
    await expect(source.getTaskStatus("nope", { ownerContext: OWNER })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    driver.emit({ type: "result", result: { content: [], isError: false } });
    await source.awaitToolTaskResult("t1", { ownerContext: OWNER });
  });
});

// ──────────────────────────────────────────────────────────────────────
// TTL sweeper — expired handles are purged
// ──────────────────────────────────────────────────────────────────────

describe("McpSource TTL sweeper", () => {
  it("removes handles past ttl + grace window; subsequent lookup fails", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({
      type: "taskCreated",
      // Already-expired TTL so sweep collects it on the first tick.
      task: {
        taskId: "t1",
        status: "working",
        ttl: 1,
        createdAt: new Date(0).toISOString(),
        lastUpdatedAt: new Date(0).toISOString(),
      },
    });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });

    // Sanity: the handle exists right now.
    const internals = source as unknown as { _taskHandleCountForTesting(): number };
    expect(internals._taskHandleCountForTesting()).toBe(1);

    // Force a sweep.
    const testMethod = source as unknown as { _sweepExpiredTasksForTesting(): number };
    const remaining = testMethod._sweepExpiredTasksForTesting();
    expect(remaining).toBe(0);

    // Post-sweep lookups fail as TaskNotFoundError.
    await expect(source.getTaskStatus("t1", { ownerContext: OWNER })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// stop() cleans up in-flight handles
// ──────────────────────────────────────────────────────────────────────

describe("McpSource.stop() cleanup", () => {
  it("aborts in-flight streams and clears the handle map", async () => {
    const { sink } = recordingSink();
    const driver = streamDriver();
    const source = buildTaskAugmentedSource(sink, { driver });

    driver.emit({ type: "taskCreated", task: makeTask({ taskId: "t1", status: "working" }) });
    await source.startToolAsTask("do_work", {}, { ownerContext: OWNER });

    const awaiting = source.awaitToolTaskResult("t1", { ownerContext: OWNER });

    await source.stop();

    // In-flight awaits reject with a descriptive error.
    await expect(awaiting).rejects.toThrow(/source stopped/);

    // Map is cleared.
    const internals = source as unknown as { _taskHandleCountForTesting(): number };
    expect(internals._taskHandleCountForTesting()).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// A 2025-era connection: no task is ever attached (ADR-0046)
// ──────────────────────────────────────────────────────────────────────

/**
 * A source on a 2025-era connection whose `do_work` declares `taskSupport`,
 * recording every `tools/call` that reaches the client and every task stream
 * opened. The task client fails the test if it is ever used.
 */
function buildLegacySource(taskSupport: "optional" | "required") {
  const sent: unknown[] = [];
  let streamsOpened = 0;
  const source = new McpSource(
    "test",
    { type: "remote", url: new URL("http://localhost:0/mcp") },
    recordingSink().sink,
  );
  const internals = source as unknown as {
    client: unknown;
    taskClient: unknown;
    protocolEra: "legacy" | "modern";
    cachedTools: unknown;
  };
  internals.client = {
    close: async () => {},
    getServerCapabilities: () => ({ tools: {} }),
    callTool: async (params: unknown) => {
      sent.push(params);
      return { content: [{ type: "text", text: "inline answer" }] };
    },
  };
  internals.taskClient = {
    callToolStream: () => {
      streamsOpened++;
      return emptyStream();
    },
    getTask: () => Promise.reject(new Error("no task on a 2025-era connection")),
  };
  internals.protocolEra = "legacy";
  internals.cachedTools = [
    {
      name: "test__do_work",
      description: "",
      inputSchema: {},
      source: "mcp:test",
      execution: { taskSupport },
    },
  ];
  return { source, sent, streamsOpened: () => streamsOpened };
}

describe("McpSource on a 2025-era connection", () => {
  it('calls a taskSupport "optional" tool inline, attaching no task', async () => {
    const { source, sent, streamsOpened } = buildLegacySource("optional");

    const result = await source.execute("do_work", { q: 1 });

    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toBe("inline answer");
    expect(sent).toEqual([{ name: "do_work", arguments: { q: 1 } }]);
    expect(streamsOpened()).toBe(0);
  });

  it('refuses a taskSupport "required" tool before dispatch, naming the reason', async () => {
    const { source, sent, streamsOpened } = buildLegacySource("required");

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('requires a task (execution.taskSupport "required")');
    expect(text).toContain("2025-11-25 tasks utility");
    expect(text).toContain("ADR-0046");
    expect(sent).toEqual([]);
    expect(streamsOpened()).toBe(0);
  });

  it('refuses to start a taskSupport "required" tool as a task, sending nothing', async () => {
    const { source, sent, streamsOpened } = buildLegacySource("required");

    await expect(source.startToolAsTask("do_work", {}, { ownerContext: OWNER })).rejects.toThrow(
      "2025-11-25 tasks utility",
    );
    expect(sent).toEqual([]);
    expect(streamsOpened()).toBe(0);
  });
});
