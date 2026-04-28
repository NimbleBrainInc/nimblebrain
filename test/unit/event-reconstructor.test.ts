import { describe, expect, it } from "bun:test";
import {
  deriveUsageMetrics,
  reconstructMessages,
} from "../../src/conversation/event-reconstructor.ts";
import type {
  ConversationEvent,
  LlmResponseEvent,
  RunDoneEvent,
  RunErrorEvent,
  RunStartEvent,
  ToolDoneEvent,
  ToolStartEvent,
  UserMessageEvent,
} from "../../src/conversation/types.ts";

// ---------------------------------------------------------------------------
// Helpers — event factories
// ---------------------------------------------------------------------------

const ts = (offset = 0) => new Date(Date.now() + offset).toISOString();

function userMessage(text: string, opts?: { userId?: string }): UserMessageEvent {
  return {
    ts: ts(),
    type: "user.message",
    content: [{ type: "text", text }],
    ...(opts?.userId ? { userId: opts.userId } : {}),
  };
}

function runStart(runId: string, model = "claude-sonnet-4-5-20250929"): RunStartEvent {
  return { ts: ts(1), type: "run.start", runId, model };
}

function llmText(
  runId: string,
  text: string,
  opts?: Partial<Pick<LlmResponseEvent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "llmMs" | "model">>,
): LlmResponseEvent {
  return {
    ts: ts(2),
    type: "llm.response",
    runId,
    model: opts?.model ?? "claude-sonnet-4-5-20250929",
    content: [{ type: "text", text }],
    inputTokens: opts?.inputTokens ?? 100,
    outputTokens: opts?.outputTokens ?? 50,
    cacheReadTokens: opts?.cacheReadTokens ?? 0,
    cacheCreationTokens: opts?.cacheCreationTokens ?? 0,
    llmMs: opts?.llmMs ?? 500,
  };
}

function llmToolCall(
  runId: string,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {},
  opts?: Partial<Pick<LlmResponseEvent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "llmMs" | "model">>,
): LlmResponseEvent {
  return {
    ts: ts(2),
    type: "llm.response",
    runId,
    model: opts?.model ?? "claude-sonnet-4-5-20250929",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
    inputTokens: opts?.inputTokens ?? 100,
    outputTokens: opts?.outputTokens ?? 50,
    cacheReadTokens: opts?.cacheReadTokens ?? 0,
    cacheCreationTokens: opts?.cacheCreationTokens ?? 0,
    llmMs: opts?.llmMs ?? 500,
  };
}

/** Create an LLM response with multiple parallel tool calls. */
function llmParallelToolCalls(
  runId: string,
  calls: Array<{ toolCallId: string; toolName: string; input?: Record<string, unknown> }>,
  opts?: Partial<Pick<LlmResponseEvent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "llmMs" | "model">>,
): LlmResponseEvent {
  return {
    ts: ts(2),
    type: "llm.response",
    runId,
    model: opts?.model ?? "claude-sonnet-4-5-20250929",
    content: calls.map((c) => ({
      type: "tool-call" as const,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input ?? {},
    })),
    inputTokens: opts?.inputTokens ?? 100,
    outputTokens: opts?.outputTokens ?? 50,
    cacheReadTokens: opts?.cacheReadTokens ?? 0,
    cacheCreationTokens: opts?.cacheCreationTokens ?? 0,
    llmMs: opts?.llmMs ?? 500,
  };
}

function toolStart(runId: string, id: string, name: string): ToolStartEvent {
  return { ts: ts(3), type: "tool.start", runId, name, id };
}

function toolDone(
  runId: string,
  id: string,
  name: string,
  output = "result",
  ok = true,
  ms = 100,
): ToolDoneEvent {
  return { ts: ts(4), type: "tool.done", runId, name, id, ok, ms, output };
}

function runDone(runId: string, totalMs = 1000): RunDoneEvent {
  return { ts: ts(5), type: "run.done", runId, stopReason: "end_turn", totalMs };
}

function runError(runId: string, error = "Something failed"): RunErrorEvent {
  return {
    ts: ts(5),
    type: "run.error",
    runId,
    error,
    errorType: "runtime_error",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconstructMessages", () => {
  it("returns empty array for empty events", () => {
    expect(reconstructMessages([])).toEqual([]);
  });

  it("converts a single user.message to a user StoredMessage", () => {
    const events: ConversationEvent[] = [
      userMessage("Hello"),
    ];
    const messages = reconstructMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([{ type: "text", text: "Hello" }]);
    expect(messages[0].timestamp).toBeDefined();
  });

  it("preserves userId on user messages", () => {
    const events: ConversationEvent[] = [
      userMessage("Hi", { userId: "user-123" }),
    ];
    const messages = reconstructMessages(events);
    expect(messages[0].userId).toBe("user-123");
  });

  it("converts a simple text response to user + assistant messages", () => {
    const events: ConversationEvent[] = [
      userMessage("What is 2+2?"),
      runStart("run-1"),
      llmText("run-1", "4"),
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);
    expect(messages).toHaveLength(2);

    // User message
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([{ type: "text", text: "What is 2+2?" }]);

    // Assistant message
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toEqual([{ type: "text", text: "4" }]);
    expect(messages[1].metadata).toBeDefined();
    expect(messages[1].metadata!.inputTokens).toBe(100);
    expect(messages[1].metadata!.outputTokens).toBe(50);
    expect(messages[1].metadata!.model).toBe("claude-sonnet-4-5-20250929");
    expect(messages[1].metadata!.iterations).toBe(1);
  });

  it("converts a tool call flow into assistant + tool + assistant messages", () => {
    const events: ConversationEvent[] = [
      userMessage("Search for cats"),
      runStart("run-1"),
      llmToolCall("run-1", "tc-1", "web_search", { query: "cats" }),
      toolStart("run-1", "tc-1", "web_search"),
      toolDone("run-1", "tc-1", "web_search", "Found 10 results about cats"),
      llmText("run-1", "I found information about cats."),
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);
    expect(messages).toHaveLength(4);

    // User
    expect(messages[0].role).toBe("user");

    // Assistant with tool call
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toEqual([
      { type: "tool-call", toolCallId: "tc-1", toolName: "web_search", input: { query: "cats" } },
    ]);
    expect(messages[1].metadata!.toolCalls).toHaveLength(1);
    expect(messages[1].metadata!.toolCalls![0].name).toBe("web_search");
    expect(messages[1].metadata!.toolCalls![0].output).toBe("Found 10 results about cats");
    expect(messages[1].metadata!.toolCalls![0].ok).toBe(true);
    expect(messages[1].metadata!.iterations).toBe(2); // 2 llm.response events in this run

    // Tool result
    expect(messages[2].role).toBe("tool");
    expect(messages[2].content).toEqual([
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "web_search",
        output: { type: "text", value: "Found 10 results about cats" },
      },
    ]);

    // Final assistant text
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toEqual([{ type: "text", text: "I found information about cats." }]);
  });

  it("parses string tool-call input from JSONL (AI SDK V3 format)", () => {
    // The AI SDK V3 stream emits tool-call input as a JSON string.
    // When persisted to JSONL and read back, input remains a string.
    // The reconstructor must parse it to an object for the Anthropic API.
    const events: ConversationEvent[] = [
      userMessage("seed the data"),
      runStart("run-1"),
      {
        ts: ts(2),
        type: "llm.response",
        runId: "run-1",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "tool-call", toolCallId: "tc-1", toolName: "seed_data", input: "{}" as unknown }],
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        llmMs: 500,
      } as LlmResponseEvent,
      toolStart("run-1", "tc-1", "seed_data"),
      toolDone("run-1", "tc-1", "seed_data", "seeded"),
      llmText("run-1", "Done seeding."),
      runDone("run-1"),
    ];

    const messages = reconstructMessages(events);
    const assistantContent = messages[1].content as Array<{ type: string; input: unknown }>;
    // input must be an object, not a string
    expect(assistantContent[0].input).toEqual({});
    expect(typeof assistantContent[0].input).toBe("object");
  });

  it("handles multi-iteration run (3 llm.response events)", () => {
    const events: ConversationEvent[] = [
      userMessage("Do a complex task"),
      runStart("run-1"),
      // Iteration 1: tool call
      llmToolCall("run-1", "tc-1", "read_file", { path: "/a.txt" }),
      toolStart("run-1", "tc-1", "read_file"),
      toolDone("run-1", "tc-1", "read_file", "file content A"),
      // Iteration 2: another tool call
      llmToolCall("run-1", "tc-2", "read_file", { path: "/b.txt" }),
      toolStart("run-1", "tc-2", "read_file"),
      toolDone("run-1", "tc-2", "read_file", "file content B"),
      // Iteration 3: final text
      llmText("run-1", "Done reading both files."),
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);

    // user + assistant(tc-1) + tool(tc-1) + assistant(tc-2) + tool(tc-2) + assistant(text)
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant"); // tool call 1
    expect(messages[2].role).toBe("tool");       // tool result 1
    expect(messages[3].role).toBe("assistant"); // tool call 2
    expect(messages[4].role).toBe("tool");       // tool result 2
    expect(messages[5].role).toBe("assistant"); // final text

    // All assistant messages in this run should have iterations=3
    expect(messages[1].metadata!.iterations).toBe(3);
    expect(messages[3].metadata!.iterations).toBe(3);
    expect(messages[5].metadata!.iterations).toBe(3);
  });

  it("handles run with error — messages up to the error are returned", () => {
    const events: ConversationEvent[] = [
      userMessage("Try something risky"),
      runStart("run-1"),
      llmToolCall("run-1", "tc-1", "risky_tool", {}),
      toolStart("run-1", "tc-1", "risky_tool"),
      toolDone("run-1", "tc-1", "risky_tool", "partial result", false, 200),
      runError("run-1", "Tool execution failed"),
    ];
    const messages = reconstructMessages(events);

    // user + assistant(tool-call) + tool(result)
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].metadata!.toolCalls![0].ok).toBe(false);
    expect(messages[2].role).toBe("tool");
  });

  it("handles tool-only response with no final text", () => {
    const events: ConversationEvent[] = [
      userMessage("Just call the tool"),
      runStart("run-1"),
      llmToolCall("run-1", "tc-1", "some_tool", {}),
      toolStart("run-1", "tc-1", "some_tool"),
      toolDone("run-1", "tc-1", "some_tool", "tool output"),
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);

    // user + assistant(tool-call) + tool(result) — no final text assistant
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
  });

  it("forwards finishReason from llm.response into assistant message metadata", () => {
    const lengthCapped: LlmResponseEvent = {
      ...llmText("run-1", "Building now."),
      finishReason: "length",
    };
    const events: ConversationEvent[] = [
      userMessage("Build the doc"),
      runStart("run-1"),
      lengthCapped,
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);
    expect(messages[1].metadata!.finishReason).toBe("length");
  });

  it("omits finishReason from metadata when the event lacks it (legacy)", () => {
    const events: ConversationEvent[] = [
      userMessage("Hi"),
      runStart("run-1"),
      llmText("run-1", "Hello"),
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);
    expect(messages[1].metadata!.finishReason).toBeUndefined();
  });

  it("populates costUsd in assistant metadata", () => {
    const events: ConversationEvent[] = [
      userMessage("Hello"),
      runStart("run-1"),
      llmText("run-1", "Hi there!", { inputTokens: 1000, outputTokens: 500 }),
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);
    const assistantMeta = messages[1].metadata!;
    expect(typeof assistantMeta.costUsd).toBe("number");
    expect(assistantMeta.costUsd).toBeGreaterThanOrEqual(0);
  });

  it("does not mutate input events", () => {
    const events: ConversationEvent[] = [
      userMessage("Hello"),
      runStart("run-1"),
      llmText("run-1", "Hi"),
      runDone("run-1"),
    ];
    const frozen = JSON.parse(JSON.stringify(events));
    reconstructMessages(events);
    expect(events).toEqual(frozen);
  });

  it("drops unexecuted tool calls when run ends early (token_budget)", () => {
    // Reproduces production bug: LLM response with 4 tool calls is persisted,
    // but the run is cut short before tools execute. The reconstructor should
    // NOT create fake empty tool results for unexecuted tool calls.
    const events: ConversationEvent[] = [
      userMessage("Read all files"),
      runStart("run-1"),
      llmParallelToolCalls("run-1", [
        { toolCallId: "tc-a", toolName: "files__read" },
        { toolCallId: "tc-b", toolName: "files__read" },
        { toolCallId: "tc-c", toolName: "files__read" },
        { toolCallId: "tc-d", toolName: "files__read" },
      ]),
      // No tool.start or tool.done events — run was cut short
      { ts: ts(5), type: "run.done", runId: "run-1", stopReason: "token_budget", totalMs: 1000 } as RunDoneEvent,
    ];
    const messages = reconstructMessages(events);

    // Should only have the user message — no assistant or tool messages
    // because the tool calls were never executed
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("keeps executed tool calls but drops unexecuted ones from same response", () => {
    // If a run partially executes (some tools complete before cutoff),
    // only the executed ones should appear in reconstruction.
    // Note: In practice the engine executes all tools from one LLM response
    // before checking the budget, so this is a defensive test.
    const events: ConversationEvent[] = [
      userMessage("Do stuff"),
      runStart("run-1"),
      llmParallelToolCalls("run-1", [
        { toolCallId: "tc-a", toolName: "files__read" },
        { toolCallId: "tc-b", toolName: "files__read" },
      ]),
      toolStart("run-1", "tc-a", "files__read"),
      toolDone("run-1", "tc-a", "files__read", "content A"),
      // tc-b never executed
      runDone("run-1"),
    ];
    const messages = reconstructMessages(events);

    // user + assistant (with only tc-a) + tool result for tc-a
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe("assistant");
    const assistantContent = messages[1]!.content as Array<{ type: string; toolCallId?: string }>;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]!.toolCallId).toBe("tc-a");

    expect(messages[2]!.role).toBe("tool");
    const toolContent = messages[2]!.content as Array<{ type: string; toolCallId?: string }>;
    expect(toolContent[0]!.toolCallId).toBe("tc-a");
  });

  it("preserves text parts from LLM response even when tool calls are dropped", () => {
    // An LLM response can have both text and tool calls. If the tool calls
    // are unexecuted, the text should still be preserved.
    const events: ConversationEvent[] = [
      userMessage("Read files"),
      runStart("run-1"),
      // LLM response with text + tool calls
      {
        ts: ts(2),
        type: "llm.response",
        runId: "run-1",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: "Let me read those files for you." },
          { type: "tool-call", toolCallId: "tc-1", toolName: "files__read", input: {} },
          { type: "tool-call", toolCallId: "tc-2", toolName: "files__read", input: {} },
        ],
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        llmMs: 500,
      } as LlmResponseEvent,
      // Run ends without executing tools
      { ts: ts(5), type: "run.done", runId: "run-1", stopReason: "token_budget", totalMs: 1000 } as RunDoneEvent,
    ];
    const messages = reconstructMessages(events);

    // user + assistant text (tool calls dropped)
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("assistant");
    const content = messages[1]!.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toBe("Let me read those files for you.");
  });
});

describe("deriveUsageMetrics", () => {
  it("returns zeroes for empty events", () => {
    const metrics = deriveUsageMetrics([]);
    expect(metrics).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      lastModel: null,
    });
  });

  it("sums tokens across all llm.response events", () => {
    const events: ConversationEvent[] = [
      userMessage("Hello"),
      runStart("run-1"),
      llmText("run-1", "Hi", { inputTokens: 100, outputTokens: 50 }),
      runDone("run-1"),
      userMessage("More"),
      runStart("run-2"),
      llmText("run-2", "Sure", { inputTokens: 200, outputTokens: 75 }),
      runDone("run-2"),
    ];
    const metrics = deriveUsageMetrics(events);
    expect(metrics.totalInputTokens).toBe(300);
    expect(metrics.totalOutputTokens).toBe(125);
    expect(metrics.lastModel).toBe("claude-sonnet-4-5-20250929");
  });

  it("computes cost from model catalog", () => {
    const events: ConversationEvent[] = [
      runStart("run-1"),
      llmText("run-1", "text", { inputTokens: 1000, outputTokens: 500 }),
      runDone("run-1"),
    ];
    const metrics = deriveUsageMetrics(events);
    expect(typeof metrics.totalCostUsd).toBe("number");
    expect(metrics.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it("tracks the last model used", () => {
    const events: ConversationEvent[] = [
      runStart("run-1", "claude-sonnet-4-5-20250929"),
      llmText("run-1", "a", { model: "claude-sonnet-4-5-20250929" }),
      runDone("run-1"),
      runStart("run-2", "gpt-4o"),
      llmText("run-2", "b", { model: "gpt-4o" }),
      runDone("run-2"),
    ];
    const metrics = deriveUsageMetrics(events);
    expect(metrics.lastModel).toBe("gpt-4o");
  });

  it("ignores non-llm events", () => {
    const events: ConversationEvent[] = [
      userMessage("Hello"),
      runStart("run-1"),
      toolStart("run-1", "tc-1", "tool"),
      toolDone("run-1", "tc-1", "tool", "output"),
      runDone("run-1"),
    ];
    const metrics = deriveUsageMetrics(events);
    expect(metrics.totalInputTokens).toBe(0);
    expect(metrics.totalOutputTokens).toBe(0);
    expect(metrics.lastModel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Structural invariant: reconstructed messages must satisfy Claude API rules
// ---------------------------------------------------------------------------

/**
 * Validate that a reconstructed message array satisfies the Claude API's
 * structural constraints. These invariants must hold regardless of what
 * events are fed into the reconstructor.
 *
 * Rules:
 * 1. Every tool-result message must be preceded (within the same run block)
 *    by an assistant message containing the matching tool-call.
 * 2. No assistant message should have tool-call parts without corresponding
 *    tool-result messages following it.
 * 3. Messages should alternate between user/tool and assistant roles
 *    (consecutive same-role messages are OK for tool results after assistant).
 */
function assertValidMessageStructure(messages: ReturnType<typeof reconstructMessages>) {
  // Collect all tool-call IDs from assistant messages and tool-result IDs from tool messages
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-call" && "toolCallId" in part) {
          toolCallIds.add(part.toolCallId as string);
        }
      }
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-result" && "toolCallId" in part) {
          toolResultIds.add(part.toolCallId as string);
        }
      }
    }
  }

  // Every tool-result must have a matching tool-call
  for (const resultId of toolResultIds) {
    expect(toolCallIds.has(resultId)).toBe(true);
  }

  // Every tool-call must have a matching tool-result (no dangling tool_use blocks)
  for (const callId of toolCallIds) {
    expect(toolResultIds.has(callId)).toBe(true);
  }

  // Every tool message must appear after its corresponding assistant message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (!("type" in part) || part.type !== "tool-result" || !("toolCallId" in part)) continue;
      const targetId = part.toolCallId as string;

      // Find the assistant message with this tool-call — it must be at index < i
      let found = false;
      for (let j = 0; j < i; j++) {
        const prev = messages[j]!;
        if (prev.role !== "assistant" || !Array.isArray(prev.content)) continue;
        if (prev.content.some((p) => "toolCallId" in p && p.toolCallId === targetId)) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
  }
}

describe("reconstructMessages structural invariants", () => {
  it("simple tool call round-trip", () => {
    const events: ConversationEvent[] = [
      userMessage("Go"),
      runStart("r1"),
      llmToolCall("r1", "tc1", "tool_a"),
      toolStart("r1", "tc1", "tool_a"),
      toolDone("r1", "tc1", "tool_a", "result"),
      llmText("r1", "Done"),
      runDone("r1"),
    ];
    assertValidMessageStructure(reconstructMessages(events));
  });

  it("parallel tool calls (4 concurrent)", () => {
    const events: ConversationEvent[] = [
      userMessage("Read files"),
      runStart("r1"),
      llmParallelToolCalls("r1", [
        { toolCallId: "a", toolName: "read" },
        { toolCallId: "b", toolName: "read" },
        { toolCallId: "c", toolName: "read" },
        { toolCallId: "d", toolName: "read" },
      ]),
      toolStart("r1", "a", "read"), toolDone("r1", "a", "read", "A"),
      toolStart("r1", "b", "read"), toolDone("r1", "b", "read", "B"),
      toolStart("r1", "c", "read"), toolDone("r1", "c", "read", "C"),
      toolStart("r1", "d", "read"), toolDone("r1", "d", "read", "D"),
      llmText("r1", "Read all 4"),
      runDone("r1"),
    ];
    assertValidMessageStructure(reconstructMessages(events));
  });

  it("multiple runs with parallel calls across turns", () => {
    const events: ConversationEvent[] = [
      userMessage("First"),
      runStart("r1"),
      llmParallelToolCalls("r1", [
        { toolCallId: "a1", toolName: "search" },
        { toolCallId: "a2", toolName: "search" },
      ]),
      toolStart("r1", "a1", "search"), toolDone("r1", "a1", "search", "x"),
      toolStart("r1", "a2", "search"), toolDone("r1", "a2", "search", "y"),
      llmText("r1", "Found stuff"),
      runDone("r1"),
      userMessage("Now do more"),
      runStart("r2"),
      llmParallelToolCalls("r2", [
        { toolCallId: "b1", toolName: "write" },
        { toolCallId: "b2", toolName: "write" },
        { toolCallId: "b3", toolName: "write" },
      ]),
      toolStart("r2", "b1", "write"), toolDone("r2", "b1", "write", "ok"),
      toolStart("r2", "b2", "write"), toolDone("r2", "b2", "write", "ok"),
      toolStart("r2", "b3", "write"), toolDone("r2", "b3", "write", "ok"),
      llmText("r2", "All written"),
      runDone("r2"),
    ];
    assertValidMessageStructure(reconstructMessages(events));
  });

  it("incomplete run (no run.done) with partial tool execution", () => {
    const events: ConversationEvent[] = [
      userMessage("Go"),
      runStart("r1"),
      llmParallelToolCalls("r1", [
        { toolCallId: "a", toolName: "read" },
        { toolCallId: "b", toolName: "read" },
      ]),
      toolStart("r1", "a", "read"),
      toolDone("r1", "a", "read", "A"),
      // b never executed, no run.done
    ];
    assertValidMessageStructure(reconstructMessages(events));
  });

  it("run error after partial tool execution", () => {
    const events: ConversationEvent[] = [
      userMessage("Go"),
      runStart("r1"),
      llmParallelToolCalls("r1", [
        { toolCallId: "a", toolName: "read" },
        { toolCallId: "b", toolName: "read" },
        { toolCallId: "c", toolName: "read" },
      ]),
      toolStart("r1", "a", "read"), toolDone("r1", "a", "read", "A"),
      // b and c never ran
      runError("r1", "API error"),
    ];
    assertValidMessageStructure(reconstructMessages(events));
  });

  it("mixed text + tool calls where tools are unexecuted", () => {
    const events: ConversationEvent[] = [
      userMessage("Go"),
      runStart("r1"),
      // LLM says something and requests tools, but run ends before execution
      {
        ts: ts(2),
        type: "llm.response",
        runId: "r1",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: "I'll read the files now." },
          { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
          { type: "tool-call", toolCallId: "tc2", toolName: "read", input: {} },
        ],
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        llmMs: 500,
      } as LlmResponseEvent,
      runDone("r1"),
    ];
    const messages = reconstructMessages(events);
    assertValidMessageStructure(messages);

    // Text should be preserved even though tools were dropped
    const textMsg = messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) &&
        m.content.some((p) => "type" in p && p.type === "text"),
    );
    expect(textMsg).toBeDefined();
  });
});
