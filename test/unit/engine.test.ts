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
  ToolPromotionControls,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import {
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../src/runtime/request-context.ts";
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
    expect(result.usage.inputTokens).toBe(130);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.stopReason).toBe("complete");
  });

  it("does not promote tools discovered by nb__search implicitly", async () => {
    let callCount = 0;
    const seenToolLists: string[][] = [];
    const model = createMockModel((options) => {
      callCount++;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      seenToolLists.push(toolNames);

      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_search",
              toolName: "nb__search",
              input: JSON.stringify({ scope: "tools", query: "newsapi" }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 2) {
        expect(toolNames).not.toContain("newsapi__get_top_headlines");
        return {
          content: [{ type: "text", text: "Done!" }],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
    });

    const toolSchemas: ToolSchema[] = [
      { name: "nb__search", description: "Search tools", inputSchema: { type: "object", properties: {} } },
      {
        name: "newsapi__get_top_headlines",
        description: "Get top headlines",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__search") {
          return {
            content: textContent(
              'Found 1 tool(s) for "newsapi":\n\n- **newsapi__get_top_headlines**: Get top news headlines by country and category.',
            ),
            structuredContent: {
              tools: [{ name: "newsapi__get_top_headlines" }],
            },
            isError: false,
          };
        }
        if (call.name === "newsapi__get_top_headlines") {
          return { content: textContent("headline results"), isError: false };
        }
        return { content: textContent(""), isError: false };
      }),
      new NoopEventSink(),
    );

    const result = await engine.run(
      defaultConfig,
      "",
      [{ role: "user", content: [{ type: "text", text: "Get me tech news" }] }],
      [toolSchemas[0]!],
    );

    expect(seenToolLists[0]).toEqual(["nb__search"]);
    expect(seenToolLists[1]).not.toContain("newsapi__get_top_headlines");
    expect(result.toolCalls.map((c) => c.name)).toEqual(["nb__search"]);
    expect(result.output).toBe("Done!");
  });

  it("nb__manage_tools add promotes a discovered tool for the next iteration", async () => {
    let callCount = 0;
    const seenToolLists: string[][] = [];
    const model = createMockModel((options) => {
      callCount++;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      seenToolLists.push(toolNames);

      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_search",
              toolName: "nb__search",
              input: JSON.stringify({ scope: "tools", query: "newsapi" }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 2) {
        expect(toolNames).not.toContain("newsapi__get_top_headlines");
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_manage",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["newsapi__get_top_headlines"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 3) {
        expect(toolNames).toContain("newsapi__get_top_headlines");
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_news",
              toolName: "newsapi__get_top_headlines",
              input: JSON.stringify({ country: "us" }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      return {
        content: [{ type: "text", text: "Done!" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const toolSchemas: ToolSchema[] = [
      { name: "nb__search", description: "Search tools", inputSchema: { type: "object", properties: {} } },
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      {
        name: "newsapi__get_top_headlines",
        description: "Get top headlines",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const events: EngineEvent[] = [];
    let activeControls: ToolPromotionControls | null = null;
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__search") {
          return {
            content: textContent("Found newsapi__get_top_headlines"),
            structuredContent: { tools: [{ name: "newsapi__get_top_headlines" }] },
            isError: false,
          };
        }
        if (call.name === "nb__manage_tools") {
          expect(activeControls).not.toBeNull();
          const add = (call.input.add as string[] | undefined) ?? [];
          const remove = (call.input.remove as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          const released = remove.map((n) => activeControls!.removeTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released },
            isError: false,
          };
        }
        if (call.name === "newsapi__get_top_headlines") {
          return { content: textContent("headline results"), isError: false };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Get me tech news" }] }],
      [toolSchemas[0]!, toolSchemas[1]!],
    );

    expect(seenToolLists[0]).toEqual(["nb__search", "nb__manage_tools"]);
    expect(seenToolLists[2]).toContain("newsapi__get_top_headlines");
    expect(result.toolCalls.map((c) => c.name)).toEqual([
      "nb__search",
      "nb__manage_tools",
      "newsapi__get_top_headlines",
    ]);
    expect(events.some((e) => e.type === "tool.promoted")).toBe(true);
  });

  it("nb__manage_tools combined add+remove patches in one call", async () => {
    let callCount = 0;
    const seenToolLists: string[][] = [];
    const model = createMockModel((options) => {
      callCount++;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      seenToolLists.push(toolNames);

      if (callCount === 1) {
        // Bootstrap: promote two tools so we can test removing one in the next call.
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_init",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["a__one", "b__two"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 2) {
        expect(toolNames).toContain("a__one");
        expect(toolNames).toContain("b__two");
        // Domain switch: drop a__one, add c__three, in one patch.
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_swap",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["c__three"], remove: ["a__one"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 3) {
        expect(toolNames).not.toContain("a__one");
        expect(toolNames).toContain("b__two");
        expect(toolNames).toContain("c__three");
        return {
          content: [{ type: "text", text: "Done!" }],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
    });

    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "a__one", description: "Tool A", inputSchema: { type: "object", properties: {} } },
      { name: "b__two", description: "Tool B", inputSchema: { type: "object", properties: {} } },
      { name: "c__three", description: "Tool C", inputSchema: { type: "object", properties: {} } },
    ];

    const events: EngineEvent[] = [];
    let activeControls: ToolPromotionControls | null = null;
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          expect(activeControls).not.toBeNull();
          const add = (call.input.add as string[] | undefined) ?? [];
          const remove = (call.input.remove as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          const released = remove.map((n) => activeControls!.removeTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Patch tools" }] }],
      [toolSchemas[0]!],
    );

    expect(result.toolCalls.map((c) => c.name)).toEqual(["nb__manage_tools", "nb__manage_tools"]);
    expect(events.filter((e) => e.type === "tool.promoted")).toHaveLength(3); // a__one, b__two, c__three
    expect(events.filter((e) => e.type === "tool.released")).toHaveLength(1); // a__one
  });

  it("nb__manage_tools rejects internal tools per-item without affecting other items", async () => {
    let callCount = 0;
    const seenToolLists: string[][] = [];
    const model = createMockModel((options) => {
      callCount++;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      seenToolLists.push(toolNames);

      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_mixed",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["app__public", "internal__secret"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 2) {
        expect(toolNames).toContain("app__public");
        expect(toolNames).not.toContain("internal__secret");
        return {
          content: [{ type: "text", text: "Done!" }],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
    });

    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      {
        name: "app__public",
        description: "Public tool",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "internal__secret",
        description: "Internal secret tool",
        inputSchema: { type: "object", properties: {} },
        annotations: { "ai.nimblebrain/internal": true },
      },
    ];

    const events: EngineEvent[] = [];
    let activeControls: ToolPromotionControls | null = null;
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          expect(activeControls).not.toBeNull();
          const add = (call.input.add as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released: [] },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Mixed batch" }] }],
      [toolSchemas[0]!],
    );

    const manageCall = result.toolCalls.find((c) => c.name === "nb__manage_tools");
    expect(manageCall).toBeDefined();
    // Per-item failure does not fail the whole call; structuredContent reports it.
    expect(manageCall?.ok).toBe(true);
    // Only the public tool was promoted; the internal one was rejected per-item.
    expect(events.filter((e) => e.type === "tool.promoted")).toHaveLength(1);
  });

  it("nb__manage_tools add rejects role/feature-ineligible tools per-item", async () => {
    let callCount = 0;
    const seenToolLists: string[][] = [];
    const model = createMockModel((options) => {
      callCount++;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      seenToolLists.push(toolNames);

      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_admin",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["nb__manage_users"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 2) {
        expect(toolNames).not.toContain("nb__manage_users");
        return {
          content: [{ type: "text", text: "Done!" }],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
    });

    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      {
        name: "nb__manage_users",
        description: "Manage users",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const events: EngineEvent[] = [];
    let activeControls: ToolPromotionControls | null = null;
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          expect(activeControls).not.toBeNull();
          const add = (call.input.add as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released: [] },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        toolPromotion: {
          isToolEligible: (tool) => tool.name !== "nb__manage_users",
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Try to promote admin tool" }] }],
      [toolSchemas[0]!],
    );

    expect(result.toolCalls.find((c) => c.name === "nb__manage_tools")).toBeDefined();
    expect(seenToolLists[1]).not.toContain("nb__manage_users");
    expect(events.some((e) => e.type === "tool.promoted")).toBe(false);
  });

  it("nb__manage_tools remove refuses system tools per-item", async () => {
    let callCount = 0;
    const seenToolLists: string[][] = [];
    const model = createMockModel((options) => {
      callCount++;
      const toolNames = (options.tools ?? []).map((t) => t.name);
      seenToolLists.push(toolNames);

      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_drop_search",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ remove: ["nb__search"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }

      if (callCount === 2) {
        expect(toolNames).toContain("nb__search");
        return {
          content: [{ type: "text", text: "Done!" }],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
    });

    const toolSchemas: ToolSchema[] = [
      { name: "nb__search", description: "Search tools", inputSchema: { type: "object", properties: {} } },
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
    ];

    const events: EngineEvent[] = [];
    let activeControls: ToolPromotionControls | null = null;
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          expect(activeControls).not.toBeNull();
          const remove = (call.input.remove as string[] | undefined) ?? [];
          const released = remove.map((n) => activeControls!.removeTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted: [], released },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    const result = await engine.run(
      {
        ...defaultConfig,
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Try to drop search" }] }],
      toolSchemas,
    );

    expect(result.toolCalls.find((c) => c.name === "nb__manage_tools")).toBeDefined();
    expect(seenToolLists[1]).toContain("nb__search");
    expect(events.some((e) => e.type === "tool.released")).toBe(false);
  });

  // ── LRU eviction backstop ─────────────────────────────────────────

  it("LRU eviction: respects maxActiveTools and evicts oldest agent-promoted tool", async () => {
    // 5 promotable tools, cap=4 (one initial + 3 promoted slots). Promoting
    // all 5 in one batch should evict the two earliest (a, b).
    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "app__a", description: "A", inputSchema: { type: "object", properties: {} } },
      { name: "app__b", description: "B", inputSchema: { type: "object", properties: {} } },
      { name: "app__c", description: "C", inputSchema: { type: "object", properties: {} } },
      { name: "app__d", description: "D", inputSchema: { type: "object", properties: {} } },
      { name: "app__e", description: "E", inputSchema: { type: "object", properties: {} } },
    ];

    let callCount = 0;
    let activeControls: ToolPromotionControls | null = null;
    const events: EngineEvent[] = [];

    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "promote_all",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["app__a", "app__b", "app__c", "app__d", "app__e"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "Done!" }], inputTokens: 10, outputTokens: 5 };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          const add = (call.input.add as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released: [] },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    await engine.run(
      {
        ...defaultConfig,
        maxActiveTools: 4, // initial nb__manage_tools + 3 promoted slots
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Promote five" }] }],
      [toolSchemas[0]!],
    );

    expect(events.filter((e) => e.type === "tool.promoted")).toHaveLength(5);
    const evicted = events
      .filter(
        (e) =>
          e.type === "tool.released" &&
          (e.data as { reason?: string }).reason === "evicted",
      )
      .map((e) => (e.data as { toolName: string }).toolName);
    expect(evicted).toEqual(["app__a", "app__b"]);
  });

  it("LRU eviction: never evicts initial tools even when cap is exceeded", async () => {
    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "initial__a", description: "Initial A", inputSchema: { type: "object", properties: {} } },
      { name: "initial__b", description: "Initial B", inputSchema: { type: "object", properties: {} } },
      { name: "promoted__x", description: "Promoted X", inputSchema: { type: "object", properties: {} } },
      { name: "promoted__y", description: "Promoted Y", inputSchema: { type: "object", properties: {} } },
    ];

    let callCount = 0;
    let activeControls: ToolPromotionControls | null = null;
    const events: EngineEvent[] = [];

    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "promote",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["promoted__x", "promoted__y"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "Done!" }], inputTokens: 10, outputTokens: 5 };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          const add = (call.input.add as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released: [] },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    await engine.run(
      {
        ...defaultConfig,
        // Cap=3: initial set already fills it. Each promotion overflows;
        // initial tools are exempt from eviction; the just-added tool is
        // also exempt (defensive self-eviction guard). Result: x is
        // evictable when y is added (x is now older than the just-added y),
        // y survives as the last-promoted entry.
        maxActiveTools: 3,
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Promote past cap" }] }],
      [toolSchemas[0]!, toolSchemas[1]!, toolSchemas[2]!],
    );

    const evictedNames = events
      .filter(
        (e) =>
          e.type === "tool.released" &&
          (e.data as { reason?: string }).reason === "evicted",
      )
      .map((e) => (e.data as { toolName: string }).toolName);
    // Initial tools never evicted (they're not in promotedLastUsed).
    expect(evictedNames).not.toContain("initial__a");
    expect(evictedNames).not.toContain("initial__b");
    expect(evictedNames).not.toContain("nb__manage_tools");
    // promoted__x is evicted when promoted__y arrives (x is older, y is
    // the just-added and protected by the self-eviction guard).
    expect(evictedNames).toContain("promoted__x");
    // promoted__y stays — it was the last-promoted entry and the guard
    // refused to undo the agent's intentional addition.
    expect(evictedNames).not.toContain("promoted__y");
  });

  it("LRU eviction: tool execution refreshes the eviction stamp", async () => {
    // Promote a, b, c, then call a (refreshes its stamp), then promote d.
    // Without refresh, a would be the oldest and evicted. With refresh,
    // b is the LRU victim.
    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "app__a", description: "A", inputSchema: { type: "object", properties: {} } },
      { name: "app__b", description: "B", inputSchema: { type: "object", properties: {} } },
      { name: "app__c", description: "C", inputSchema: { type: "object", properties: {} } },
      { name: "app__d", description: "D", inputSchema: { type: "object", properties: {} } },
    ];

    let callCount = 0;
    let activeControls: ToolPromotionControls | null = null;
    const events: EngineEvent[] = [];

    const model = createMockModel(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "p1",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["app__a", "app__b", "app__c"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      if (callCount === 2) {
        return {
          content: [
            { type: "tool-call", toolCallId: "use_a", toolName: "app__a", input: JSON.stringify({}) },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      if (callCount === 3) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "p2",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["app__d"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "Done!" }], inputTokens: 10, outputTokens: 5 };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          const add = (call.input.add as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released: [] },
            isError: false,
          };
        }
        return { content: textContent("ok"), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    await engine.run(
      {
        ...defaultConfig,
        // Cap=4: nb__manage_tools (initial) + 3 promoted slots. Promoting
        // a 4th forces eviction of the LRU promoted entry.
        maxActiveTools: 4,
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "LRU dance" }] }],
      [toolSchemas[0]!],
    );

    const evictedNames = events
      .filter(
        (e) =>
          e.type === "tool.released" &&
          (e.data as { reason?: string }).reason === "evicted",
      )
      .map((e) => (e.data as { toolName: string }).toolName);
    expect(evictedNames).toEqual(["app__b"]);
  });

  it("LRU eviction: when initial > cap, agent additions stick (cap goes soft)", async () => {
    // Pathological config: 5 initial tools but cap=3. Without the defensive
    // guard, the first addTool would push length=6, find the just-added
    // tool as the only entry in promotedLastUsed, and self-evict — silently
    // undoing the agent's intentional promotion. With the guard, the
    // promotion sticks and the cap is "soft" for this run.
    const toolSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "init__a", description: "A", inputSchema: { type: "object", properties: {} } },
      { name: "init__b", description: "B", inputSchema: { type: "object", properties: {} } },
      { name: "init__c", description: "C", inputSchema: { type: "object", properties: {} } },
      { name: "init__d", description: "D", inputSchema: { type: "object", properties: {} } },
      { name: "promoted__x", description: "X", inputSchema: { type: "object", properties: {} } },
    ];

    let callCount = 0;
    let activeControls: ToolPromotionControls | null = null;
    const events: EngineEvent[] = [];
    const seenToolLists: string[][] = [];

    const model = createMockModel((options) => {
      seenToolLists.push((options.tools ?? []).map((t) => t.name));
      callCount++;
      if (callCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "p",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["promoted__x"] }),
            },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "Done!" }], inputTokens: 10, outputTokens: 5 };
    });

    const engine = new AgentEngine(
      model,
      new StaticToolRouter(toolSchemas, (call) => {
        if (call.name === "nb__manage_tools") {
          const add = (call.input.add as string[] | undefined) ?? [];
          const promoted = add.map((n) => activeControls!.addTool(n));
          return {
            content: textContent("ok"),
            structuredContent: { promoted, released: [] },
            isError: false,
          };
        }
        return { content: textContent(""), isError: false };
      }),
      { emit: (event) => events.push(event) },
    );

    await engine.run(
      {
        ...defaultConfig,
        maxActiveTools: 3, // 5 initial > cap=3
        toolPromotion: {
          isToolEligible: () => true,
          registerControls: (controls) => {
            activeControls = controls;
            return () => {
              activeControls = null;
            };
          },
        },
      },
      "",
      [{ role: "user", content: [{ type: "text", text: "Promote past initial" }] }],
      [toolSchemas[0]!, toolSchemas[1]!, toolSchemas[2]!, toolSchemas[3]!, toolSchemas[4]!],
    );

    // Crucial: promoted__x is visible in the agent's tool list on iter 2.
    // It was NOT silently self-evicted by the LRU loop.
    expect(seenToolLists[1]).toContain("promoted__x");
    // No tools were evicted — the only entry in promotedLastUsed (promoted__x
    // itself) was protected by the self-eviction guard.
    const evictedNames = events
      .filter(
        (e) =>
          e.type === "tool.released" &&
          (e.data as { reason?: string }).reason === "evicted",
      )
      .map((e) => (e.data as { toolName: string }).toolName);
    expect(evictedNames).toHaveLength(0);
  });

  // ── Nested-engine isolation (delegate sub-agent regression) ──────

  it("nested engine.run inside a parent run isolates promotion controls per engine", async () => {
    // Regression: a sub-agent calling nb__manage_tools must mutate ITS OWN
    // directTools, not the parent's. Without per-engine save/restore in
    // registerControls, AsyncLocalStorage propagates the parent's
    // reqCtx.toolPromotion into the child's frame and the child's
    // promotions silently mutate the parent.

    // Shared factory: same shape as Runtime.buildToolPromotionFactory.
    // Save/restore is the load-bearing part — without it, child's
    // unregister would leave reqCtx.toolPromotion === child controls
    // (or undefined) instead of the parent's.
    const toolPromotionFactory: NonNullable<EngineConfig["toolPromotion"]> = {
      isToolEligible: () => true,
      registerControls: (controls) => {
        const ctx = getRequestContext();
        if (!ctx) return () => {};
        const prev = ctx.toolPromotion;
        ctx.toolPromotion = controls;
        return () => {
          if (prev === undefined) {
            delete ctx.toolPromotion;
          } else {
            ctx.toolPromotion = prev;
          }
        };
      },
    };

    // Outer toolset: nb__manage_tools (promotable) + a "delegate" tool
    // that, when called, spawns an inner engine.run().
    const outerSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "spawn_child", description: "Run a child engine", inputSchema: { type: "object", properties: {} } },
      { name: "outer__only", description: "Outer tool", inputSchema: { type: "object", properties: {} } },
    ];

    // Inner toolset: distinct from outer's. The inner agent will try to
    // promote `inner__discovered`, which exists in the inner router but
    // NOT in the outer's directTools. If isolation is broken, the outer's
    // directTools would gain inner__discovered.
    const innerSchemas: ToolSchema[] = [
      { name: "nb__manage_tools", description: "Patch tool list", inputSchema: { type: "object", properties: {} } },
      { name: "inner__discovered", description: "Inner-only tool", inputSchema: { type: "object", properties: {} } },
    ];

    const outerToolListsSeen: string[][] = [];
    const innerToolListsSeen: string[][] = [];

    // Inner model: iter 1 promotes inner__discovered; iter 2 verifies it's
    // visible and emits Done.
    let innerCallCount = 0;
    const innerModel = createMockModel((options) => {
      innerToolListsSeen.push((options.tools ?? []).map((t) => t.name));
      innerCallCount++;
      if (innerCallCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "inner_promote",
              toolName: "nb__manage_tools",
              input: JSON.stringify({ add: ["inner__discovered"] }),
            },
          ],
          inputTokens: 5,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "inner done" }], inputTokens: 5, outputTokens: 5 };
    });

    // Outer model: iter 1 calls spawn_child; iter 2 emits Done.
    let outerCallCount = 0;
    const outerModel = createMockModel((options) => {
      outerToolListsSeen.push((options.tools ?? []).map((t) => t.name));
      outerCallCount++;
      if (outerCallCount === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "spawn",
              toolName: "spawn_child",
              input: JSON.stringify({}),
            },
          ],
          inputTokens: 5,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "outer done" }], inputTokens: 5, outputTokens: 5 };
    });

    // Build the inner engine inside the spawn_child handler. The inner
    // engine uses the SAME factory (which is what production does via
    // ctx.toolPromotion in delegate.ts). The save/restore in the factory
    // pops the parent's controls back into reqCtx when inner's run
    // finishes, so the outer can continue normally.
    let activeOuterControls: ToolPromotionControls | null = null;
    let activeInnerControls: ToolPromotionControls | null = null;
    const events: EngineEvent[] = [];

    const innerRouter = new StaticToolRouter(innerSchemas, (call) => {
      if (call.name === "nb__manage_tools") {
        const add = (call.input.add as string[] | undefined) ?? [];
        // Inner's manage_tools handler reaches the controls in reqCtx.
        // After the fix, reqCtx.toolPromotion is the inner's controls
        // (because the inner engine.run installed them). The inner's
        // controls mutate the inner engine's directTools.
        const controls = getRequestContext()?.toolPromotion;
        if (!controls) {
          return { content: textContent("no controls"), isError: true };
        }
        const promoted = add.map((n) => controls.addTool(n));
        return {
          content: textContent("ok"),
          structuredContent: { promoted, released: [] },
          isError: false,
        };
      }
      return { content: textContent(""), isError: false };
    });

    const outerRouter = new StaticToolRouter(outerSchemas, async (call) => {
      if (call.name === "nb__manage_tools") {
        // Same handler as inner, but in the OUTER call context. reqCtx.toolPromotion
        // here is the outer's controls.
        const add = (call.input.add as string[] | undefined) ?? [];
        const controls = getRequestContext()?.toolPromotion;
        if (!controls) return { content: textContent("no controls"), isError: true };
        const promoted = add.map((n) => controls.addTool(n));
        return {
          content: textContent("ok"),
          structuredContent: { promoted, released: [] },
          isError: false,
        };
      }
      if (call.name === "spawn_child") {
        // This is the equivalent of nb__delegate: spawn a fresh engine.run
        // INSIDE the parent's request context. Without the per-engine
        // toolPromotion factory, child's manage_tools would leak into outer.
        const innerEngine = new AgentEngine(innerModel, innerRouter, {
          emit: (event) => events.push({ ...event, data: { ...event.data, scope: "inner" } }),
        });
        await innerEngine.run(
          {
            ...defaultConfig,
            toolPromotion: {
              ...toolPromotionFactory,
              registerControls: (controls) => {
                activeInnerControls = controls;
                const release = toolPromotionFactory.registerControls(controls);
                return () => {
                  activeInnerControls = null;
                  release();
                };
              },
            },
          },
          "",
          [{ role: "user", content: [{ type: "text", text: "child task" }] }],
          [innerSchemas[0]!],
        );
        return { content: textContent("child done"), isError: false };
      }
      return { content: textContent(""), isError: false };
    });

    const outerEngine = new AgentEngine(outerModel, outerRouter, {
      emit: (event) => events.push({ ...event, data: { ...event.data, scope: "outer" } }),
    });

    // Wrap the whole flow in a request context so reqCtx exists for the
    // factory to install controls into.
    const reqCtx: RequestContext = {
      identity: null,
      workspaceId: null,
      workspaceAgents: null,
      workspaceModelOverride: null,
    };
    await runWithRequestContext(reqCtx, async () => {
      await outerEngine.run(
        {
          ...defaultConfig,
          toolPromotion: {
            ...toolPromotionFactory,
            registerControls: (controls) => {
              activeOuterControls = controls;
              const release = toolPromotionFactory.registerControls(controls);
              return () => {
                activeOuterControls = null;
                release();
              };
            },
          },
        },
        "",
        [{ role: "user", content: [{ type: "text", text: "delegate something" }] }],
        [outerSchemas[0]!, outerSchemas[1]!, outerSchemas[2]!],
      );
    });

    // Outer's tool list across iterations should NEVER include
    // inner__discovered. If isolation is broken, the inner's promotion
    // would have mutated the outer's directTools and inner__discovered
    // would appear in outerToolListsSeen[1] or beyond.
    for (const [i, toolList] of outerToolListsSeen.entries()) {
      expect(toolList, `outer iteration ${i} tool list`).not.toContain("inner__discovered");
    }

    // Inner's iter 2 tool list MUST include inner__discovered — proves
    // the inner's manage_tools call actually reached the inner's own
    // directTools, not the outer's.
    expect(innerToolListsSeen[1]).toContain("inner__discovered");

    // After everything finishes, reqCtx.toolPromotion is restored to
    // its pre-run state (undefined here since this test created the
    // reqCtx fresh).
    expect(reqCtx.toolPromotion).toBeUndefined();

    // Sentinel: silence unused-var warnings; references are part of the
    // test's documentation of which controls are which.
    void activeOuterControls;
    void activeInnerControls;
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

  describe("finishReason propagation", () => {
    it("derives stopReason='complete' from finish=stop", async () => {
      const model = createEchoModel({
        responses: [{ text: "hi", finishReason: "stop" }],
      });
      const result = await makeEngine(model).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      expect(result.stopReason).toBe("complete");
      expect(result.finishReason).toBe("stop");
    });

    it("derives stopReason='length' when the model is truncated", async () => {
      const model = createEchoModel({
        responses: [{ text: "Building now.", finishReason: "length" }],
      });
      const result = await makeEngine(model).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "build" }] }],
        [],
      );

      expect(result.stopReason).toBe("length");
      expect(result.finishReason).toBe("length");
    });

    it("derives stopReason='content_filter' when the model is filtered", async () => {
      const model = createEchoModel({
        responses: [{ text: "", finishReason: "content-filter" }],
      });
      const result = await makeEngine(model).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      expect(result.stopReason).toBe("content_filter");
      expect(result.finishReason).toBe("content-filter");
    });

    it("derives stopReason='error' when the model finish reason is error", async () => {
      const model = createEchoModel({
        responses: [{ text: "", finishReason: "error" }],
      });
      const result = await makeEngine(model).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      expect(result.stopReason).toBe("error");
      expect(result.finishReason).toBe("error");
    });

    it("derives stopReason='other' when finish=tool-calls but content has no parsable calls", async () => {
      // Edge case: provider declares it stopped to call tools, but the
      // stream produced no tool-call parts. The loop exits (toolCalls is
      // empty) and the run reports "other" rather than fake "complete".
      const model = createEchoModel({
        responses: [{ text: "", finishReason: "tool-calls" }],
      });
      const result = await makeEngine(model).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      expect(result.stopReason).toBe("other");
      expect(result.finishReason).toBe("tool-calls");
    });

    it("max_iterations beats finishReason in the stop reason", async () => {
      const model = createMockModel(() => ({
        content: [
          {
            type: "tool-call",
            toolCallId: `call_${Date.now()}`,
            toolName: "test__noop",
            input: JSON.stringify({}),
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
      }));
      const tools = {
        schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
        handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
      };

      const result = await makeEngine(model, tools).run(
        { ...defaultConfig, maxIterations: 2 },
        "",
        [{ role: "user", content: [{ type: "text", text: "loop" }] }],
        tools.schemas,
      );

      expect(result.stopReason).toBe("max_iterations");
    });

    it("threads ResolvedThinking into providerOptions.anthropic.thinking on the call", async () => {
      // Captures the call options the engine sends to the model. Asserts
      // the platform's provider-neutral thinking config is translated to
      // the Anthropic-specific shape without leaking through other layers.
      // Sonnet 4.6 supports the `enabled` shape directly — the engine
      // passes the budget through verbatim.
      const capturedOptions: Array<Record<string, unknown>> = [];
      const recordingModel: LanguageModelV3 = {
        ...createEchoModel({ responses: [{ text: "ok" }] }),
      };
      const orig = recordingModel.doStream.bind(recordingModel);
      recordingModel.doStream = async (callOptions) => {
        capturedOptions.push(callOptions as unknown as Record<string, unknown>);
        return orig(callOptions);
      };

      await new AgentEngine(
        recordingModel,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      ).run(
        {
          ...defaultConfig,
          model: "anthropic:claude-sonnet-4-6",
          thinking: { mode: "enabled", budgetTokens: 4096 },
        },
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      expect(capturedOptions).toHaveLength(1);
      const po = capturedOptions[0]!.providerOptions as
        | { anthropic?: { thinking?: { type: string; budgetTokens?: number } } }
        | undefined;
      expect(po?.anthropic?.thinking).toEqual({ type: "enabled", budgetTokens: 4096 });
    });

    it("translates enabled→adaptive+effort for adaptive-only models (Opus 4.7)", async () => {
      // Opus 4.7 rejects `thinking.type=enabled` with an API error pointing
      // at `output_config.effort`. The engine translates the platform's
      // enabled+budget into adaptive+effort on the fly. Budget=12288 maps
      // to effort=medium (the safeThinkingBudget output for a 16K cap).
      const captured: Array<Record<string, unknown>> = [];
      const model: LanguageModelV3 = { ...createEchoModel({ responses: [{ text: "ok" }] }) };
      const orig = model.doStream.bind(model);
      model.doStream = async (o) => {
        captured.push(o as unknown as Record<string, unknown>);
        return orig(o);
      };

      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      ).run(
        {
          ...defaultConfig,
          model: "anthropic:claude-opus-4-7",
          thinking: { mode: "enabled", budgetTokens: 12288 },
        },
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      const po = captured[0]!.providerOptions as
        | { anthropic?: { thinking?: { type: string }; effort?: string } }
        | undefined;
      expect(po?.anthropic?.thinking).toEqual({ type: "adaptive" });
      expect(po?.anthropic?.effort).toBe("medium");
    });

    it("maps a large enabled budget to effort=max on adaptive-only models", async () => {
      // 128K-cap path: safeThinkingBudget ≈ 123904 → effort=max. Confirms
      // the budget→effort tiers don't quietly cap at "high".
      const captured: Array<Record<string, unknown>> = [];
      const model: LanguageModelV3 = { ...createEchoModel({ responses: [{ text: "ok" }] }) };
      const orig = model.doStream.bind(model);
      model.doStream = async (o) => {
        captured.push(o as unknown as Record<string, unknown>);
        return orig(o);
      };

      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      ).run(
        {
          ...defaultConfig,
          model: "anthropic:claude-opus-4-7",
          thinking: { mode: "enabled", budgetTokens: 123904 },
        },
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      const po = captured[0]!.providerOptions as
        | { anthropic?: { thinking?: { type: string }; effort?: string } }
        | undefined;
      expect(po?.anthropic?.thinking).toEqual({ type: "adaptive" });
      expect(po?.anthropic?.effort).toBe("max");
    });

    it("translates thinking=adaptive without budget", async () => {
      const captured: Array<Record<string, unknown>> = [];
      const model: LanguageModelV3 = { ...createEchoModel({ responses: [{ text: "ok" }] }) };
      const orig = model.doStream.bind(model);
      model.doStream = async (o) => {
        captured.push(o as unknown as Record<string, unknown>);
        return orig(o);
      };

      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      ).run(
        { ...defaultConfig, model: "anthropic:claude-opus-4-7", thinking: { mode: "adaptive" } },
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      const po = captured[0]!.providerOptions as
        | { anthropic?: { thinking?: { type: string } } }
        | undefined;
      expect(po?.anthropic?.thinking).toEqual({ type: "adaptive" });
    });

    it("maps operator adaptive+budget to effort on adaptive-only models", async () => {
      // Operator path: thinking="adaptive" + thinkingBudgetTokens=12288 in
      // tenant config. resolveThinking passes the budget through verbatim;
      // for adaptive-only models the engine maps it to effort so the
      // operator's intended cap actually constrains thinking (the SDK
      // would otherwise drop budgetTokens on adaptive).
      const captured: Array<Record<string, unknown>> = [];
      const model: LanguageModelV3 = { ...createEchoModel({ responses: [{ text: "ok" }] }) };
      const orig = model.doStream.bind(model);
      model.doStream = async (o) => {
        captured.push(o as unknown as Record<string, unknown>);
        return orig(o);
      };

      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      ).run(
        {
          ...defaultConfig,
          model: "anthropic:claude-opus-4-7",
          thinking: { mode: "adaptive", budgetTokens: 12288 },
        },
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      const po = captured[0]!.providerOptions as
        | { anthropic?: { thinking?: { type: string }; effort?: string } }
        | undefined;
      expect(po?.anthropic?.thinking).toEqual({ type: "adaptive" });
      expect(po?.anthropic?.effort).toBe("medium");
    });

    it("does NOT set providerOptions when thinking is undefined", async () => {
      const captured: Array<Record<string, unknown>> = [];
      const model: LanguageModelV3 = { ...createEchoModel({ responses: [{ text: "ok" }] }) };
      const orig = model.doStream.bind(model);
      model.doStream = async (o) => {
        captured.push(o as unknown as Record<string, unknown>);
        return orig(o);
      };

      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      ).run(defaultConfig, "", [{ role: "user", content: [{ type: "text", text: "x" }] }], []);

      // No top-level providerOptions when thinking is omitted (the
      // system message still carries cacheControl, but that's per-message
      // not per-call).
      expect(captured[0]!.providerOptions).toBeUndefined();
    });

    it("preserves Anthropic signature on reasoning across iterations (round-trip)", async () => {
      // The first turn emits reasoning + a tool call. The engine pushes
      // the assistant content into history for the second turn — and
      // the reasoning's providerMetadata must be promoted to
      // providerOptions on that history entry, otherwise the AI SDK
      // Anthropic provider would silently drop the block as
      // "unsupported reasoning metadata" on the second prompt.
      const sentMessages: LanguageModelV3Message[][] = [];
      const recordingModel: LanguageModelV3 = {
        ...createEchoModel({
          responses: [
            {
              reasoning: "Need to look this up.",
              reasoningProviderMetadata: { anthropic: { signature: "sig-test-789" } },
              toolCalls: [
                { toolCallId: "call_1", toolName: "test__noop", input: JSON.stringify({}) },
              ],
            },
            { text: "Done." },
          ],
        }),
      };
      const originalDoStream = recordingModel.doStream.bind(recordingModel);
      recordingModel.doStream = async (callOptions) => {
        sentMessages.push([...callOptions.prompt]);
        return originalDoStream(callOptions);
      };

      const tools = {
        schemas: [{ name: "test__noop", description: "No-op", inputSchema: {} }],
        handler: (): ToolResult => ({ content: textContent("ok"), isError: false }),
      };

      await new AgentEngine(
        recordingModel,
        new StaticToolRouter(tools.schemas, tools.handler),
        new NoopEventSink(),
      ).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "look it up" }] }],
        tools.schemas,
      );

      expect(sentMessages).toHaveLength(2);
      const secondPrompt = sentMessages[1]!;
      const assistant = secondPrompt.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      const reasoning = (assistant!.content as Array<Record<string, unknown>>).find(
        (c) => c.type === "reasoning",
      );
      expect(reasoning).toBeDefined();
      // The critical assertion — providerOptions must be set, not just
      // providerMetadata, because that's what the Anthropic prompt path reads.
      expect(reasoning!.providerOptions).toEqual({
        anthropic: { signature: "sig-test-789" },
      });
    });

    it("captures reasoning content blocks and reasoning.delta events", async () => {
      const events: EngineEvent[] = [];
      const sink: EventSink = {
        emit(event: EngineEvent) {
          events.push(event);
        },
      };
      const model = createEchoModel({
        responses: [
          {
            reasoning: "Let me think about this carefully...",
            text: "Done.",
            reasoningTokens: 42,
          },
        ],
      });

      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        sink,
      ).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      const reasoningDeltas = events.filter((e) => e.type === "reasoning.delta");
      expect(reasoningDeltas).toHaveLength(1);
      expect((reasoningDeltas[0]!.data as Record<string, unknown>).text).toBe(
        "Let me think about this carefully...",
      );

      const llmDone = events.find((e) => e.type === "llm.done");
      expect(llmDone).toBeDefined();
      const llmData = llmDone!.data as Record<string, unknown>;
      const usage = llmData.usage as { reasoningTokens?: number };
      expect(usage.reasoningTokens).toBe(42);
      const content = llmData.content as Array<{ type: string; text?: string }>;
      expect(content.find((c) => c.type === "reasoning")?.text).toBe(
        "Let me think about this carefully...",
      );
      expect(content.find((c) => c.type === "text")?.text).toBe("Done.");
    });

    it("emits finishReason on the llm.done event", async () => {
      const events: EngineEvent[] = [];
      const sink: EventSink = {
        emit(event: EngineEvent) {
          events.push(event);
        },
      };

      const model = createEchoModel({
        responses: [{ text: "truncated mid-thought", finishReason: "length" }],
      });
      await new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        sink,
      ).run(
        defaultConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "x" }] }],
        [],
      );

      const llmDone = events.find((e) => e.type === "llm.done");
      expect(llmDone).toBeDefined();
      expect((llmDone!.data as Record<string, unknown>).finishReason).toBe("length");
    });
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

  describe("context-overflow recovery", () => {
    it("re-invokes transformContext with overflowAttempt=1 and retries once on a context-overflow error", async () => {
      let callCount = 0;
      const recordedAttempts: Array<number | undefined> = [];
      const events: EngineEvent[] = [];
      const recordingSink: EventSink = {
        emit(e: EngineEvent) {
          events.push(e);
        },
      };

      // First call throws an Anthropic-shaped overflow error; second succeeds.
      const model = createMockModel(() => {
        callCount += 1;
        if (callCount === 1) {
          throw Object.assign(
            new Error("prompt is too long: 1257504 tokens > 1000000 maximum"),
            { status: 400 },
          );
        }
        return {
          content: [{ type: "text", text: "recovered" }],
        };
      });

      const engine = new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        recordingSink,
      );

      const result = await engine.run(
        {
          ...defaultConfig,
          hooks: {
            transformContext: (msgs, opts) => {
              recordedAttempts.push(opts?.overflowAttempt);
              return msgs;
            },
          },
        },
        "",
        [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        [],
      );

      // The model was called twice: once that overflowed, once that succeeded.
      expect(callCount).toBe(2);

      // transformContext got called twice — once at overflowAttempt=0
      // (or undefined), once at overflowAttempt=1.
      expect(recordedAttempts).toEqual([0, 1]);

      // The recovery event was emitted exactly once with attempt=1.
      const recoveryEvents = events.filter((e) => e.type === "context.overflow_recovery");
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]!.data).toMatchObject({ attempt: 1 });

      // The run succeeded with the second call's output.
      expect(result.output).toBe("recovered");
      expect(result.stopReason).toBe("complete");
    });

    it("propagates the original overflow error after a single recovery attempt fails", async () => {
      let callCount = 0;
      const model = createMockModel(() => {
        callCount += 1;
        // Both calls overflow.
        throw Object.assign(
          new Error("prompt is too long: still too big"),
          { status: 400 },
        );
      });

      const engine = new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      );

      await expect(
        engine.run(
          {
            ...defaultConfig,
            hooks: { transformContext: (msgs) => msgs },
          },
          "",
          [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
          [],
        ),
      ).rejects.toThrow(/prompt is too long/);

      // Two model calls: the original + one recovery attempt.
      expect(callCount).toBe(2);
    });

    it("does NOT retry on a non-overflow error (auth, unrelated 400, etc.)", async () => {
      let callCount = 0;
      const model = createMockModel(() => {
        callCount += 1;
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      });

      const engine = new AgentEngine(
        model,
        new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
        new NoopEventSink(),
      );

      await expect(
        engine.run(
          {
            ...defaultConfig,
            hooks: { transformContext: (msgs) => msgs },
          },
          "",
          [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
          [],
        ),
      ).rejects.toThrow(/Authentication failed/);

      // No recovery — the auth error is non-retryable and surfaces immediately.
      expect(callCount).toBe(1);
    });
  });
});
