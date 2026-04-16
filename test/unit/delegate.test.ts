import { afterEach, describe, expect, it } from "bun:test";
import { AgentEngine } from "../../src/engine/engine.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { InlineSource } from "../../src/tools/inline-source.ts";
import { createDelegateTool } from "../../src/tools/delegate.ts";
import type { DelegateContext } from "../../src/tools/delegate.ts";
import { textContent, extractText } from "../../src/engine/content-helpers.ts";
import type {
	EngineConfig,
	EngineEvent,
	EventSink,
	ToolCall,
	ToolResult,
	ToolSchema,
} from "../../src/engine/types.ts";
import type { AgentProfile } from "../../src/runtime/types.ts";
import type { LanguageModelV3 } from "@ai-sdk/provider";

const DEFAULT_MODEL = "test-model";

/** Build a DelegateContext wired to an EchoModel and a simple registry. */
function makeDelegateCtx(opts: {
	agents?: Record<string, AgentProfile>;
	events?: EventSink;
	registry?: ToolRegistry;
	remainingIterations?: number;
	parentRunId?: string;
	model?: LanguageModelV3;
}): DelegateContext {
	const model = opts.model ?? createEchoModel();
	const registry = opts.registry ?? new ToolRegistry();

	return {
		resolveModel: () => model,
		resolveSlot: (s: string) => s,
		tools: registry,
		events: opts.events ?? new NoopEventSink(),
		agents: opts.agents,
		getRemainingIterations: () => opts.remainingIterations ?? 10,
		getParentRunId: () => opts.parentRunId ?? "parent-run-123",
		defaultModel: DEFAULT_MODEL,
		defaultMaxInputTokens: 500_000,
		defaultMaxOutputTokens: 16_384,
	};
}

describe("nb__delegate", () => {
	// Tracks registries that had sources added — cleaned up after each test.
	let registryToClean: ToolRegistry | null = null;

	afterEach(async () => {
		if (registryToClean) {
			for (const name of registryToClean.sourceNames()) {
				await registryToClean.removeSource(name);
			}
			registryToClean = null;
		}
	});

	it("returns child output as tool result with named profile", async () => {
		const ctx = makeDelegateCtx({
			agents: {
				writer: {
					description: "Writing agent",
					systemPrompt: "You are a writer.",
					tools: [],
					maxIterations: 3,
				},
			},
		});

		const tool = createDelegateTool(ctx);
		const result = await tool.handler({
			task: "Write a haiku about testing",
			agent: "writer",
		});

		expect(result.isError).toBe(false);
		// EchoModel returns the user message, so output should be the task
		expect(extractText(result.content)).toBe("Write a haiku about testing");
	});

	it("uses task as both prompt and message when no profile specified", async () => {
		const ctx = makeDelegateCtx({});
		const tool = createDelegateTool(ctx);

		const result = await tool.handler({
			task: "Summarize the data",
		});

		expect(result.isError).toBe(false);
		expect(extractText(result.content)).toBe("Summarize the data");
	});

	it("returns error for unknown agent profile", async () => {
		const ctx = makeDelegateCtx({
			agents: {
				researcher: {
					description: "Research agent",
					systemPrompt: "You are a researcher.",
					tools: [],
				},
			},
		});

		const tool = createDelegateTool(ctx);
		const result = await tool.handler({
			task: "Do something",
			agent: "nonexistent",
		});

		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain('Unknown agent profile "nonexistent"');
		expect(extractText(result.content)).toContain("researcher");
	});

	it("returns error listing 'none' when no agents configured and profile requested", async () => {
		const ctx = makeDelegateCtx({ agents: undefined });

		const tool = createDelegateTool(ctx);
		const result = await tool.handler({
			task: "Do something",
			agent: "nonexistent",
		});

		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("none");
	});

	it("caps child maxIterations at parent remaining - 1", async () => {
		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			events: eventSink,
			remainingIterations: 4,
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Test iteration cap",
			maxIterations: 10,
		});

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"] === "parent-run-123",
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["maxIterations"]).toBe(3);
	});

	it("uses profile maxIterations when no explicit maxIterations given", async () => {
		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			events: eventSink,
			remainingIterations: 10,
			agents: {
				analyst: {
					description: "Data analyst",
					systemPrompt: "Analyze data.",
					tools: [],
					maxIterations: 7,
				},
			},
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Analyze the data",
			agent: "analyst",
		});

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["maxIterations"]).toBe(7);
	});

	it("defaults to 5 iterations when no maxIterations specified anywhere", async () => {
		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			events: eventSink,
			remainingIterations: 10,
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "Default iterations test" });

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["maxIterations"]).toBe(5);
	});

	it("child events include parentRunId for observability", async () => {
		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			events: eventSink,
			parentRunId: "parent-abc-123",
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "Observability test" });

		const childEvents = events.filter((e) => e.data["parentRunId"] === "parent-abc-123");
		expect(childEvents.length).toBeGreaterThan(0);

		const childRunStart = childEvents.find((e) => e.type === "run.start");
		const childRunDone = childEvents.find((e) => e.type === "run.done");
		expect(childRunStart).toBeDefined();
		expect(childRunDone).toBeDefined();
		expect(childRunStart!.data["parentRunId"]).toBe("parent-abc-123");
		expect(childRunDone!.data["parentRunId"]).toBe("parent-abc-123");
	});

	it("filters child tools by custom glob patterns", async () => {
		const registry = new ToolRegistry();
		registryToClean = registry;
		registry.addSource(
			new InlineSource("search", [
				{
					name: "web",
					description: "Web search",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("results"), isError: false }),
				},
				{
					name: "docs",
					description: "Doc search",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("docs"), isError: false }),
				},
			]),
		);
		registry.addSource(
			new InlineSource("writer", [
				{
					name: "draft",
					description: "Draft content",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("draft"), isError: false }),
				},
			]),
		);

		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			registry,
			events: eventSink,
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Search only",
			tools: ["search__*"],
		});

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["toolCount"]).toBe(2);
		const toolNames = childRunStart!.data["toolNames"] as string[];
		expect(toolNames).toContain("search__web");
		expect(toolNames).toContain("search__docs");
		expect(toolNames).not.toContain("writer__draft");
	});

	it("profile tool globs filter available tools", async () => {
		const registry = new ToolRegistry();
		registryToClean = registry;
		registry.addSource(
			new InlineSource("alpha", [
				{
					name: "one",
					description: "Alpha one",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);
		registry.addSource(
			new InlineSource("beta", [
				{
					name: "two",
					description: "Beta two",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);

		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			registry,
			events: eventSink,
			agents: {
				limited: {
					description: "Limited agent",
					systemPrompt: "Limited access.",
					tools: ["alpha__*"],
				},
			},
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Do limited work",
			agent: "limited",
		});

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["toolCount"]).toBe(1);
		const toolNames = childRunStart!.data["toolNames"] as string[];
		expect(toolNames).toContain("alpha__one");
	});

	it("child agent has fresh context (no conversation history)", async () => {
		let childMessages: unknown[] = [];
		const trackingModel = createMockModel((options) => {
			// Capture non-system messages
			childMessages = options.prompt.filter((m) => m.role !== "system");
			return {
				content: [{ type: "text", text: "child output" }],
				inputTokens: 10,
				outputTokens: 5,
			};
		});

		const registry = new ToolRegistry();
		const ctx: DelegateContext = {
			resolveModel: () => trackingModel,
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: undefined,
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-run-id",
			defaultModel: DEFAULT_MODEL,
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "Fresh context test" });

		// Child should only have the task as a single user message
		expect(childMessages).toHaveLength(1);
	});

	it("multiple parallel delegations execute concurrently", async () => {
		const DELAY = 50;
		let callCount = 0;
		let childConcurrency = 0;
		let maxChildConcurrency = 0;

		// Parent model that makes 3 delegate calls, then finishes
		const parentModel = createMockModel(() => {
			callCount++;
			if (callCount === 1) {
				return {
					content: [
						{ type: "tool-call", toolCallId: "d1", toolName: "nb__delegate", input: JSON.stringify({ task: "task-1" }) },
						{ type: "tool-call", toolCallId: "d2", toolName: "nb__delegate", input: JSON.stringify({ task: "task-2" }) },
						{ type: "tool-call", toolCallId: "d3", toolName: "nb__delegate", input: JSON.stringify({ task: "task-3" }) },
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

		// Child model with artificial delay — tracks in-flight concurrency to verify parallel execution
		const childModel = createMockModel(async (options) => {
			childConcurrency++;
			if (childConcurrency > maxChildConcurrency) maxChildConcurrency = childConcurrency;
			await new Promise((r) => setTimeout(r, DELAY));
			childConcurrency--;
			// Extract user message text
			const userMsg = options.prompt.filter((m) => m.role === "user");
			let text = "echo";
			if (userMsg.length > 0) {
				const content = userMsg[0].content;
				if (Array.isArray(content)) {
					const textPart = content.find((p: { type: string }) => p.type === "text") as { text?: string } | undefined;
					text = textPart?.text ?? "echo";
				}
			}
			return {
				content: [{ type: "text", text }],
				inputTokens: 5,
				outputTokens: 5,
			};
		});

		const registry = new ToolRegistry();
		registryToClean = registry;

		const delegateCtx: DelegateContext = {
			resolveModel: () => childModel,
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: undefined,
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-parallel",
			defaultModel: DEFAULT_MODEL,
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const delegateTool = createDelegateTool(delegateCtx);
		const delegateSource = new InlineSource("nb", [delegateTool]);
		registry.addSource(delegateSource);

		const engine = new AgentEngine(parentModel, registry, new NoopEventSink());

		const result = await engine.run(
			{
				model: DEFAULT_MODEL,
				maxIterations: 5,
				maxInputTokens: 500_000,
				maxOutputTokens: 16_384,
			},
			"You are a coordinator.",
			[{ role: "user", content: [{ type: "text", text: "Delegate three tasks" }] }],
			await registry.availableTools(),
		);

		expect(result.toolCalls).toHaveLength(3);
		expect(result.toolCalls.every((tc) => tc.ok)).toBe(true);
		// All 3 delegations must have overlapped in-flight — sequential execution would never exceed concurrency of 1
		expect(maxChildConcurrency).toBe(3);
	});

	it("uses profile model override when specified", async () => {
		let receivedModelString = "";
		const trackingModel = createMockModel(() => ({
			content: [{ type: "text", text: "ok" }],
			inputTokens: 10,
			outputTokens: 5,
		}));

		const registry = new ToolRegistry();
		const ctx: DelegateContext = {
			resolveModel: (modelString) => {
				receivedModelString = modelString;
				return trackingModel;
			},
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: {
				specialized: {
					description: "Uses a different model",
					systemPrompt: "You are specialized.",
					tools: [],
					model: "claude-opus-4-20250514",
				},
			},
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-run-id",
			defaultModel: DEFAULT_MODEL,
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Model override test",
			agent: "specialized",
		});

		expect(receivedModelString).toBe("claude-opus-4-20250514");
	});

	it("uses default model when no profile model specified", async () => {
		let receivedModelString = "";
		const trackingModel = createMockModel(() => ({
			content: [{ type: "text", text: "ok" }],
			inputTokens: 10,
			outputTokens: 5,
		}));

		const registry = new ToolRegistry();
		const ctx: DelegateContext = {
			resolveModel: (modelString) => {
				receivedModelString = modelString;
				return trackingModel;
			},
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: undefined,
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-run-id",
			defaultModel: "my-default-model",
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "Default model test" });

		expect(receivedModelString).toBe("my-default-model");
	});

	it("handles child engine errors gracefully", async () => {
		const failingModel = createMockModel(() => {
			throw new Error("LLM service unavailable");
		});

		const registry = new ToolRegistry();
		const ctx: DelegateContext = {
			resolveModel: () => failingModel,
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: undefined,
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-run-id",
			defaultModel: DEFAULT_MODEL,
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const tool = createDelegateTool(ctx);
		const result = await tool.handler({ task: "Will fail" });

		expect(result.isError).toBe(true);
		expect(extractText(result.content)).toContain("Delegation failed");
		expect(extractText(result.content)).toContain("LLM service unavailable");
	});

	it("maxIterations hard cap at 10 even when requested higher", async () => {
		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			events: eventSink,
			remainingIterations: 20,
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Test hard cap",
			maxIterations: 15,
		});

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["maxIterations"]).toBe(10);
	});

	it("child tool access defaults to all tools when no globs specified", async () => {
		const registry = new ToolRegistry();
		registryToClean = registry;
		registry.addSource(
			new InlineSource("a", [
				{
					name: "tool1",
					description: "Tool 1",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);
		registry.addSource(
			new InlineSource("b", [
				{
					name: "tool2",
					description: "Tool 2",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);

		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			registry,
			events: eventSink,
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "Use all tools" });

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["toolCount"]).toBe(2);
	});

	it("profile with empty tools array gets all tools", async () => {
		const registry = new ToolRegistry();
		registryToClean = registry;
		registry.addSource(
			new InlineSource("x", [
				{
					name: "one",
					description: "X one",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);

		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			registry,
			events: eventSink,
			agents: {
				openaccess: {
					description: "Open access agent",
					systemPrompt: "You have all tools.",
					tools: [],
				},
			},
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Use everything",
			agent: "openaccess",
		});

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["toolCount"]).toBe(1);
	});

	it("uses profile systemPrompt, not task, when profile is specified", async () => {
		let receivedSystem = "";
		const trackingModel = createMockModel((options) => {
			const systemMsg = options.prompt.find((m) => m.role === "system");
			if (systemMsg && typeof systemMsg.content === "string") {
				receivedSystem = systemMsg.content;
			}
			return {
				content: [{ type: "text", text: "ok" }],
				inputTokens: 10,
				outputTokens: 5,
			};
		});

		const registry = new ToolRegistry();
		const ctx: DelegateContext = {
			resolveModel: () => trackingModel,
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: {
				myagent: {
					description: "Custom agent",
					systemPrompt: "You are a custom agent with special instructions.",
					tools: [],
				},
			},
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-run-id",
			defaultModel: DEFAULT_MODEL,
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const tool = createDelegateTool(ctx);
		await tool.handler({
			task: "Do the work",
			agent: "myagent",
		});

		expect(receivedSystem).toBe("You are a custom agent with special instructions.");
	});

	it("uses safety preamble as systemPrompt when no profile", async () => {
		let receivedSystem = "";
		const trackingModel = createMockModel((options) => {
			const systemMsg = options.prompt.find((m) => m.role === "system");
			if (systemMsg && typeof systemMsg.content === "string") {
				receivedSystem = systemMsg.content;
			}
			return {
				content: [{ type: "text", text: "ok" }],
				inputTokens: 10,
				outputTokens: 5,
			};
		});

		const registry = new ToolRegistry();
		const ctx: DelegateContext = {
			resolveModel: () => trackingModel,
			resolveSlot: (s: string) => s,
			tools: registry,
			events: new NoopEventSink(),
			agents: undefined,
			getRemainingIterations: () => 10,
			getParentRunId: () => "parent-run-id",
			defaultModel: DEFAULT_MODEL,
			defaultMaxInputTokens: 500_000,
			defaultMaxOutputTokens: 16_384,
		};

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "This is both prompt and task" });

		// Delegate now uses a fixed safety preamble instead of the raw task
		expect(receivedSystem).toContain("helpful sub-agent");
		expect(receivedSystem).not.toBe("This is both prompt and task");
	});

	it("rejects execution of tools outside the filtered set (security enforcement)", async () => {
		const registry = new ToolRegistry();
		registryToClean = registry;

		let forbiddenCalled = false;
		registry.addSource(
			new InlineSource("allowed", [
				{
					name: "safe",
					description: "Allowed tool",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("safe-result"), isError: false }),
				},
			]),
		);
		registry.addSource(
			new InlineSource("forbidden", [
				{
					name: "dangerous",
					description: "Should not be callable by child",
					inputSchema: { type: "object", properties: {} },
					handler: async () => {
						forbiddenCalled = true;
						return { content: textContent("dangerous-result"), isError: false };
					},
				},
			]),
		);

		// Model that tries to call the forbidden tool
		let callCount = 0;
		const attackModel = createMockModel(() => {
			callCount++;
			if (callCount === 1) {
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: "tc1",
							toolName: "forbidden__dangerous",
							input: JSON.stringify({}),
						},
					],
					inputTokens: 10,
					outputTokens: 5,
				};
			}
			return {
				content: [{ type: "text", text: "done" }],
				inputTokens: 10,
				outputTokens: 5,
			};
		});

		const events: EngineEvent[] = [];
		const ctx = makeDelegateCtx({
			registry,
			model: attackModel,
			events: { emit: (e: EngineEvent) => events.push(e) },
		});

		const tool = createDelegateTool(ctx);
		const result = await tool.handler({
			task: "Try to call forbidden tool",
			tools: ["allowed__*"],
		});

		// The forbidden tool handler should never have been called
		expect(forbiddenCalled).toBe(false);
		// The delegation should succeed (the child recovers from the error)
		expect(result.isError).toBe(false);
		// Verify the tool call was rejected with an error
		const toolDoneEvents = events.filter(
			(e) => e.type === "tool.done" && (e.data as Record<string, unknown>)["name"] === "forbidden__dangerous",
		);
		expect(toolDoneEvents.length).toBe(1);
		expect((toolDoneEvents[0].data as Record<string, unknown>)["ok"]).toBe(false);
	});

	it("ensures at least 1 iteration even when parent budget is exhausted", async () => {
		const events: EngineEvent[] = [];
		const eventSink: EventSink = {
			emit(event: EngineEvent) {
				events.push(event);
			},
		};

		const ctx = makeDelegateCtx({
			events: eventSink,
			remainingIterations: 1,
		});

		const tool = createDelegateTool(ctx);
		await tool.handler({ task: "Last gasp" });

		const childRunStart = events.find(
			(e) => e.type === "run.start" && e.data["parentRunId"],
		);
		expect(childRunStart).toBeDefined();
		expect(childRunStart!.data["maxIterations"]).toBe(1);
	});
});
