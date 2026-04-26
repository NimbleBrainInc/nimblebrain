import { describe, expect, it } from "bun:test";
import { AgentEngine } from "../../src/engine/engine.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createDelegateTool } from "../../src/tools/delegate.ts";
import type { DelegateContext } from "../../src/tools/delegate.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import {
	resolveModelString,
	buildRegistry,
	buildModelResolver,
} from "../../src/model/registry.ts";
import type {
	EngineConfig,
	EngineEvent,
	EventSink,
} from "../../src/engine/types.ts";
import type { AgentProfile } from "../../src/runtime/types.ts";
import type { LanguageModelV3, LanguageModelV3Message } from "@ai-sdk/provider";

const defaultConfig: EngineConfig = {
	model: "test-model",
	maxIterations: 10,
	maxInputTokens: 500_000,
	maxOutputTokens: 16_384,
};

describe("multi-model routing", () => {
	describe("Runtime with custom model works end-to-end", () => {
		it("echoes user message through AgentEngine with custom model", async () => {
			const echoModel = createEchoModel();
			const router = new StaticToolRouter([], () => ({
				content: "",
				isError: false,
			}));
			const engine = new AgentEngine(echoModel, router, new NoopEventSink());

			const messages: LanguageModelV3Message[] = [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			];

			const result = await engine.run(
				defaultConfig,
				"You are a test assistant.",
				messages,
				[],
			);

			expect(result.output).toBe("hello");
			expect(result.stopReason).toBe("complete");
			expect(result.iterations).toBe(1);
			expect(result.toolCalls).toHaveLength(0);
		});

		it("preserves custom model provider and modelId", () => {
			const echoModel = createEchoModel({
				provider: "custom-provider",
				modelId: "custom-model-v1",
			});

			expect(echoModel.provider).toBe("custom-provider");
			expect(echoModel.modelId).toBe("custom-model-v1");
			expect(echoModel.specificationVersion).toBe("v3");
		});
	});

	describe("model resolution in registry", () => {
		it("resolves qualified model string to correct provider", () => {
			const resolver = buildModelResolver({
				providers: { anthropic: {} },
			});
			const model = resolver("anthropic:claude-sonnet-4-6");
			expect(model).toBeDefined();
			expect(model.provider).toContain("anthropic");
			expect(model.modelId).toContain("claude-sonnet");
		});

		it("resolves bare model string with anthropic default", () => {
			const resolver = buildModelResolver({
				providers: { anthropic: {} },
			});
			const model = resolver("claude-sonnet-4-6");
			expect(model).toBeDefined();
			expect(model.specificationVersion).toBe("v3");
		});
	});

	describe("agent profile model override via delegate", () => {
		it("delegate resolves model from agent profile", async () => {
			const capturedModels: string[] = [];
			const echoModel = createEchoModel();

			const ctx: DelegateContext = {
				resolveModel: (modelString: string) => {
					capturedModels.push(modelString);
					return echoModel;
				},
				resolveSlot: (s: string) => s,
				tools: new ToolRegistry(),
				events: new NoopEventSink(),
				agents: {
					researcher: {
						description: "Research agent",
						systemPrompt: "You research things.",
						tools: [],
						maxIterations: 5,
						model: "anthropic:claude-sonnet-4-6",
					},
				},
				getRemainingIterations: () => 10,
				getParentRunId: () => "parent-run-1",
				defaultModel: "test-default-model",
				defaultMaxInputTokens: 500_000,
				defaultMaxOutputTokens: 16_384,
			};

			const tool = createDelegateTool(ctx);
			const result = await tool.handler({
				task: "Find relevant papers",
				agent: "researcher",
			});

			expect(result.isError).toBe(false);
			expect(capturedModels).toContain("anthropic:claude-sonnet-4-6");
		});

		it("delegate falls back to defaultModel when profile has no model", async () => {
			const capturedModels: string[] = [];
			const echoModel = createEchoModel();

			const ctx: DelegateContext = {
				resolveModel: (modelString: string) => {
					capturedModels.push(modelString);
					return echoModel;
				},
				resolveSlot: (s: string) => s,
				tools: new ToolRegistry(),
				events: new NoopEventSink(),
				agents: {
					writer: {
						description: "Writing agent",
						systemPrompt: "You write things.",
						tools: [],
					},
				},
				getRemainingIterations: () => 10,
				getParentRunId: () => "parent-run-2",
				defaultModel: "my-default-model",
				defaultMaxInputTokens: 500_000,
				defaultMaxOutputTokens: 16_384,
			};

			const tool = createDelegateTool(ctx);
			await tool.handler({
				task: "Write a summary",
				agent: "writer",
			});

			expect(capturedModels).toContain("my-default-model");
		});

		it("different agent profiles resolve to different model strings", async () => {
			const capturedModels: string[] = [];
			const echoModel = createEchoModel();

			const ctx: DelegateContext = {
				resolveModel: (modelString: string) => {
					capturedModels.push(modelString);
					return echoModel;
				},
				resolveSlot: (s: string) => s,
				tools: new ToolRegistry(),
				events: new NoopEventSink(),
				agents: {
					fast_agent: {
						description: "Fast agent",
						systemPrompt: "Be fast.",
						tools: [],
						model: "anthropic:claude-haiku-4-5-20251001",
					},
					smart_agent: {
						description: "Smart agent",
						systemPrompt: "Be thorough.",
						tools: [],
						model: "anthropic:claude-sonnet-4-6",
					},
				},
				getRemainingIterations: () => 10,
				getParentRunId: () => "parent-run-3",
				defaultModel: "test-default",
				defaultMaxInputTokens: 500_000,
				defaultMaxOutputTokens: 16_384,
			};

			const tool = createDelegateTool(ctx);

			await tool.handler({ task: "Quick lookup", agent: "fast_agent" });
			await tool.handler({ task: "Deep analysis", agent: "smart_agent" });

			expect(capturedModels[0]).toBe("anthropic:claude-haiku-4-5-20251001");
			expect(capturedModels[1]).toBe("anthropic:claude-sonnet-4-6");
		});
	});

	describe("default model fallback", () => {
		it("delegate uses defaultModel when no agent profile specified", async () => {
			const capturedModels: string[] = [];
			const echoModel = createEchoModel();

			const ctx: DelegateContext = {
				resolveModel: (modelString: string) => {
					capturedModels.push(modelString);
					return echoModel;
				},
				resolveSlot: (s: string) => s,
				tools: new ToolRegistry(),
				events: new NoopEventSink(),
				getRemainingIterations: () => 10,
				getParentRunId: () => "parent-run-4",
				defaultModel: "claude-sonnet-4-5-20250929",
				defaultMaxInputTokens: 500_000,
				defaultMaxOutputTokens: 16_384,
			};

			const tool = createDelegateTool(ctx);
			await tool.handler({ task: "Do something" });

			expect(capturedModels).toContain("claude-sonnet-4-5-20250929");
		});

		it("engine run receives the model string in config", async () => {
			const events: EngineEvent[] = [];
			const sink: EventSink = {
				emit(event: EngineEvent) {
					events.push(event);
				},
			};

			const echoModel = createEchoModel();
			const router = new StaticToolRouter([], () => ({
				content: "",
				isError: false,
			}));
			const engine = new AgentEngine(echoModel, router, sink);

			const config: EngineConfig = {
				model: "my-custom-default",
				maxIterations: 5,
				maxInputTokens: 500_000,
				maxOutputTokens: 16_384,
			};

			await engine.run(
				config,
				"system",
				[{ role: "user", content: [{ type: "text", text: "test" }] }],
				[],
			);

			const runStart = events.find((e) => e.type === "run.start");
			expect(runStart).toBeDefined();
			expect(runStart!.data["model"]).toBe("my-custom-default");
		});
	});

	describe("bare string gets anthropic prefix", () => {
		it("resolveModelString adds anthropic: to bare model names", () => {
			expect(resolveModelString("claude-sonnet-4-6")).toBe(
				"anthropic:claude-sonnet-4-6",
			);
		});

		it("resolveModelString preserves already-qualified strings", () => {
			expect(resolveModelString("openai:gpt-4o")).toBe("openai:gpt-4o");
			expect(resolveModelString("google:gemini-2.5-flash")).toBe(
				"google:gemini-2.5-flash",
			);
		});

		it("resolveModelString handles bare haiku model", () => {
			expect(resolveModelString("claude-haiku-4-5-20251001")).toBe(
				"anthropic:claude-haiku-4-5-20251001",
			);
		});
	});

	describe("engine works with LanguageModelV3 end-to-end", () => {
		it("engine processes multiple turns with echo model", async () => {
			const echoModel = createEchoModel({
				responses: [
					{ text: "First response" },
					{ text: "Second response" },
				],
			});

			// Use a model that returns tool calls then stops
			const toolCallModel = createEchoModel({
				responses: [
					{
						text: "I will use the tool",
						toolCalls: [
							{
								toolCallId: "tc-1",
								toolName: "test_tool",
								input: JSON.stringify({ query: "test" }),
							},
						],
					},
					{ text: "Done with the tool result" },
				],
			});

			const router = new StaticToolRouter(
				[
					{
						name: "test_tool",
						description: "A test tool",
						inputSchema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
				() => ({ content: textContent("tool output"), isError: false }),
			);

			const engine = new AgentEngine(
				toolCallModel,
				router,
				new NoopEventSink(),
			);

			const result = await engine.run(
				defaultConfig,
				"You are a test assistant.",
				[
					{
						role: "user",
						content: [{ type: "text", text: "Use the tool" }],
					},
				],
				[
					{
						name: "test_tool",
						description: "A test tool",
						inputSchema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
			);

			expect(result.output).toContain("Done with the tool result");
			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0]!.name).toBe("test_tool");
			expect(result.iterations).toBe(2);
		});

		it("echo model with custom provider/modelId passes through engine", async () => {
			const model = createEchoModel({
				provider: "test-provider",
				modelId: "test-model-v2",
			});

			const engine = new AgentEngine(
				model,
				new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
				new NoopEventSink(),
			);

			const result = await engine.run(
				defaultConfig,
				"system prompt",
				[{ role: "user", content: [{ type: "text", text: "ping" }] }],
				[],
			);

			expect(result.output).toBe("ping");
			expect(result.stopReason).toBe("complete");
		});
	});
});
