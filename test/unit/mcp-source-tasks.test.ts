import { describe, it, expect } from "bun:test";
import { McpSource } from "../../src/tools/mcp-source.ts";
import type { EventSink, EngineEvent } from "../../src/engine/types.ts";

// Unit coverage for the task-augmented dispatch path on McpSource.
//
// We can't stand up a real MCP server inside a unit test, so we construct a
// McpSource and poke its private fields to install a scripted `client` whose
// `experimental.tasks.callToolStream` yields a fixed message sequence.
// The scenarios mirror the MCP draft 2025-11-25 task stream:
// `taskCreated → taskStatus* → (result | error)`, plus abort and
// protocol-violation edge cases.

interface RecordingSink {
  sink: EventSink;
  events: EngineEvent[];
}

function recordingSink(): RecordingSink {
  const events: EngineEvent[] = [];
  return { events, sink: { emit: (e) => events.push(e) } };
}

function progressEvents(events: EngineEvent[]) {
  return events.filter((e) => e.type === "tool.progress");
}

function runErrorEvents(events: EngineEvent[]) {
  return events.filter((e) => e.type === "run.error");
}

interface BuildOptions {
  stream: () => AsyncGenerator<unknown>;
  onTryRestart?: () => Promise<boolean>;
}

function buildTaskAugmentedSource(sink: EventSink, opts: BuildOptions): McpSource {
  const source = new McpSource(
    "test",
    { type: "stdio", spawn: { command: "echo", args: [], env: {} } },
    sink,
  );

  const fakeClient = {
    experimental: {
      tasks: {
        callToolStream: (_req: unknown, _o: unknown, _r: unknown) => opts.stream(),
      },
    },
  };

  // Test-only: inject fake client + pre-seed the tool cache so findTool()
  // returns a task-augmented tool without having to hit start()/tools().
  const internals = source as unknown as {
    client: unknown;
    cachedTools: unknown;
    tryRestart: () => Promise<boolean>;
  };
  internals.client = fakeClient;
  internals.cachedTools = [
    {
      name: "test__do_work",
      description: "",
      inputSchema: {},
      source: "mcpb:test",
      execution: { taskSupport: "optional" },
    },
  ];
  if (opts.onTryRestart) {
    internals.tryRestart = opts.onTryRestart;
  }

  return source;
}

describe("McpSource.callToolAsTask", () => {
  it("happy path: taskCreated → taskStatus → result returns the tool result and emits progress", async () => {
    const { sink, events } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: { taskId: "t1", status: "working" } };
        yield {
          type: "taskStatus",
          task: { taskId: "t1", status: "working", statusMessage: "halfway" },
        };
        yield {
          type: "result",
          result: {
            content: [{ type: "text", text: "done" }],
            isError: false,
          },
        };
      },
    });

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);

    // taskCreated + one taskStatus both become tool.progress events
    const progress = progressEvents(events);
    expect(progress.length).toBe(2);
    expect(progress.every((e) => (e.data as { tool: string }).tool === "do_work")).toBe(true);
    expect((progress[1]!.data as { message?: string }).message).toBe("halfway");
  });

  it("stream-level `error` message is surfaced as isError without restart", async () => {
    const { sink, events } = recordingSink();
    let restartCalled = false;
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: { taskId: "t1", status: "working" } };
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
    // Stream-level `error` is a terminal value, not a transport crash —
    // tryRestart must not fire.
    expect(restartCalled).toBe(false);
    // And no source.crashed event either — the outer catch never runs.
    expect(runErrorEvents(events).length).toBe(0);
  });

  it("abort mid-stream emits terminal tool.progress(status=cancelled) and does NOT restart", async () => {
    const { sink, events } = recordingSink();
    const controller = new AbortController();
    let restartCalled = false;

    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: { taskId: "t1", status: "working" } };
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
    // The cancel path must produce a terminal progress event so any UI
    // watching tool.progress can transition out of "working".
    const cancelled = progressEvents(events).filter(
      (e) => (e.data as { status: string }).status === "cancelled",
    );
    expect(cancelled.length).toBe(1);
    // Cancel is not a crash — do not restart, do not emit source.crashed.
    expect(restartCalled).toBe(false);
    expect(runErrorEvents(events).length).toBe(0);
  });

  it("task-augmented transport failure is NOT auto-retried (no tryRestart, no inline fallback)", async () => {
    const { sink, events } = recordingSink();
    let restartCalled = false;

    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: { taskId: "t1", status: "working" } };
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
    // Task state lives server-side — retrying would create a duplicate run.
    expect(restartCalled).toBe(false);
    // But a transport blow-up IS a crash: source.crashed must be emitted.
    const crashed = runErrorEvents(events).filter(
      (e) => (e.data as { event?: string }).event === "source.crashed",
    );
    expect(crashed.length).toBe(1);
  });

  it("stream that ends without a terminal message falls back to an error ToolResult", async () => {
    const { sink } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: { taskId: "t1", status: "working" } };
        // No result, no error — protocol violation upstream.
      },
    });

    const result = await source.execute("do_work", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /stream ended without a terminal/,
    );
  });

  it("taskCreated carries the taskId into subsequent progress events", async () => {
    const { sink, events } = recordingSink();
    const source = buildTaskAugmentedSource(sink, {
      stream: async function* () {
        yield { type: "taskCreated", task: { taskId: "task-42", status: "working" } };
        yield {
          type: "taskStatus",
          task: { taskId: "task-42", status: "working", statusMessage: "step 1" },
        };
        yield {
          type: "result",
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        };
      },
    });

    await source.execute("do_work", {});

    const progress = progressEvents(events);
    expect(progress.length).toBe(2);
    expect(progress.every((e) => (e.data as { taskId: string }).taskId === "task-42")).toBe(true);
  });
});
