import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const usageTestDir = join(tmpdir(), `nimblebrain-usage-${Date.now()}`);

describe("ChatResult.usage", () => {
	let runtime: Runtime;

	afterAll(async () => {
		await runtime.shutdown();
	});

	it("is populated with all TurnUsage fields after Runtime.chat()", async () => {
		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
		});
		await provisionTestWorkspace(runtime);

		const result = await runtime.chat({ message: "Hello usage", workspaceId: TEST_WORKSPACE_ID });

		// usage object must exist
		expect(result.usage).toBeDefined();
		expect(typeof result.usage).toBe("object");

		// All TurnUsage fields present and typed correctly
		expect(typeof result.usage.inputTokens).toBe("number");
		expect(typeof result.usage.outputTokens).toBe("number");
		expect(typeof result.usage.cacheReadTokens).toBe("number");
		expect(typeof result.usage.costUsd).toBe("number");
		expect(typeof result.usage.model).toBe("string");
		expect(typeof result.usage.llmMs).toBe("number");
		expect(typeof result.usage.iterations).toBe("number");

		// costUsd must be a finite number (not NaN/Infinity)
		expect(Number.isFinite(result.usage.costUsd)).toBe(true);

		// EchoModelAdapter returns text.length for both input/output tokens
		expect(result.usage.inputTokens).toBeGreaterThan(0);
		expect(result.usage.outputTokens).toBeGreaterThan(0);

		// Model string should be non-empty
		expect(result.usage.model.length).toBeGreaterThan(0);

		// At least 1 iteration
		expect(result.usage.iterations).toBeGreaterThanOrEqual(1);
	});

	it("usage token counts match top-level inputTokens/outputTokens", async () => {
		const result = await runtime.chat({ message: "Token match", workspaceId: TEST_WORKSPACE_ID });

		expect(result.usage.inputTokens).toBe(result.inputTokens);
		expect(result.usage.outputTokens).toBe(result.outputTokens);
	});
});

describe("per-conversation token accumulation", () => {
	it("totalInputTokens and totalOutputTokens accumulate across turns", async () => {
		const workDir = join(usageTestDir, "accum");
		mkdirSync(workDir, { recursive: true });
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir,
		});
		await provisionTestWorkspace(runtime);

		// Turn 1
		const turn1 = await runtime.chat({ message: "First turn", workspaceId: TEST_WORKSPACE_ID });
		const turn1Input = turn1.usage.inputTokens;
		const turn1Output = turn1.usage.outputTokens;
		const turn1Cost = turn1.usage.costUsd;

		// Turn 2 on same conversation
		const turn2 = await runtime.chat({
			message: "Second turn",
			conversationId: turn1.conversationId,
			workspaceId: TEST_WORKSPACE_ID,
		});
		const turn2Input = turn2.usage.inputTokens;
		const turn2Output = turn2.usage.outputTokens;
		const turn2Cost = turn2.usage.costUsd;

		// Turn 3 on same conversation
		const turn3 = await runtime.chat({
			message: "Third turn",
			conversationId: turn1.conversationId,
			workspaceId: TEST_WORKSPACE_ID,
		});
		const turn3Input = turn3.usage.inputTokens;
		const turn3Output = turn3.usage.outputTokens;
		const turn3Cost = turn3.usage.costUsd;

		// Verify per-turn usage values are all positive and consistent
		expect(turn1Input).toBeGreaterThan(0);
		expect(turn2Input).toBeGreaterThan(0);
		expect(turn3Input).toBeGreaterThan(0);
		expect(turn1Output).toBeGreaterThan(0);
		expect(turn2Output).toBeGreaterThan(0);
		expect(turn3Output).toBeGreaterThan(0);

		// Verify all turns used the same conversation
		expect(turn2.conversationId).toBe(turn1.conversationId);
		expect(turn3.conversationId).toBe(turn1.conversationId);

		// Wait for async metadata cache updates to flush (debounced writes)
		await new Promise((r) => setTimeout(r, 1500));

		// Verify conversation-level totals via the store.
		// Note: metadata flush is async/debounced — totals should include at least 2 turns.
		const store = runtime.getStore(TEST_WORKSPACE_ID);
		const conversation = await store.load(turn1.conversationId);
		expect(conversation).not.toBeNull();

		const expectedInput = turn1Input + turn2Input + turn3Input;
		const expectedOutput = turn1Output + turn2Output + turn3Output;
		// Allow for async flush — totals should be at least 2 turns' worth
		expect(conversation!.totalInputTokens).toBeGreaterThanOrEqual(turn1Input + turn2Input);
		expect(conversation!.totalInputTokens).toBeLessThanOrEqual(expectedInput);
		expect(conversation!.totalOutputTokens).toBeGreaterThanOrEqual(turn1Output + turn2Output);
		expect(conversation!.totalOutputTokens).toBeLessThanOrEqual(expectedOutput);

		await runtime.shutdown();
	});

	it("separate conversations accumulate independently", async () => {
		const workDir = join(usageTestDir, "independent");
		mkdirSync(workDir, { recursive: true });
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir,
		});
		await provisionTestWorkspace(runtime);

		// Conversation A: 2 turns
		const a1 = await runtime.chat({ message: "Alpha one", workspaceId: TEST_WORKSPACE_ID });
		await runtime.chat({
			message: "Alpha two",
			conversationId: a1.conversationId,
			workspaceId: TEST_WORKSPACE_ID,
		});

		// Conversation B: 1 turn
		const b1 = await runtime.chat({ message: "Beta one", workspaceId: TEST_WORKSPACE_ID });

		// Wait for async metadata cache updates to flush
		await new Promise((r) => setTimeout(r, 200));

		const store = runtime.getStore(TEST_WORKSPACE_ID);
		const convA = await store.load(a1.conversationId);
		const convB = await store.load(b1.conversationId);

		expect(convA).not.toBeNull();
		expect(convB).not.toBeNull();

		// A has 2 turns worth of tokens, B has 1
		expect(convA!.totalInputTokens).toBeGreaterThan(convB!.totalInputTokens);

		// Neither should be zero
		expect(convA!.totalInputTokens).toBeGreaterThan(0);
		expect(convB!.totalInputTokens).toBeGreaterThan(0);
		expect(convA!.totalCostUsd).toBeGreaterThanOrEqual(0);
		expect(convB!.totalCostUsd).toBeGreaterThanOrEqual(0);

		await runtime.shutdown();
	});
});
