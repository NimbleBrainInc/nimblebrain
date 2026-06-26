import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { estimateCost } from "../../src/usage/cost.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const usageTestDir = join(tmpdir(), `nimblebrain-usage-${Date.now()}`);

describe("ChatResult.usage", () => {
	let runtime: Runtime;

	afterAll(async () => {
		await runtime.shutdown();
		if (existsSync(usageTestDir)) rmSync(usageTestDir, { recursive: true });
	});

	it("is populated with all TurnUsage fields after Runtime.chat()", async () => {
		runtime = await Runtime.start({
			workDir: usageTestDir,
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
		});
		await provisionTestWorkspace(runtime);

		const result = await runtime.chat({ message: "Hello usage", workspaceId: TEST_WORKSPACE_ID });

		// usage object must exist
		expect(result.usage).toBeDefined();
		expect(typeof result.usage).toBe("object");

		// All TurnUsage fields present and typed correctly. Note that
		// `costUsd` is intentionally NOT on TurnUsage — cost is derived at
		// the API boundary via estimateCost(model, usage). Runtime.chat()
		// returns the raw token usage; callers compute dollars on demand.
		expect(typeof result.usage.inputTokens).toBe("number");
		expect(typeof result.usage.outputTokens).toBe("number");
		expect(typeof result.usage.model).toBe("string");
		expect(typeof result.usage.llmMs).toBe("number");
		expect(typeof result.usage.iterations).toBe("number");

		// Cost is computable from the usage struct.
		const costUsd = estimateCost(result.usage.model, result.usage);
		expect(Number.isFinite(costUsd)).toBe(true);

		// EchoModelAdapter returns text.length for both input/output tokens
		expect(result.usage.inputTokens).toBeGreaterThan(0);
		expect(result.usage.outputTokens).toBeGreaterThan(0);

		// Model string should be non-empty
		expect(result.usage.model.length).toBeGreaterThan(0);

		// At least 1 iteration
		expect(result.usage.iterations).toBeGreaterThanOrEqual(1);
	});
});

describe("per-conversation token accumulation", () => {
	// Totals are derived at read time from the conversation's events (or
	// legacy messages), not stored on the Conversation. The store's `list()`
	// returns a ConversationSummary with the derived totals — that's the
	// canonical surface for "how much has this conversation cost so far?".

	it("derived totals on the list summary accumulate across turns", async () => {
		const workDir = join(usageTestDir, "accum");
		mkdirSync(workDir, { recursive: true });
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir,
		});
		await provisionTestWorkspace(runtime);

		const turn1 = await runtime.chat({ message: "First turn", workspaceId: TEST_WORKSPACE_ID });
		const turn2 = await runtime.chat({
			message: "Second turn",
			conversationId: turn1.conversationId,
			workspaceId: TEST_WORKSPACE_ID,
		});
		const turn3 = await runtime.chat({
			message: "Third turn",
			conversationId: turn1.conversationId,
			workspaceId: TEST_WORKSPACE_ID,
		});

		// Per-turn usage is positive
		expect(turn1.usage.inputTokens).toBeGreaterThan(0);
		expect(turn2.usage.inputTokens).toBeGreaterThan(0);
		expect(turn3.usage.inputTokens).toBeGreaterThan(0);

		// All turns share the same conversation
		expect(turn2.conversationId).toBe(turn1.conversationId);
		expect(turn3.conversationId).toBe(turn1.conversationId);

		// Wait for async event writes to flush
		await new Promise((r) => setTimeout(r, 1500));

		// Derived totals from the list summary should be the sum of per-turn
		// usage. Allow for async flush — at least 2 turns must be visible.
		// Read the per-room store directly: a fresh store instance re-derives
		// each summary's totals from the conversation file, so the accumulated
		// per-turn tokens are visible. (The cross-room locator list is
		// create/delete-fresh, not append-fresh.) Dev-mode owner is
		// `usr_default`, focused on TEST_WORKSPACE_ID.
		const list = await runtime.roomConversationStore(TEST_WORKSPACE_ID, "usr_default").list();
		const summary = list.conversations.find((c) => c.id === turn1.conversationId);
		expect(summary).toBeDefined();

		const expectedInput = turn1.usage.inputTokens + turn2.usage.inputTokens + turn3.usage.inputTokens;
		const at_least_two = turn1.usage.inputTokens + turn2.usage.inputTokens;
		expect(summary!.totalInputTokens).toBeGreaterThanOrEqual(at_least_two);
		expect(summary!.totalInputTokens).toBeLessThanOrEqual(expectedInput);

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

		const a1 = await runtime.chat({ message: "Alpha one", workspaceId: TEST_WORKSPACE_ID });
		await runtime.chat({
			message: "Alpha two",
			conversationId: a1.conversationId,
			workspaceId: TEST_WORKSPACE_ID,
		});
		const b1 = await runtime.chat({ message: "Beta one", workspaceId: TEST_WORKSPACE_ID });

		await new Promise((r) => setTimeout(r, 1500));

		const list = await runtime.roomConversationStore(TEST_WORKSPACE_ID, "usr_default").list();
		const sumA = list.conversations.find((c) => c.id === a1.conversationId);
		const sumB = list.conversations.find((c) => c.id === b1.conversationId);

		expect(sumA).toBeDefined();
		expect(sumB).toBeDefined();

		// A has 2 turns of tokens, B has 1
		expect(sumA!.totalInputTokens).toBeGreaterThan(sumB!.totalInputTokens);
		expect(sumA!.totalInputTokens).toBeGreaterThan(0);
		expect(sumB!.totalInputTokens).toBeGreaterThan(0);
		expect(sumA!.totalCostUsd).toBeGreaterThanOrEqual(0);
		expect(sumB!.totalCostUsd).toBeGreaterThanOrEqual(0);

		await runtime.shutdown();
	});
});
