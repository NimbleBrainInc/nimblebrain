import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import type { StoredMessage } from "../../src/conversation/types.ts";

function tempDir(): string {
	const dir = join(tmpdir(), `nb-integration-${crypto.randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function msg(role: "user" | "assistant", content: string): StoredMessage {
	return { role, content, timestamp: new Date().toISOString() };
}

function assistantMsg(
	content: string,
	metadata: StoredMessage["metadata"],
): StoredMessage {
	return {
		role: "assistant",
		content,
		timestamp: new Date().toISOString(),
		metadata,
	};
}

// ---------------------------------------------------------------------------
// 1. Store-level full lifecycle integration
// ---------------------------------------------------------------------------

describe("Conversation full lifecycle (store-level)", () => {
	let dir: string;
	let store: JsonlConversationStore;

	beforeEach(() => {
		dir = tempDir();
		store = new JsonlConversationStore(dir);
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	});

	it("create → append 3 messages → list (verify tokens) → rename → search → fork → delete", async () => {
		// --- create ---
		const conv = await store.create();
		expect(conv.id).toMatch(/^conv_/);
		expect(conv.totalInputTokens).toBe(0);

		// --- append 3 messages ---
		await store.append(conv, msg("user", "Tell me about deployment pipelines"));
		await store.append(
			conv,
			assistantMsg("Deployment pipelines automate releases...", {
				inputTokens: 200,
				outputTokens: 80,
				costUsd: 0.008,
				model: "claude-sonnet-4-5-20250929",
			}),
		);
		await store.append(conv, msg("user", "Can you show me an example?"));

		// --- list and verify token accumulation ---
		const listResult = await store.list();
		expect(listResult.totalCount).toBe(1);
		const summary = listResult.conversations[0]!;
		expect(summary.id).toBe(conv.id);
		expect(summary.totalInputTokens).toBe(200);
		expect(summary.totalOutputTokens).toBe(80);
		expect(summary.totalCostUsd).toBeCloseTo(0.008);
		expect(summary.messageCount).toBe(3);

		// --- rename ---
		const updated = await store.update(conv.id, { title: "Deploy Pipeline Guide" });
		expect(updated).not.toBeNull();
		expect(updated!.title).toBe("Deploy Pipeline Guide");

		// verify title persists on reload
		const reloaded = await store.load(conv.id);
		expect(reloaded!.title).toBe("Deploy Pipeline Guide");

		// --- search ---
		const searchHit = await store.list({ search: "deploy" });
		expect(searchHit.conversations).toHaveLength(1);
		expect(searchHit.conversations[0]!.id).toBe(conv.id);

		const searchMiss = await store.list({ search: "quantum" });
		expect(searchMiss.conversations).toHaveLength(0);

		// --- fork (at message 2 — user + first assistant) ---
		const forked = await store.fork(conv.id, 2);
		expect(forked).not.toBeNull();
		expect(forked!.id).not.toBe(conv.id);
		expect(forked!.totalInputTokens).toBe(200);
		expect(forked!.totalOutputTokens).toBe(80);

		const forkedHistory = await store.history(forked!);
		expect(forkedHistory).toHaveLength(2);
		expect(forkedHistory[0]!.content).toBe("Tell me about deployment pipelines");
		expect(forkedHistory[1]!.content).toBe("Deployment pipelines automate releases...");

		// original still has 3 messages
		const originalHistory = await store.history(conv);
		expect(originalHistory).toHaveLength(3);

		// both appear in list
		const bothList = await store.list();
		expect(bothList.totalCount).toBe(2);

		// --- delete original ---
		const deleted = await store.delete(conv.id);
		expect(deleted).toBe(true);

		// verify gone
		const afterDelete = await store.load(conv.id);
		expect(afterDelete).toBeNull();

		// fork still exists
		const afterDeleteList = await store.list();
		expect(afterDeleteList.totalCount).toBe(1);
		expect(afterDeleteList.conversations[0]!.id).toBe(forked!.id);
	});
});

// ---------------------------------------------------------------------------
// 2. Backward compatibility: old-format JSONL → append → verify migration
// ---------------------------------------------------------------------------

describe("Backward compatibility: old-format JSONL → append", () => {
	let dir: string;

	beforeEach(() => {
		dir = tempDir();
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	});

	it("loads old-format JSONL, appends new messages, and accumulates tokens correctly", async () => {
		// Write an old-format file (only id + createdAt on line 1, no enriched fields)
		const id = "conv_1e9ac400000000b1";
		const createdAt = "2024-06-15T10:00:00.000Z";
		const metaLine = JSON.stringify({ id, createdAt });
		const oldUserMsg = JSON.stringify({
			role: "user",
			content: "old question about budgets",
			timestamp: createdAt,
		});
		const oldAssistantMsg = JSON.stringify({
			role: "assistant",
			content: "Here is the budget breakdown.",
			timestamp: createdAt,
		});
		writeFileSync(
			join(dir, `${id}.jsonl`),
			`${metaLine}\n${oldUserMsg}\n${oldAssistantMsg}\n`,
		);

		const store = new JsonlConversationStore(dir);
		const loaded = await store.load(id);

		// Verify defaults applied
		expect(loaded).not.toBeNull();
		expect(loaded!.updatedAt).toBe(createdAt);
		expect(loaded!.title).toBeNull();
		expect(loaded!.totalInputTokens).toBe(0);
		expect(loaded!.totalOutputTokens).toBe(0);
		expect(loaded!.lastModel).toBeNull();

		// Append a new assistant message with token metadata
		await store.append(
			loaded!,
			assistantMsg("Updated budget analysis...", {
				inputTokens: 350,
				outputTokens: 120,
				costUsd: 0.015,
				model: "claude-sonnet-4-5-20250929",
			}),
		);

		// Token accumulation should work on migrated conversation
		expect(loaded!.totalInputTokens).toBe(350);
		expect(loaded!.totalOutputTokens).toBe(120);
		expect(loaded!.totalCostUsd).toBeCloseTo(0.015);
		expect(loaded!.lastModel).toBe("claude-sonnet-4-5-20250929");

		// Verify history includes old + new messages
		const history = await store.history(loaded!);
		expect(history).toHaveLength(3);
		expect(history[0]!.content).toBe("old question about budgets");
		expect(history[2]!.content).toBe("Updated budget analysis...");

		// Reload from disk to verify persistence
		const store2 = new JsonlConversationStore(dir);
		const reloaded = await store2.load(id);
		expect(reloaded!.totalInputTokens).toBe(350);
		expect(reloaded!.totalOutputTokens).toBe(120);
		expect(reloaded!.lastModel).toBe("claude-sonnet-4-5-20250929");
	});
});

// ---------------------------------------------------------------------------
// 3. API full-flow integration
// ---------------------------------------------------------------------------

describe("API full-flow integration", () => {
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;

	beforeAll(async () => {
		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
		});

		handle = startServer({ runtime, port: 0 });
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
	});

	it.skip("chat → list → rename → search → fork → delete → verify gone", async () => {
		// --- create via chat ---
		const chatRes = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "Tell me about integration testing" }),
		});
		expect(chatRes.status).toBe(200);
		const chatBody = await chatRes.json();
		const convId: string = chatBody.conversationId;
		expect(convId).toMatch(/^conv_/);

		// --- list and verify it appears ---
		const listRes = await fetch(`${baseUrl}/v1/conversations`);
		expect(listRes.status).toBe(200);
		const listBody = await listRes.json();
		const found = listBody.conversations.some(
			(c: { id: string }) => c.id === convId,
		);
		expect(found).toBe(true);

		// --- rename ---
		const renameRes = await fetch(`${baseUrl}/v1/conversations/${convId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Integration Testing Guide" }),
		});
		expect(renameRes.status).toBe(200);
		const renameBody = await renameRes.json();
		expect(renameBody.title).toBe("Integration Testing Guide");

		// --- search by title ---
		const searchRes = await fetch(
			`${baseUrl}/v1/conversations?search=Integration`,
		);
		expect(searchRes.status).toBe(200);
		const searchBody = await searchRes.json();
		const searchFound = searchBody.conversations.some(
			(c: { id: string }) => c.id === convId,
		);
		expect(searchFound).toBe(true);

		// --- fork ---
		const forkRes = await fetch(
			`${baseUrl}/v1/conversations/${convId}/fork`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ atMessage: 1 }),
			},
		);
		expect(forkRes.status).toBe(200);
		const forkBody = await forkRes.json();
		expect(forkBody.id).toBeTruthy();
		expect(forkBody.id).not.toBe(convId);
		expect(forkBody.forkedFrom).toBe(convId);
		expect(forkBody.messageCount).toBe(1);

		// --- delete original ---
		const deleteRes = await fetch(
			`${baseUrl}/v1/conversations/${convId}`,
			{ method: "DELETE" },
		);
		expect(deleteRes.status).toBe(200);
		const deleteBody = await deleteRes.json();
		expect(deleteBody.deleted).toBe(true);

		// --- verify original is gone ---
		const verifyDeleteRes = await fetch(
			`${baseUrl}/v1/conversations/${convId}`,
			{ method: "DELETE" },
		);
		expect(verifyDeleteRes.status).toBe(404);

		// --- verify fork still accessible ---
		const forkHistoryRes = await fetch(
			`${baseUrl}/v1/conversations/${forkBody.id}/history`,
		);
		expect(forkHistoryRes.status).toBe(200);
		const forkHistoryBody = await forkHistoryRes.json();
		expect(forkHistoryBody.messages).toHaveLength(1);

		// cleanup: delete the fork too
		await fetch(`${baseUrl}/v1/conversations/${forkBody.id}`, {
			method: "DELETE",
		});
	});
});
