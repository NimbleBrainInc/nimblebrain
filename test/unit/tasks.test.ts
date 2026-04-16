import { describe, expect, it } from "bun:test";
import { AgentEngine } from "../../src/engine/engine.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { textContent, extractText } from "../../src/engine/content-helpers.ts";
import {
  ActiveTaskTracker,
  pollTask,
  isCreateTaskResult,
  isTerminalStatus,
  getImmediateResponse,
} from "../../src/engine/tasks.ts";
import type { McpTask } from "../../src/engine/tasks.ts";
import type {
  EngineConfig,
  EngineEvent,
  EventSink,
  TaskClientPort,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultConfig: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

/** Create a TaskClientPort mock from a sequence of task states. */
function mockTaskClient(
  states: Array<{ status: string; statusMessage?: string; pollInterval?: number }>,
  finalResult?: { content: Array<{ type: string; text: string }>; isError?: boolean },
): TaskClientPort & { cancelCalls: string[] } {
  let pollIndex = 0;
  const cancelCalls: string[] = [];

  return {
    cancelCalls,
    async getTask(taskId: string) {
      const state = states[pollIndex] ?? states[states.length - 1]!;
      pollIndex++;
      return {
        taskId,
        status: state.status,
        ttl: null,
        createdAt: "2025-01-01T00:00:00Z",
        lastUpdatedAt: "2025-01-01T00:00:01Z",
        pollInterval: state.pollInterval,
        statusMessage: state.statusMessage,
      };
    },
    async getTaskResult(_taskId: string) {
      return finalResult ?? { content: [{ type: "text", text: "Task completed" }] };
    },
    async cancelTask(taskId: string) {
      cancelCalls.push(taskId);
    },
  };
}

/** Build a ToolResult with _taskResult metadata. */
function taskToolResult(opts?: {
  taskId?: string;
  status?: string;
  pollInterval?: number;
  statusMessage?: string;
  immediateResponse?: string;
}): ToolResult {
  const meta: Record<string, unknown> = {};
  if (opts?.immediateResponse) {
    meta["io.modelcontextprotocol/model-immediate-response"] = opts.immediateResponse;
  }
  return {
    content: textContent(opts?.statusMessage ?? "Task created"),
    isError: false,
    _taskResult: {
      task: {
        taskId: opts?.taskId ?? "task-001",
        status: opts?.status ?? "working",
        ttl: null,
        createdAt: "2025-01-01T00:00:00Z",
        lastUpdatedAt: "2025-01-01T00:00:00Z",
        pollInterval: opts?.pollInterval ?? 10, // fast for tests
        statusMessage: opts?.statusMessage,
      },
      _meta: Object.keys(meta).length > 0 ? meta : undefined,
    },
  };
}

function collectEvents(): { events: EngineEvent[]; sink: EventSink } {
  const events: EngineEvent[] = [];
  return {
    events,
    sink: { emit(e: EngineEvent) { events.push(e); } },
  };
}

// ---------------------------------------------------------------------------
// Unit tests: isCreateTaskResult
// ---------------------------------------------------------------------------

describe("isCreateTaskResult", () => {
  it("returns true for a valid CreateTaskResult", () => {
    expect(
      isCreateTaskResult({
        task: { taskId: "t1", status: "working", ttl: null, createdAt: "", lastUpdatedAt: "" },
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isCreateTaskResult(null)).toBe(false);
  });

  it("returns false for a plain object without task", () => {
    expect(isCreateTaskResult({ content: "hello" })).toBe(false);
  });

  it("returns false when task is missing taskId", () => {
    expect(isCreateTaskResult({ task: { status: "working" } })).toBe(false);
  });

  it("returns false for a normal ToolResult", () => {
    expect(isCreateTaskResult({ content: "ok", isError: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: isTerminalStatus
// ---------------------------------------------------------------------------

describe("isTerminalStatus", () => {
  it("completed is terminal", () => expect(isTerminalStatus("completed")).toBe(true));
  it("failed is terminal", () => expect(isTerminalStatus("failed")).toBe(true));
  it("cancelled is terminal", () => expect(isTerminalStatus("cancelled")).toBe(true));
  it("working is not terminal", () => expect(isTerminalStatus("working")).toBe(false));
  it("input_required is not terminal", () => expect(isTerminalStatus("input_required")).toBe(false));
});

// ---------------------------------------------------------------------------
// Unit tests: getImmediateResponse
// ---------------------------------------------------------------------------

describe("getImmediateResponse", () => {
  it("extracts the immediate response string from _meta", () => {
    const result = getImmediateResponse({
      task: { taskId: "t1", status: "working", ttl: null, createdAt: "", lastUpdatedAt: "" },
      _meta: { "io.modelcontextprotocol/model-immediate-response": "Processing your request..." },
    });
    expect(result).toBe("Processing your request...");
  });

  it("returns undefined when _meta is absent", () => {
    const result = getImmediateResponse({
      task: { taskId: "t1", status: "working", ttl: null, createdAt: "", lastUpdatedAt: "" },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the key is not a string", () => {
    const result = getImmediateResponse({
      task: { taskId: "t1", status: "working", ttl: null, createdAt: "", lastUpdatedAt: "" },
      _meta: { "io.modelcontextprotocol/model-immediate-response": 42 },
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: ActiveTaskTracker
// ---------------------------------------------------------------------------

describe("ActiveTaskTracker", () => {
  it("tracks task registrations", () => {
    const tracker = new ActiveTaskTracker();
    const client = mockTaskClient([]);
    tracker.register("t1", client);
    tracker.register("t2", client);
    expect(tracker.size).toBe(2);
  });

  it("unregisters tasks", () => {
    const tracker = new ActiveTaskTracker();
    const client = mockTaskClient([]);
    tracker.register("t1", client);
    tracker.unregister("t1");
    expect(tracker.size).toBe(0);
  });

  it("cancelAll sends cancel to all active tasks", async () => {
    const tracker = new ActiveTaskTracker();
    const client = mockTaskClient([]);
    tracker.register("t1", client);
    tracker.register("t2", client);
    await tracker.cancelAll();
    expect(client.cancelCalls).toContain("t1");
    expect(client.cancelCalls).toContain("t2");
    expect(tracker.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: pollTask
// ---------------------------------------------------------------------------

describe("pollTask", () => {
  it("resolves on completed status", async () => {
    const client = mockTaskClient(
      [{ status: "completed" }],
      { content: [{ type: "text", text: "Done!" }] },
    );
    const { events, sink } = collectEvents();
    const task: McpTask = {
      taskId: "t1",
      status: "working",
      ttl: null,
      createdAt: "2025-01-01T00:00:00Z",
      lastUpdatedAt: "2025-01-01T00:00:00Z",
      pollInterval: 10,
    };

    const result = await pollTask(client, task, {
      runId: "run-1",
      toolCallId: "tool-1",
      events: sink,
    });

    expect(extractText(result.content)).toBe("Done!");
    expect(result.isError).toBe(false);

    const progressEvents = events.filter((e) => e.type === "tool.progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]!.data.taskId).toBe("t1");
  });

  it("returns error for failed task", async () => {
    const client = mockTaskClient([{ status: "failed", statusMessage: "Out of memory" }]);
    const { sink } = collectEvents();
    const task: McpTask = {
      taskId: "t2",
      status: "working",
      ttl: null,
      createdAt: "",
      lastUpdatedAt: "",
      pollInterval: 10,
    };

    const result = await pollTask(client, task, {
      runId: "run-1",
      toolCallId: "tool-1",
      events: sink,
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toBe("Out of memory");
  });

  it("returns error for cancelled task", async () => {
    const client = mockTaskClient([{ status: "cancelled" }]);
    const { sink } = collectEvents();
    const task: McpTask = {
      taskId: "t3",
      status: "working",
      ttl: null,
      createdAt: "",
      lastUpdatedAt: "",
      pollInterval: 10,
    };

    const result = await pollTask(client, task, {
      runId: "run-1",
      toolCallId: "tool-1",
      events: sink,
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("cancelled");
  });

  it("emits progress events with correct fields during polling", async () => {
    const client = mockTaskClient([
      { status: "working", statusMessage: "Step 1", pollInterval: 10 },
      { status: "working", statusMessage: "Step 2", pollInterval: 10 },
      { status: "completed", pollInterval: 10 },
    ]);
    const { events, sink } = collectEvents();
    const task: McpTask = {
      taskId: "t4",
      status: "working",
      ttl: null,
      createdAt: "",
      lastUpdatedAt: "",
      pollInterval: 10,
      statusMessage: "Starting",
    };

    await pollTask(client, task, {
      runId: "run-42",
      toolCallId: "tool-7",
      events: sink,
    });

    const progressEvents = events.filter((e) => e.type === "tool.progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const first = progressEvents[0]!;
    expect(first.data.runId).toBe("run-42");
    expect(first.data.toolCallId).toBe("tool-7");
    expect(first.data.taskId).toBe("t4");
    expect(first.data.message).toBe("Starting");
  });

  it("uses server-provided pollInterval", async () => {
    const client = mockTaskClient([
      { status: "working", pollInterval: 20 },
      { status: "completed" },
    ]);
    const { sink } = collectEvents();
    const task: McpTask = {
      taskId: "t5",
      status: "working",
      ttl: null,
      createdAt: "",
      lastUpdatedAt: "",
      pollInterval: 20,
    };

    const start = performance.now();
    await pollTask(client, task, {
      runId: "run-1",
      toolCallId: "tool-1",
      events: sink,
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it("cancels on abort signal", async () => {
    const client = mockTaskClient([
      { status: "working" },
      { status: "working" },
      { status: "working" },
    ]);
    const { sink } = collectEvents();
    const controller = new AbortController();
    const task: McpTask = {
      taskId: "t6",
      status: "working",
      ttl: null,
      createdAt: "",
      lastUpdatedAt: "",
      pollInterval: 10,
    };

    setTimeout(() => controller.abort(), 5);

    const result = await pollTask(client, task, {
      runId: "run-1",
      toolCallId: "tool-1",
      events: sink,
      signal: controller.signal,
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("cancelled");
    expect(client.cancelCalls).toContain("t6");
  });

  it("emits task.input_required when status is input_required", async () => {
    const client = mockTaskClient([
      { status: "input_required", statusMessage: "Need approval", pollInterval: 10 },
      { status: "completed", pollInterval: 10 },
    ]);
    const { events, sink } = collectEvents();
    const task: McpTask = {
      taskId: "t7",
      status: "working",
      ttl: null,
      createdAt: "",
      lastUpdatedAt: "",
      pollInterval: 10,
    };

    const result = await pollTask(client, task, {
      runId: "run-1",
      toolCallId: "tool-1",
      events: sink,
    });

    expect(result.isError).toBe(false);
    const inputEvents = events.filter((e) => e.type === "task.input_required");
    expect(inputEvents.length).toBe(1);
    expect(inputEvents[0]!.data.taskId).toBe("t7");
    expect(inputEvents[0]!.data.message).toBe("Need approval");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: AgentEngine with task-augmented tools
// ---------------------------------------------------------------------------

describe("AgentEngine with MCP Tasks", () => {
  it("synchronous tool result passes through unchanged (no task detection)", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__sync", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__sync", description: "Sync tool", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("immediate result"), isError: false }),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], tools.schemas);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.output).toBe("immediate result");
    expect(result.toolCalls[0]!.ok).toBe(true);
  });

  it("CreateTaskResult detected and polling initiated", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__slow", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Got it" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const taskClient = mockTaskClient(
      [{ status: "completed" }],
      { content: [{ type: "text", text: "Task result data" }] },
    );

    const tools = {
      schemas: [{ name: "test__slow", description: "Slow", inputSchema: {} }],
      handler: (): ToolResult => taskToolResult({ pollInterval: 10 }),
    };

    const { events, sink } = collectEvents();
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      sink,
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        taskClientResolver: () => taskClient,
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.output).toBe("Task result data");
    expect(result.toolCalls[0]!.ok).toBe(true);

    const progressEvents = events.filter((e) => e.type === "tool.progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("failed task returns isError result", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__fail", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Handled" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const taskClient = mockTaskClient([
      { status: "failed", statusMessage: "Server crashed" },
    ]);

    const tools = {
      schemas: [{ name: "test__fail", description: "Fail", inputSchema: {} }],
      handler: (): ToolResult => taskToolResult({ pollInterval: 10 }),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        taskClientResolver: () => taskClient,
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.output).toBe("Server crashed");
  });

  it("cancelled task returns isError result", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__cancel", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "OK" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const taskClient = mockTaskClient([{ status: "cancelled" }]);

    const tools = {
      schemas: [{ name: "test__cancel", description: "Cancel", inputSchema: {} }],
      handler: (): ToolResult => taskToolResult({ pollInterval: 10 }),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        taskClientResolver: () => taskClient,
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.output).toContain("cancelled");
  });

  it("multiple task-augmented tools polled concurrently", async () => {
    const POLL_INTERVAL = 30;
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__t1", input: JSON.stringify({ n: 1 }) },
            { type: "tool-call", toolCallId: "c2", toolName: "test__t2", input: JSON.stringify({ n: 2 }) },
            { type: "tool-call", toolCallId: "c3", toolName: "test__sync", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "All done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const taskClient1 = mockTaskClient(
      [{ status: "completed" }],
      { content: [{ type: "text", text: "result-1" }] },
    );
    const taskClient2 = mockTaskClient(
      [{ status: "completed" }],
      { content: [{ type: "text", text: "result-2" }] },
    );

    const schemas: ToolSchema[] = [
      { name: "test__t1", description: "Task 1", inputSchema: {} },
      { name: "test__t2", description: "Task 2", inputSchema: {} },
      { name: "test__sync", description: "Sync", inputSchema: {} },
    ];

    const handler = (call: ToolCall): ToolResult => {
      if (call.name === "test__sync") {
        return { content: textContent("sync-result"), isError: false };
      }
      return taskToolResult({
        taskId: call.name === "test__t1" ? "task-A" : "task-B",
        pollInterval: POLL_INTERVAL,
      });
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(schemas, handler),
      new NoopEventSink(),
    );

    const start = performance.now();
    const result = await engine.run(
      {
        ...defaultConfig,
        taskClientResolver: (name: string) => {
          if (name === "test__t1") return taskClient1;
          if (name === "test__t2") return taskClient2;
          return undefined;
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      schemas,
    );
    const elapsed = performance.now() - start;

    expect(result.toolCalls).toHaveLength(3);

    const t1 = result.toolCalls.find((tc) => tc.name === "test__t1");
    const t2 = result.toolCalls.find((tc) => tc.name === "test__t2");
    const sync = result.toolCalls.find((tc) => tc.name === "test__sync");
    expect(t1!.output).toBe("result-1");
    expect(t2!.output).toBe("result-2");
    expect(sync!.output).toBe("sync-result");

    expect(elapsed).toBeLessThan(POLL_INTERVAL * 3);
  });

  it("engine cancellation sends tasks/cancel to all active tasks", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__long", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const taskClient = mockTaskClient([
      { status: "working", pollInterval: 10 },
      { status: "working", pollInterval: 10 },
      { status: "working", pollInterval: 10 },
      { status: "cancelled" },
    ]);

    const tools = {
      schemas: [{ name: "test__long", description: "Long running", inputSchema: {} }],
      handler: (): ToolResult => taskToolResult({ pollInterval: 10 }),
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        signal: controller.signal,
        taskClientResolver: () => taskClient,
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(taskClient.cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(taskClient.cancelCalls).toContain("task-001");
    expect(result.toolCalls[0]!.ok).toBe(false);
  });

  it("immediate response string fed as interim result while polling", async () => {
    let callCount = 0;
    let feedbackContent = "";
    const model = createMockModel((options) => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__imm", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      // Capture what tool result the model sees
      const lastMsg = options.prompt[options.prompt.length - 1]!;
      if (lastMsg.role === "tool" && Array.isArray(lastMsg.content)) {
        const part = lastMsg.content[0] as { output?: { value?: string } };
        feedbackContent = part.output?.value ?? "";
      }
      return {
        content: [{ type: "text", text: "OK" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const taskClient = mockTaskClient(
      [{ status: "completed" }],
      { content: [{ type: "text", text: "Final result" }] },
    );

    const tools = {
      schemas: [{ name: "test__imm", description: "Immediate", inputSchema: {} }],
      handler: (): ToolResult =>
        taskToolResult({
          pollInterval: 10,
          immediateResponse: "Processing your request...",
        }),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        taskClientResolver: () => taskClient,
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(result.toolCalls[0]!.output).toBe("Final result");
    expect(feedbackContent).toBe("Final result");
  });

  it("without taskClientResolver, task result passes through as-is", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__task", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__task", description: "Task", inputSchema: {} }],
      handler: (): ToolResult => taskToolResult(),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], tools.schemas);

    expect(result.toolCalls[0]!.output).toBe("Task created");
    expect(result.toolCalls[0]!.ok).toBe(true);
  });
});
