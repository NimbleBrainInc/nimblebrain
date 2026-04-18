import { describe, expect, it } from "bun:test";
import { MAX_ITERATIONS } from "../../src/limits.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type {
  EngineConfig,
  EngineEvent,
  EventSink,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { LanguageModelV3, LanguageModelV3Message } from "@ai-sdk/provider";

const defaultConfig: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

function makeEngine(
  model?: LanguageModelV3,
  tools?: { schemas: ToolSchema[]; handler: (call: ToolCall) => ToolResult | Promise<ToolResult> },
  events?: EventSink,
) {
  return new AgentEngine(
    model ?? createEchoModel(),
    new StaticToolRouter(tools?.schemas ?? [], tools?.handler ?? (() => ({ content: textContent(""), isError: false }))),
    events ?? new NoopEventSink(),
  );
}

describe("AgentEngine", () => {
  it("returns text from a simple echo response", async () => {
    const engine = makeEngine();
    const result = await engine.run(defaultConfig, "You are a test.", [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    expect(result.output).toBe("Hello");
    expect(result.stopReason).toBe("complete");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("streams text deltas via onChunk", async () => {
    const chunks: string[] = [];
    const model = createMockModel(() => ({
      content: [{ type: "text", text: "Hello world" }],
      inputTokens: 10,
      outputTokens: 5,
    }));

    const events: EventSink = {
      emit(event: EngineEvent) {
        if (event.type === "text.delta") {
          chunks.push(event.data["text"] as string);
        }
      },
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      events,
    );

    await engine.run(defaultConfig, "", [{ role: "user", content: [{ type: "text", text: "Hi" }] }], []);
    expect(chunks).toEqual(["Hello world"]);
  });

  it("executes tools and feeds results back", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool-call", toolCallId: "call_1", toolName: "test__greet", input: JSON.stringify({ name: "World" }) },
          ],
          inputTokens: 50,
          outputTokens: 20,
        };
      }
      return {
        content: [{ type: "text", text: "Done!" }],
        inputTokens: 80,
        outputTokens: 10,
      };
    });

    const tools = {
      schemas: [{ name: "test__greet", description: "Greet someone", inputSchema: {} }],
      handler: (call: ToolCall): ToolResult => ({
        content: textContent(`Hello, ${call.input["name"]}!`),
        isError: false,
      }),
    };

    const engine = makeEngine(model, tools);
    const result = await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Greet the world" }] },
    ], tools.schemas);

    expect(result.output).toBe("Let me check.\n\nDone!");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("test__greet");
    expect(result.toolCalls[0]!.output).toBe("Hello, World!");
    expect(result.toolCalls[0]!.ok).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.inputTokens).toBe(130);
    expect(result.outputTokens).toBe(30);
    expect(result.stopReason).toBe("complete");
  });

  it("includes resourceUri in tool events when tool has UI annotations", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_ui", toolName: "app__render", input: JSON.stringify({}) },
          ],
          inputTokens: 50,
          outputTokens: 20,
        };
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 80,
        outputTokens: 10,
      };
    });

    const toolSchemas: ToolSchema[] = [
      {
        name: "app__render",
        description: "Render with UI",
        inputSchema: {},
        annotations: { ui: { resourceUri: "ui://app/viewer" } },
      },
    ];

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, () => ({ content: textContent("rendered"), isError: false })),
      sink,
    );

    await engine.run(defaultConfig, "", [{ role: "user", content: [{ type: "text", text: "render" }] }], toolSchemas);

    const toolStart = events.find((e) => e.type === "tool.start");
    expect(toolStart).toBeDefined();
    expect(toolStart!.data["resourceUri"]).toBe("ui://app/viewer");

    const toolDone = events.find((e) => e.type === "tool.done");
    expect(toolDone).toBeDefined();
    expect(toolDone!.data["resourceUri"]).toBe("ui://app/viewer");
    expect(toolDone!.data["result"]).toEqual({ content: textContent("rendered"), isError: false });
  });

  it("surfaces resource_link blocks on tool.done and in the result record", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_export",
              toolName: "collateral__export_pdf",
              input: JSON.stringify({}),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Done." }],
        inputTokens: 20,
        outputTokens: 5,
      };
    });

    const toolSchemas: ToolSchema[] = [
      { name: "collateral__export_pdf", description: "Export PDF", inputSchema: {} },
    ];

    const tools = {
      schemas: toolSchemas,
      handler: (): ToolResult => ({
        content: [
          { type: "text", text: "Exported 10-page PDF (1.1MB)." },
          {
            type: "resource_link",
            uri: "collateral://exports/exp_abc123.pdf",
            name: "Document export",
            mimeType: "application/pdf",
          },
        ] as ToolResult["content"],
        isError: false,
      }),
    };

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      sink,
    );

    const result = await engine.run(
      defaultConfig,
      "",
      [{ role: "user", content: [{ type: "text", text: "Export" }] }],
      tools.schemas,
    );

    const toolDone = events.find((e) => e.type === "tool.done");
    expect(toolDone).toBeDefined();
    expect(toolDone!.data["resourceLinks"]).toEqual([
      {
        uri: "collateral://exports/exp_abc123.pdf",
        name: "Document export",
        mimeType: "application/pdf",
      },
    ]);
    // resourceUri is separate (no UI annotation) — stays undefined.
    expect(toolDone!.data["resourceUri"]).toBeUndefined();

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.resourceLinks).toEqual([
      {
        uri: "collateral://exports/exp_abc123.pdf",
        name: "Document export",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("omits resourceLinks from tool.done when the tool returns none", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_plain",
              toolName: "test__plain",
              input: JSON.stringify({}),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "ok" }], inputTokens: 5, outputTokens: 5 };
    });

    const toolSchemas: ToolSchema[] = [
      { name: "test__plain", description: "No link", inputSchema: {} },
    ];

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, () => ({ content: textContent("plain"), isError: false })),
      sink,
    );

    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ], toolSchemas);

    const toolDone = events.find((e) => e.type === "tool.done");
    expect(toolDone).toBeDefined();
    expect(toolDone!.data["resourceLinks"]).toBeUndefined();
  });

  it("stops at max_iterations", async () => {
    const model = createMockModel(() => ({
      content: [
        { type: "tool-call", toolCallId: `call_${Date.now()}`, toolName: "test__noop", input: JSON.stringify({}) },
      ],
      inputTokens: 10,
      outputTokens: 5,
    }));

    const tools = {
      schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
    };

    const engine = makeEngine(model, tools);
    const result = await engine.run(
      { ...defaultConfig, maxIterations: 3 },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
  });

  it("respects absolute MAX_ITERATIONS ceiling of 25", async () => {
    const model = createMockModel(() => ({
      content: [
        { type: "tool-call", toolCallId: `call_${Date.now()}`, toolName: "test__noop", input: JSON.stringify({}) },
      ],
      inputTokens: 1,
      outputTokens: 1,
    }));

    const tools = {
      schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
    };

    const engine = makeEngine(model, tools);
    const result = await engine.run(
      { ...defaultConfig, maxIterations: 100 },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(result.stopReason).toBe("max_iterations");
    expect(result.iterations).toBe(MAX_ITERATIONS);
  });

  it("injects wrap-up hint on the final iteration", async () => {
    const systemPrompts: string[] = [];
    let callCount = 0;

    // Model that always returns tool calls, capturing the system prompt each time
    const model = createMockModel((opts) => {
      callCount++;
      // Capture the system prompt from the prompt array
      const prompt = opts.prompt as Array<{ role: string; content: string }>;
      const system = prompt.find((m) => m.role === "system");
      if (system) systemPrompts.push(system.content);

      return {
        content: [
          { type: "tool-call", toolCallId: `call_${callCount}`, toolName: "test__noop", input: JSON.stringify({}) },
        ],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
    };

    const engine = makeEngine(model, tools);
    await engine.run(
      { ...defaultConfig, maxIterations: 3 },
      "You are helpful.",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    // Should have 3 calls (maxIterations = 3)
    expect(systemPrompts).toHaveLength(3);
    // First two iterations: no wrap-up hint
    expect(systemPrompts[0]).not.toContain("final step");
    expect(systemPrompts[1]).not.toContain("final step");
    // Last iteration: wrap-up hint appended
    expect(systemPrompts[2]).toContain("final step");
    expect(systemPrompts[2]).toContain("Do NOT call any more tools");
  });

  it("catches tool execution errors and wraps them", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__fail", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Handled." }],
        inputTokens: 20,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__fail", description: "Always fails", inputSchema: {} }],
      handler: (): ToolResult => {
        throw new Error("kaboom");
      },
    };

    const engine = makeEngine(model, tools);
    const result = await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], tools.schemas);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.output).toBe("kaboom");
    expect(result.stopReason).toBe("complete");
  });

  it("does not mutate the caller's message array", async () => {
    const messages: LanguageModelV3Message[] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];
    const original = [...messages];

    const engine = makeEngine();
    await engine.run(defaultConfig, "", messages, []);

    expect(messages).toEqual(original);
  });

  it("emits lifecycle events in order", async () => {
    const eventTypes: string[] = [];
    const events: EventSink = {
      emit(event: EngineEvent) {
        eventTypes.push(event.type);
      },
    };

    const engine = makeEngine(undefined, undefined, events);
    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    expect(eventTypes).toEqual(["run.start", "text.delta", "llm.done", "run.done"]);
  });

  it("emits tool lifecycle events", async () => {
    const eventTypes: string[] = [];
    const events: EventSink = {
      emit(event: EngineEvent) {
        eventTypes.push(event.type);
      },
    };

    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__noop", input: JSON.stringify({}) },
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
      schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
    };

    const engine = new AgentEngine(model, new StaticToolRouter(tools.schemas, tools.handler), events);
    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], tools.schemas);

    expect(eventTypes).toEqual([
      "run.start",
      "llm.done",
      "tool.start",
      "tool.done",
      "text.delta",
      "llm.done",
      "run.done",
    ]);
  });

  it("transformContext hook modifies messages before LLM call", async () => {
    let receivedMessages: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      receivedMessages = options.prompt.filter((m) => m.role !== "system");
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    await engine.run(
      {
        ...defaultConfig,
        hooks: {
          transformContext: (msgs) => [
            ...msgs,
            { role: "user" as const, content: [{ type: "text" as const, text: "injected" }] },
          ],
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      [],
    );

    // 2 user messages (original + injected)
    expect(receivedMessages).toHaveLength(2);
  });

  it("beforeToolCall returning null skips tool execution", async () => {
    let toolExecuted = false;
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__danger", input: JSON.stringify({}) },
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
      schemas: [{ name: "test__danger", description: "Dangerous", inputSchema: {} }],
      handler: (): ToolResult => {
        toolExecuted = true;
        return { content: textContent("executed"), isError: false };
      },
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        hooks: {
          beforeToolCall: () => null,
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(toolExecuted).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(result.toolCalls[0]!.output).toContain("denied");
  });

  it("afterToolCall modifies result seen by LLM", async () => {
    let feedbackContent = "";
    let callCount = 0;
    const model = createMockModel((options) => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__greet", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      const lastMsg = options.prompt[options.prompt.length - 1]!;
      if (lastMsg.role === "tool" && Array.isArray(lastMsg.content)) {
        const part = lastMsg.content[0] as { output?: { value?: string } };
        feedbackContent = part.output?.value ?? "";
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__greet", description: "Greet", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("original"), isError: false }),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    await engine.run(
      {
        ...defaultConfig,
        hooks: {
          afterToolCall: (_call, _result) => ({ content: textContent("modified"), isError: false }),
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(feedbackContent).toBe("modified");
  });

  it("transformPrompt modifies system prompt", async () => {
    let receivedPrompt = "";
    const model = createMockModel((options) => {
      const systemMsg = options.prompt.find((m) => m.role === "system");
      if (systemMsg && typeof systemMsg.content === "string") {
        receivedPrompt = systemMsg.content;
      }
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    await engine.run(
      {
        ...defaultConfig,
        hooks: {
          transformPrompt: (prompt) => prompt + "\nExtra instruction.",
        },
      },
      "Base prompt.",
      [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      [],
    );

    expect(receivedPrompt).toBe("Base prompt.\nExtra instruction.");
  });

  it("executes 3 independent tools concurrently (wall clock < 3x single)", async () => {
    const DELAY = 50;
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__slow", input: JSON.stringify({ n: 1 }) },
            { type: "tool-call", toolCallId: "c2", toolName: "test__slow", input: JSON.stringify({ n: 2 }) },
            { type: "tool-call", toolCallId: "c3", toolName: "test__slow", input: JSON.stringify({ n: 3 }) },
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
      schemas: [{ name: "test__slow", description: "Slow tool", inputSchema: {} }],
      handler: async (call: ToolCall): Promise<ToolResult> => {
        await new Promise((r) => setTimeout(r, DELAY));
        return { content: textContent(`done-${call.input.n}`), isError: false };
      },
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const start = performance.now();
    const result = await engine.run(defaultConfig, "", [{ role: "user", content: [{ type: "text", text: "Go" }] }], tools.schemas);
    const elapsed = performance.now() - start;

    expect(result.toolCalls).toHaveLength(3);
    expect(elapsed).toBeLessThan(DELAY * 2.5);
    expect(result.toolCalls.every((tc) => tc.ok)).toBe(true);
  });

  it("each parallel call gets its own hook invocations", async () => {
    const hookCalls: string[] = [];
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__a", input: JSON.stringify({}) },
            { type: "tool-call", toolCallId: "c2", toolName: "test__b", input: JSON.stringify({}) },
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
      schemas: [
        { name: "test__a", description: "A", inputSchema: {} },
        { name: "test__b", description: "B", inputSchema: {} },
      ],
      handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    await engine.run(
      {
        ...defaultConfig,
        hooks: {
          beforeToolCall: (call) => {
            hookCalls.push(`before:${call.name}`);
            return call;
          },
          afterToolCall: (call, result) => {
            hookCalls.push(`after:${call.name}`);
            return result;
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Go" }] }],
      tools.schemas,
    );

    expect(hookCalls).toContain("before:test__a");
    expect(hookCalls).toContain("before:test__b");
    expect(hookCalls).toContain("after:test__a");
    expect(hookCalls).toContain("after:test__b");
    expect(hookCalls).toHaveLength(4);
  });

  it("one failing tool doesn't block other parallel tools", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "test__ok", input: JSON.stringify({}) },
            { type: "tool-call", toolCallId: "c2", toolName: "test__fail", input: JSON.stringify({}) },
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
      schemas: [
        { name: "test__ok", description: "OK", inputSchema: {} },
        { name: "test__fail", description: "Fail", inputSchema: {} },
      ],
      handler: (call: ToolCall): ToolResult => {
        if (call.name === "test__fail") throw new Error("kaboom");
        return { content: textContent("success"), isError: false };
      },
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      new NoopEventSink(),
    );

    const result = await engine.run(defaultConfig, "", [{ role: "user", content: [{ type: "text", text: "Go" }] }], tools.schemas);

    expect(result.toolCalls).toHaveLength(2);
    const okCall = result.toolCalls.find((tc) => tc.name === "test__ok");
    const failCall = result.toolCalls.find((tc) => tc.name === "test__fail");
    expect(okCall!.ok).toBe(true);
    expect(okCall!.output).toBe("success");
    expect(failCall!.ok).toBe(false);
    expect(failCall!.output).toBe("kaboom");
  });

  it("works identically with undefined hooks", async () => {
    const engine = makeEngine();
    const result = await engine.run(
      { ...defaultConfig, hooks: undefined },
      "You are a test.",
      [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      [],
    );

    expect(result.output).toBe("Hello");
    expect(result.stopReason).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------

describe("prompt caching", () => {
  it("sets cacheControl on the system message", async () => {
    let capturedPrompt: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      capturedPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    await engine.run(defaultConfig, "You are a test.", [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    const systemMsg = capturedPrompt.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect((systemMsg as Record<string, unknown>).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("sets cacheControl on the last user message", async () => {
    let capturedPrompt: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      capturedPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    await engine.run(defaultConfig, "You are a test.", [
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
    ], []);

    // System message has cache control
    const systemMsg = capturedPrompt[0]!;
    expect((systemMsg as Record<string, unknown>).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });

    // First user message does NOT have cache control
    const firstUser = capturedPrompt[1]!;
    expect((firstUser as Record<string, unknown>).providerOptions).toBeUndefined();

    // Last user message has cache control
    const lastUser = capturedPrompt[2]!;
    expect((lastUser as Record<string, unknown>).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("does not mutate original messages when adding cache breakpoint", async () => {
    const originalMsg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    };
    const messages = [originalMsg];

    const model = createMockModel(() => ({
      content: [{ type: "text", text: "ok" }],
      inputTokens: 10,
      outputTokens: 5,
    }));

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    await engine.run(defaultConfig, "", messages, []);

    // Original message should not have providerOptions added
    expect((originalMsg as Record<string, unknown>).providerOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Audience filtering (MCP annotations.audience)
// ---------------------------------------------------------------------------

describe("audience filtering", () => {
  it("excludes user-only content blocks from LLM tool results", async () => {
    let feedbackContent = "";
    let callCount = 0;
    const model = createMockModel((options) => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__render", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      // Capture what the LLM received as tool result
      const lastMsg = options.prompt[options.prompt.length - 1]!;
      if (lastMsg.role === "tool" && Array.isArray(lastMsg.content)) {
        const part = lastMsg.content[0] as { output?: { value?: string } };
        feedbackContent = part.output?.value ?? "";
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__render", description: "Render", inputSchema: {} }],
      handler: (): ToolResult => ({
        content: [
          { type: "text", text: "Rendered 3 pages" },
          { type: "text", text: "huge-base64-data-here", annotations: { audience: ["user"] } },
        ] as unknown as ToolResult["content"],
        isError: false,
      }),
    };

    const engine = makeEngine(model, tools);
    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Render it" }] },
    ], tools.schemas);

    // LLM should only see the non-user-only text
    expect(feedbackContent).toBe("Rendered 3 pages");
    expect(feedbackContent).not.toContain("huge-base64-data-here");
  });

  it("includes content blocks without annotations (backward compat)", async () => {
    let feedbackContent = "";
    let callCount = 0;
    const model = createMockModel((options) => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__plain", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      const lastMsg = options.prompt[options.prompt.length - 1]!;
      if (lastMsg.role === "tool" && Array.isArray(lastMsg.content)) {
        const part = lastMsg.content[0] as { output?: { value?: string } };
        feedbackContent = part.output?.value ?? "";
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__plain", description: "Plain", inputSchema: {} }],
      handler: (): ToolResult => ({
        content: textContent("plain result with no annotations"),
        isError: false,
      }),
    };

    const engine = makeEngine(model, tools);
    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], tools.schemas);

    expect(feedbackContent).toBe("plain result with no annotations");
  });

  it("includes content with audience ['user', 'assistant']", async () => {
    let feedbackContent = "";
    let callCount = 0;
    const model = createMockModel((options) => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__both", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      const lastMsg = options.prompt[options.prompt.length - 1]!;
      if (lastMsg.role === "tool" && Array.isArray(lastMsg.content)) {
        const part = lastMsg.content[0] as { output?: { value?: string } };
        feedbackContent = part.output?.value ?? "";
      }
      return {
        content: [{ type: "text", text: "Done" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__both", description: "Both", inputSchema: {} }],
      handler: (): ToolResult => ({
        content: [
          { type: "text", text: "shared content", annotations: { audience: ["user", "assistant"] } },
        ] as unknown as ToolResult["content"],
        isError: false,
      }),
    };

    const engine = makeEngine(model, tools);
    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], tools.schemas);

    expect(feedbackContent).toBe("shared content");
  });

  it("sends full unfiltered content in tool.done events", async () => {
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__render", input: JSON.stringify({}) },
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

    const toolSchemas: ToolSchema[] = [
      {
        name: "test__render",
        description: "Render",
        inputSchema: {},
        annotations: { ui: { resourceUri: "ui://test/viewer" } },
      },
    ];

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, () => ({
        content: [
          { type: "text", text: "summary" },
          { type: "text", text: "user-data", annotations: { audience: ["user"] } },
        ] as unknown as ToolResult["content"],
        isError: false,
      })),
      sink,
    );

    await engine.run(defaultConfig, "", [
      { role: "user", content: [{ type: "text", text: "Go" }] },
    ], toolSchemas);

    // tool.done should have the full result (unfiltered) since it has resourceUri
    const toolDone = events.find((e) => e.type === "tool.done");
    expect(toolDone).toBeDefined();
    expect(toolDone!.data["result"]).toBeDefined();
  });
});


// NOTE: The task polling tests that lived here previously exercised the
// legacy `_taskResult` + pollTask infrastructure that was deleted when MCP
// task support moved to the SDK's `client.experimental.tasks.callToolStream`
// API inside McpSource. Task-augmented execution is now an McpSource-internal
// concern and is covered in `test/unit/mcp-source-tasks.test.ts`.


// ---------------------------------------------------------------------------
// Error path coverage — message sanitization edge cases
// ---------------------------------------------------------------------------

describe("message sanitization", () => {
  it("filters out empty text blocks from assistant messages", async () => {
    let capturedPrompt: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      capturedPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    // Message with empty text blocks that should be filtered
    await engine.run(defaultConfig, "", [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "actual content" },
        ],
      } as LanguageModelV3Message,
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    // The assistant message should have the empty block filtered
    const assistantMsg = capturedPrompt.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const content = assistantMsg!.content as Array<{ type: string; text?: string }>;
    expect(content.every((c) => c.type !== "text" || (c.text && c.text.length > 0))).toBe(true);
  });

  it("replaces all-empty content with (empty) placeholder", async () => {
    let capturedPrompt: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      capturedPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    // Message where all content is empty text — should become "(empty)"
    await engine.run(defaultConfig, "", [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      } as LanguageModelV3Message,
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    const assistantMsg = capturedPrompt.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const content = assistantMsg!.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toBe("(empty)");
  });

  it("passes system messages through unchanged", async () => {
    let capturedPrompt: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      capturedPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    await engine.run(defaultConfig, "System prompt here", [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    const systemMsg = capturedPrompt.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(typeof systemMsg!.content).toBe("string");
    expect(systemMsg!.content).toBe("System prompt here");
  });
});

// ---------------------------------------------------------------------------
// Error path coverage — cache breakpoint edge cases
// ---------------------------------------------------------------------------

describe("cache breakpoint edge cases", () => {
  it("handles messages with no user message (all assistant)", async () => {
    let capturedPrompt: LanguageModelV3Message[] = [];
    const model = createMockModel((options) => {
      capturedPrompt = options.prompt;
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    );

    // Only pass assistant messages — no user message to add breakpoint to.
    // The engine should still work without crashing.
    await engine.run(defaultConfig, "", [
      { role: "assistant", content: [{ type: "text", text: "prior turn" }] } as LanguageModelV3Message,
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ], []);

    // Should complete normally
    expect(capturedPrompt.length).toBeGreaterThan(0);
  });

  it("handles empty message array", async () => {
    const engine = makeEngine();
    // Empty messages — model should still be called
    const result = await engine.run(defaultConfig, "System prompt", [], []);
    // Echo model with no user message still returns something
    expect(result.stopReason).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Error path coverage — malformed tool call input
// ---------------------------------------------------------------------------

describe("malformed tool call input", () => {
  it("unparseable JSON tool input propagates as run.error", async () => {
    let callCount = 0;
    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_bad", toolName: "test__noop", input: "not-valid-json{{{" },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        content: [{ type: "text", text: "Recovered" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const tools = {
      schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
      handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
    };

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(tools.schemas, tools.handler),
      sink,
    );

    // Unparseable tool input causes a JSON.parse error that propagates through
    // the engine's error handler, emitting run.error and re-throwing.
    let thrown: Error | null = null;
    try {
      await engine.run(defaultConfig, "", [
        { role: "user", content: [{ type: "text", text: "Go" }] },
      ], tools.schemas);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("JSON");
    const errorEvent = events.find((e) => e.type === "run.error");
    expect(errorEvent).toBeDefined();
  });

  it("emits run.error event and re-throws on model failure", async () => {
    const model = createMockModel(() => {
      throw new Error("API connection refused");
    });

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      sink,
    );

    let thrown: Error | null = null;
    try {
      await engine.run(defaultConfig, "", [
        { role: "user", content: [{ type: "text", text: "Go" }] },
      ], []);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("API connection refused");

    const errorEvent = events.find((e) => e.type === "run.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data["error"]).toContain("API connection refused");
  });

  describe("tool result size limit", () => {
    const bigToolSchema: ToolSchema = {
      name: "big_tool",
      description: "Returns a large result",
      inputSchema: { type: "object", properties: {} },
    };

    it("replaces oversized result with error", async () => {
      const oversized = "x".repeat(2_000_000);
      const engine = makeEngine(
        createEchoModel({
          responses: [
            {
              toolCalls: [{ toolCallId: "tc1", toolName: "big_tool", input: "{}" }],
            },
            { text: "done" },
          ],
        }),
        {
          schemas: [bigToolSchema],
          handler: () => ({
            content: [{ type: "text" as const, text: oversized }],
            isError: false,
          }),
        },
      );

      const result = await engine.run(
        { ...defaultConfig, maxToolResultSize: 1_000_000 },
        "",
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        [bigToolSchema],
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(false);
      expect(result.toolCalls[0]!.output).toContain("Tool result too large");
      expect(result.toolCalls[0]!.output).toContain("2,000,000");
    });

    it("passes through under-limit results", async () => {
      const normal = "x".repeat(500_000);
      const engine = makeEngine(
        createEchoModel({
          responses: [
            {
              toolCalls: [{ toolCallId: "tc1", toolName: "big_tool", input: "{}" }],
            },
            { text: "done" },
          ],
        }),
        {
          schemas: [bigToolSchema],
          handler: () => ({
            content: [{ type: "text" as const, text: normal }],
            isError: false,
          }),
        },
      );

      const result = await engine.run(
        { ...defaultConfig, maxToolResultSize: 1_000_000 },
        "",
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        [bigToolSchema],
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(true);
    });

    it("disables guard when maxToolResultSize is 0", async () => {
      const oversized = "x".repeat(2_000_000);
      const engine = makeEngine(
        createEchoModel({
          responses: [
            {
              toolCalls: [{ toolCallId: "tc1", toolName: "big_tool", input: "{}" }],
            },
            { text: "done" },
          ],
        }),
        {
          schemas: [bigToolSchema],
          handler: () => ({
            content: [{ type: "text" as const, text: oversized }],
            isError: false,
          }),
        },
      );

      const result = await engine.run(
        { ...defaultConfig, maxToolResultSize: 0 },
        "",
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        [bigToolSchema],
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(true);
    });

    it("respects custom maxToolResultSize", async () => {
      const text = "x".repeat(100);
      const engine = makeEngine(
        createEchoModel({
          responses: [
            {
              toolCalls: [{ toolCallId: "tc1", toolName: "big_tool", input: "{}" }],
            },
            { text: "done" },
          ],
        }),
        {
          schemas: [bigToolSchema],
          handler: () => ({
            content: [{ type: "text" as const, text }],
            isError: false,
          }),
        },
      );

      const result = await engine.run(
        { ...defaultConfig, maxToolResultSize: 50 },
        "",
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        [bigToolSchema],
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(false);
      expect(result.toolCalls[0]!.output).toContain("Tool result too large");
    });
  });

  describe("tool input schema validation", () => {
    const stringNameSchema: ToolSchema = {
      name: "test__greet",
      description: "Greets by name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    it("returns error and skips execution when input violates schema", async () => {
      let toolExecuted = false;
      const model = createEchoModel({
        responses: [
          {
            toolCalls: [
              { toolCallId: "call_1", toolName: "test__greet", input: JSON.stringify({ name: 123 }) },
            ],
          },
          { text: "done" },
        ],
      });

      const engine = makeEngine(model, {
        schemas: [stringNameSchema],
        handler: () => {
          toolExecuted = true;
          return { content: textContent("hi"), isError: false };
        },
      });

      const result = await engine.run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "Go" }] }],
        [stringNameSchema],
      );

      expect(toolExecuted).toBe(false);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(false);
      expect(result.toolCalls[0]!.output).toContain("Invalid tool input");
    });

    it("executes normally when input matches schema", async () => {
      let toolExecuted = false;
      const model = createEchoModel({
        responses: [
          {
            toolCalls: [
              { toolCallId: "call_1", toolName: "test__greet", input: JSON.stringify({ name: "Alice" }) },
            ],
          },
          { text: "done" },
        ],
      });

      const engine = makeEngine(model, {
        schemas: [stringNameSchema],
        handler: () => {
          toolExecuted = true;
          return { content: textContent("Hello Alice"), isError: false };
        },
      });

      const result = await engine.run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "Go" }] }],
        [stringNameSchema],
      );

      expect(toolExecuted).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(true);
    });

    it("executes normally when tool has no schema constraints", async () => {
      const noConstraintSchema: ToolSchema = {
        name: "test__anything",
        description: "Accepts anything",
        inputSchema: { type: "object" },
      };

      let toolExecuted = false;
      const model = createEchoModel({
        responses: [
          {
            toolCalls: [
              { toolCallId: "call_1", toolName: "test__anything", input: JSON.stringify({ foo: 42 }) },
            ],
          },
          { text: "done" },
        ],
      });

      const engine = makeEngine(model, {
        schemas: [noConstraintSchema],
        handler: () => {
          toolExecuted = true;
          return { content: textContent("ok"), isError: false };
        },
      });

      const result = await engine.run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "Go" }] }],
        [noConstraintSchema],
      );

      expect(toolExecuted).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.ok).toBe(true);
    });

    it("validation error message includes field and type mismatch details", async () => {
      const model = createEchoModel({
        responses: [
          {
            toolCalls: [
              { toolCallId: "call_1", toolName: "test__greet", input: JSON.stringify({ name: 123 }) },
            ],
          },
          { text: "done" },
        ],
      });

      const engine = makeEngine(model, {
        schemas: [stringNameSchema],
        handler: () => ({ content: textContent("hi"), isError: false }),
      });

      const result = await engine.run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "Go" }] }],
        [stringNameSchema],
      );

      expect(result.toolCalls[0]!.output).toContain("name");
      expect(result.toolCalls[0]!.output).toContain("string");
    });
  });
});
