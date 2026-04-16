import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryConversationStore } from "../../src/conversation/memory-store.ts";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import type {
	Conversation,
	ConversationStore,
	StoredMessage,
} from "../../src/conversation/types.ts";

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

function tempDir(): string {
	const dir = join(tmpdir(), `nb-store-v2-${crypto.randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Shared tests that run against both InMemoryConversationStore and JsonlConversationStore.
 */
function storeV2Tests(
	name: string,
	makeStore: () => { store: ConversationStore; cleanup: () => void },
) {
	describe(name, () => {
		let store: ConversationStore;
		let cleanup: () => void;

		beforeEach(() => {
			const s = makeStore();
			store = s.store;
			cleanup = s.cleanup;
		});

		afterEach(() => {
			cleanup();
		});

		// --- create() ---

		it("create() produces conversation with full enriched metadata", async () => {
			const conv = await store.create();
			expect(conv.id).toMatch(/^conv_/);
			expect(conv.createdAt).toBeTruthy();
			expect(conv.updatedAt).toBe(conv.createdAt);
			expect(conv.title).toBeNull();
			expect(conv.totalInputTokens).toBe(0);
			expect(conv.totalOutputTokens).toBe(0);
			expect(conv.totalCostUsd).toBe(0);
			expect(conv.lastModel).toBeNull();
		});

		// --- append() with token accumulation ---

		it("append() with assistant message accumulates token counts", async () => {
			const conv = await store.create();

			await store.append(conv, msg("user", "Hello"));
			await store.append(
				conv,
				assistantMsg("Hi there", {
					inputTokens: 100,
					outputTokens: 50,
					costUsd: 0.005,
					model: "claude-sonnet-4-5-20250929",
				}),
			);

			expect(conv.totalInputTokens).toBe(100);
			expect(conv.totalOutputTokens).toBe(50);
			expect(conv.totalCostUsd).toBeCloseTo(0.005);
			expect(conv.lastModel).toBe("claude-sonnet-4-5-20250929");

			// Second assistant message accumulates further
			await store.append(
				conv,
				assistantMsg("More", {
					inputTokens: 200,
					outputTokens: 75,
					costUsd: 0.01,
					model: "claude-sonnet-4-5-20250929",
				}),
			);

			expect(conv.totalInputTokens).toBe(300);
			expect(conv.totalOutputTokens).toBe(125);
			expect(conv.totalCostUsd).toBeCloseTo(0.015);
		});

		it("append() updates updatedAt from message timestamp", async () => {
			const conv = await store.create();
			const originalUpdatedAt = conv.updatedAt;

			const laterTimestamp = new Date(
				Date.now() + 5000,
			).toISOString();
			await store.append(conv, {
				role: "user",
				content: "later message",
				timestamp: laterTimestamp,
			});

			expect(conv.updatedAt).toBe(laterTimestamp);
			expect(conv.updatedAt).not.toBe(originalUpdatedAt);
		});

		it("append() does not accumulate tokens from user messages", async () => {
			const conv = await store.create();
			// User messages should not have metadata accumulated
			await store.append(conv, msg("user", "Hello"));
			expect(conv.totalInputTokens).toBe(0);
			expect(conv.totalOutputTokens).toBe(0);
		});

		// --- history() preserves metadata ---

		it("history() preserves metadata on messages", async () => {
			const conv = await store.create();
			await store.append(
				conv,
				assistantMsg("Result", {
					skill: "test-skill",
					toolCalls: [
						{
							id: "tc1",
							name: "test_tool",
							input: { q: "query" },
							output: "result",
							ok: true,
							ms: 42,
						},
					],
					inputTokens: 100,
					outputTokens: 50,
					model: "claude-sonnet-4-5-20250929",
				}),
			);

			const history = await store.history(conv);
			expect(history).toHaveLength(1);
			expect(history[0]!.metadata).toBeDefined();
			expect(history[0]!.metadata!.skill).toBe("test-skill");
			expect(history[0]!.metadata!.toolCalls).toHaveLength(1);
			expect(history[0]!.metadata!.inputTokens).toBe(100);
			expect(history[0]!.metadata!.model).toBe("claude-sonnet-4-5-20250929");
		});

		// --- delete() ---

		it("delete() removes conversation and returns true", async () => {
			const conv = await store.create();
			await store.append(conv, msg("user", "Hello"));

			const result = await store.delete(conv.id);
			expect(result).toBe(true);

			const loaded = await store.load(conv.id);
			expect(loaded).toBeNull();
		});

		it("delete() returns false for non-existent conversation", async () => {
			const result = await store.delete("conv_0000000000000000");
			expect(result).toBe(false);
		});

		it("second delete() returns false", async () => {
			const conv = await store.create();
			expect(await store.delete(conv.id)).toBe(true);
			expect(await store.delete(conv.id)).toBe(false);
		});

		// --- update() ---

		it("update() changes title in metadata", async () => {
			const conv = await store.create();
			expect(conv.title).toBeNull();

			const updated = await store.update(conv.id, {
				title: "New Title",
			});
			expect(updated).not.toBeNull();
			expect(updated!.title).toBe("New Title");
			expect(updated!.id).toBe(conv.id);
		});

		it("update() returns null for non-existent conversation", async () => {
			const result = await store.update("conv_0000000000000000", {
				title: "Nope",
			});
			expect(result).toBeNull();
		});

		it("update() persists title on reload", async () => {
			const conv = await store.create();
			await store.update(conv.id, { title: "Persisted Title" });

			const loaded = await store.load(conv.id);
			expect(loaded!.title).toBe("Persisted Title");
		});

		// --- fork() ---

		it("fork() creates new conversation with all messages", async () => {
			const conv = await store.create();
			await store.append(conv, msg("user", "First"));
			await store.append(
				conv,
				assistantMsg("Second", {
					inputTokens: 100,
					outputTokens: 50,
					costUsd: 0.005,
					model: "claude-sonnet-4-5-20250929",
				}),
			);
			await store.append(conv, msg("user", "Third"));

			const forked = await store.fork(conv.id);
			expect(forked).not.toBeNull();
			expect(forked!.id).not.toBe(conv.id);

			const history = await store.history(forked!);
			expect(history).toHaveLength(3);
			expect(history[0]!.content).toBe("First");
			expect(history[1]!.content).toBe("Second");
			expect(history[2]!.content).toBe("Third");
		});

		it("fork() with atMessage truncates messages", async () => {
			const conv = await store.create();
			await store.append(conv, msg("user", "First"));
			await store.append(conv, msg("assistant", "Second"));
			await store.append(conv, msg("user", "Third"));

			const forked = await store.fork(conv.id, 2);
			expect(forked).not.toBeNull();

			const history = await store.history(forked!);
			expect(history).toHaveLength(2);
			expect(history[0]!.content).toBe("First");
			expect(history[1]!.content).toBe("Second");
		});

		it("fork() with atMessage=0 creates empty conversation", async () => {
			const conv = await store.create();
			await store.append(conv, msg("user", "First"));

			const forked = await store.fork(conv.id, 0);
			expect(forked).not.toBeNull();

			const history = await store.history(forked!);
			expect(history).toHaveLength(0);
		});

		it("fork() returns null for non-existent conversation", async () => {
			const result = await store.fork("conv_0000000000000000");
			expect(result).toBeNull();
		});

		it("fork() re-accumulates token stats from copied messages", async () => {
			const conv = await store.create();
			await store.append(conv, msg("user", "Hello"));
			await store.append(
				conv,
				assistantMsg("Reply 1", {
					inputTokens: 100,
					outputTokens: 50,
					costUsd: 0.005,
					model: "claude-sonnet-4-5-20250929",
				}),
			);
			await store.append(conv, msg("user", "More"));
			await store.append(
				conv,
				assistantMsg("Reply 2", {
					inputTokens: 200,
					outputTokens: 75,
					costUsd: 0.01,
					model: "claude-sonnet-4-5-20250929",
				}),
			);

			// Fork with only first 2 messages (user + first assistant)
			const forked = await store.fork(conv.id, 2);
			expect(forked!.totalInputTokens).toBe(100);
			expect(forked!.totalOutputTokens).toBe(50);
			expect(forked!.totalCostUsd).toBeCloseTo(0.005);
		});

		// --- list() with search ---

		it("list() with search returns matching conversations", async () => {
			const conv1 = await store.create();
			await store.update(conv1.id, { title: "Deploy Pipeline" });
			await store.append(conv1, msg("user", "Deploy stuff"));

			const conv2 = await store.create();
			await store.update(conv2.id, { title: "Budget Review" });
			await store.append(conv2, msg("user", "Review budget"));

			const result = await store.list({ search: "deploy" });
			expect(result.conversations).toHaveLength(1);
			expect(result.conversations[0]!.id).toBe(conv1.id);
		});
	});
}

// Run shared tests for both stores
storeV2Tests("InMemoryConversationStore (v2)", () => ({
	store: new InMemoryConversationStore(),
	cleanup: () => {},
}));

storeV2Tests("JsonlConversationStore (v2)", () => {
	const dir = tempDir();
	return {
		store: new JsonlConversationStore(dir),
		cleanup: () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true });
		},
	};
});

// --- JSONL-specific tests ---

describe("JsonlConversationStore (JSONL-specific)", () => {
	let dir: string;

	beforeEach(() => {
		dir = tempDir();
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	});

	it("create() writes JSONL with enriched line 1", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();

		const filePath = join(dir, `${conv.id}.jsonl`);
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(Boolean);

		expect(lines).toHaveLength(1);
		const meta = JSON.parse(lines[0]!);
		expect(meta.id).toBe(conv.id);
		expect(meta.createdAt).toBeTruthy();
		expect(meta.updatedAt).toBe(meta.createdAt);
		expect(meta.title).toBeNull();
		expect(meta.totalInputTokens).toBe(0);
		expect(meta.totalOutputTokens).toBe(0);
		expect(meta.totalCostUsd).toBe(0);
		expect(meta.lastModel).toBeNull();
	});

	it("load() on old-format JSONL defaults missing fields", async () => {
		// Write an old-format file with only id and createdAt
		const id = "conv_01d4f0000000000a";
		const meta = JSON.stringify({
			id,
			createdAt: "2024-06-01T00:00:00.000Z",
		});
		const userMsg = JSON.stringify({
			role: "user",
			content: "old message",
			timestamp: "2024-06-01T00:00:00.000Z",
		});
		writeFileSync(join(dir, `${id}.jsonl`), `${meta}\n${userMsg}\n`);

		const store = new JsonlConversationStore(dir);
		const loaded = await store.load(id);

		expect(loaded).not.toBeNull();
		expect(loaded!.id).toBe(id);
		expect(loaded!.updatedAt).toBe("2024-06-01T00:00:00.000Z"); // falls back to createdAt
		expect(loaded!.title).toBeNull();
		expect(loaded!.totalInputTokens).toBe(0);
		expect(loaded!.totalOutputTokens).toBe(0);
		expect(loaded!.totalCostUsd).toBe(0);
		expect(loaded!.lastModel).toBeNull();
	});

	it("append() re-writes line 1 atomically (verify file content)", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();

		await store.append(conv, msg("user", "Hello"));
		await store.append(
			conv,
			assistantMsg("Hi there", {
				inputTokens: 150,
				outputTokens: 60,
				costUsd: 0.007,
				model: "claude-sonnet-4-5-20250929",
			}),
		);

		// Read the raw file and verify line 1 has updated metadata
		const filePath = join(dir, `${conv.id}.jsonl`);
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(Boolean);

		expect(lines).toHaveLength(3); // metadata + 2 messages
		const meta = JSON.parse(lines[0]!);
		expect(meta.totalInputTokens).toBe(150);
		expect(meta.totalOutputTokens).toBe(60);
		expect(meta.totalCostUsd).toBeCloseTo(0.007);
		expect(meta.lastModel).toBe("claude-sonnet-4-5-20250929");
	});

	it("append() does not leave temp files on success", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();
		await store.append(conv, msg("user", "Hello"));

		const files = require("node:fs")
			.readdirSync(dir)
			.filter((f: string) => f.includes(".tmp."));
		expect(files).toHaveLength(0);
	});

	it("update() changes title in the actual JSONL file", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();
		await store.append(conv, msg("user", "Hello"));

		await store.update(conv.id, { title: "My Chat" });

		const filePath = join(dir, `${conv.id}.jsonl`);
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		const meta = JSON.parse(lines[0]!);
		expect(meta.title).toBe("My Chat");

		// Messages should still be there
		expect(lines).toHaveLength(2); // metadata + 1 message
	});

	it("list() delegates to ConversationIndex", async () => {
		const store = new JsonlConversationStore(dir);

		const conv1 = await store.create();
		await store.append(conv1, msg("user", "First conversation"));

		const conv2 = await store.create();
		await store.append(conv2, msg("user", "Second conversation"));

		const result = await store.list();
		expect(result.totalCount).toBe(2);
		expect(result.conversations).toHaveLength(2);
	});

	it("list() with cursor pagination works", async () => {
		const store = new JsonlConversationStore(dir);

		// Create 3 conversations with distinct timestamps
		const conv1 = await store.create();
		await store.append(conv1, {
			role: "user",
			content: "First",
			timestamp: "2025-01-01T00:00:00.000Z",
		});

		const conv2 = await store.create();
		await store.append(conv2, {
			role: "user",
			content: "Second",
			timestamp: "2025-02-01T00:00:00.000Z",
		});

		const conv3 = await store.create();
		await store.append(conv3, {
			role: "user",
			content: "Third",
			timestamp: "2025-03-01T00:00:00.000Z",
		});

		const page1 = await store.list({ limit: 2 });
		expect(page1.conversations).toHaveLength(2);
		expect(page1.nextCursor).not.toBeNull();
		expect(page1.totalCount).toBe(3);

		const page2 = await store.list({
			limit: 2,
			cursor: page1.nextCursor!,
		});
		expect(page2.conversations).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
	});

	it("delete() removes the JSONL file", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();
		const filePath = join(dir, `${conv.id}.jsonl`);

		expect(existsSync(filePath)).toBe(true);
		await store.delete(conv.id);
		expect(existsSync(filePath)).toBe(false);
	});

	it("fork() creates a new JSONL file", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();
		await store.append(conv, msg("user", "Original"));
		await store.append(conv, msg("assistant", "Reply"));

		const forked = await store.fork(conv.id);
		expect(forked).not.toBeNull();

		const forkedPath = join(dir, `${forked!.id}.jsonl`);
		expect(existsSync(forkedPath)).toBe(true);

		// Verify the forked file has correct content
		const content = readFileSync(forkedPath, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		expect(lines).toHaveLength(3); // metadata + 2 messages
	});
});

// --- flush() behavioral tests ---

describe("JsonlConversationStore flush()", () => {
	let dir: string;

	beforeEach(() => {
		dir = tempDir();
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	});

	it("flush() resolves after background write completes", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();

		// Fire-and-forget update (simulates what runtime does for auto-title)
		void store.update(conv.id, { title: "Background Title" });

		// flush() must wait for the background write to finish
		await store.flush();

		const loaded = await store.load(conv.id);
		expect(loaded!.title).toBe("Background Title");
	});

	it("flush() resolves immediately when no writes pending", async () => {
		const store = new JsonlConversationStore(dir);

		const start = Date.now();
		await store.flush();
		const elapsed = Date.now() - start;

		// Should resolve essentially immediately — well under 5ms
		expect(elapsed).toBeLessThan(5);
	});

	it("flush() is safe to call concurrently", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();

		// Fire a background write
		void store.update(conv.id, { title: "Concurrent Title" });

		// Two concurrent flush() calls — both should resolve
		const [r1, r2] = await Promise.all([store.flush(), store.flush()]);
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();

		// Data must be visible after both flush calls settle
		const loaded = await store.load(conv.id);
		expect(loaded!.title).toBe("Concurrent Title");
	});

	it("reading after flush() sees all committed data", async () => {
		const store = new JsonlConversationStore(dir);
		const conv = await store.create();

		// Simulate runtime auto-title: fire and forget
		void store.update(conv.id, { title: "Auto Title" });

		// Without flush() this read would race. With flush() it must see the title.
		await store.flush();
		const loaded = await store.load(conv.id);

		expect(loaded).not.toBeNull();
		expect(loaded!.title).toBe("Auto Title");
	});
});
