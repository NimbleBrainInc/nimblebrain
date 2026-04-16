import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { readConversation } from "../../../../../src/bundles/conversations/src/jsonl-reader.ts";
import { handleUpdate } from "../../../../../src/bundles/conversations/src/tools/update.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-update");

function writeTmpFile(name: string, lines: string[]): string {
	const path = join(TMP_DIR, name);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

function makeMeta(overrides: Record<string, unknown> = {}) {
	return {
		id: "conv_test001",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:05:00.000Z",
		title: "Original title",
		totalInputTokens: 500,
		totalOutputTokens: 300,
		totalCostUsd: 0.02,
		lastModel: "claude-sonnet-4-5-20250929",
		...overrides,
	};
}

function makeMessages() {
	return [
		{ role: "user", content: "Hello there", timestamp: "2025-01-01T00:01:00.000Z" },
		{
			role: "assistant",
			content: "Hi! How can I help?",
			timestamp: "2025-01-01T00:02:00.000Z",
			metadata: { inputTokens: 100, outputTokens: 60, model: "claude-sonnet-4-5-20250929" },
		},
		{ role: "user", content: "What is MCP?", timestamp: "2025-01-01T00:03:00.000Z" },
		{
			role: "assistant",
			content: "MCP stands for Model Context Protocol.",
			timestamp: "2025-01-01T00:04:00.000Z",
			metadata: { inputTokens: 200, outputTokens: 120, model: "claude-sonnet-4-5-20250929" },
		},
		{ role: "user", content: "Thanks!", timestamp: "2025-01-01T00:05:00.000Z" },
	];
}

let index: ConversationIndex;

beforeEach(async () => {
	mkdirSync(TMP_DIR, { recursive: true });
	index = new ConversationIndex();
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Update title on a valid conversation
// ---------------------------------------------------------------------------

describe("handleUpdate", () => {
	test("updates title and returns updated metadata", async () => {
		const meta = makeMeta();
		const messages = makeMessages();
		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		writeTmpFile("conv_test001.jsonl", lines);

		await index.build(TMP_DIR);

		const result = (await handleUpdate({ id: "conv_test001", title: "New title" }, index)) as Record<string, unknown>;

		expect(result.id).toBe("conv_test001");
		expect(result.title).toBe("New title");
		expect(result.messageCount).toBe(5);
		expect(result.totalInputTokens).toBe(500);
		expect(result.totalOutputTokens).toBe(300);
		expect(result.lastModel).toBe("claude-sonnet-4-5-20250929");
		expect(result.preview).toBe("Hello there");
		// updatedAt should be refreshed (not the original)
		expect(result.updatedAt).not.toBe("2025-01-01T00:05:00.000Z");
	});

	test("messages are preserved unchanged after update", async () => {
		const meta = makeMeta();
		const messages = makeMessages();
		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		writeTmpFile("conv_test001.jsonl", lines);

		await index.build(TMP_DIR);

		await handleUpdate({ id: "conv_test001", title: "Updated" }, index);

		// Re-read the file and verify all messages are intact
		const filePath = join(TMP_DIR, "conv_test001.jsonl");
		const conv = await readConversation(filePath);
		expect(conv).not.toBeNull();
		expect(conv!.meta.title).toBe("Updated");
		expect(conv!.messageCount).toBe(5);
		expect(conv!.messages[0]!.content).toBe("Hello there");
		expect(conv!.messages[1]!.content).toBe("Hi! How can I help?");
		expect(conv!.messages[2]!.content).toBe("What is MCP?");
		expect(conv!.messages[3]!.content).toBe("MCP stands for Model Context Protocol.");
		expect(conv!.messages[4]!.content).toBe("Thanks!");
	});

	test("file is not corrupted after update — all lines parseable", async () => {
		const meta = makeMeta();
		const messages = makeMessages();
		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		writeTmpFile("conv_test001.jsonl", lines);

		await index.build(TMP_DIR);

		await handleUpdate({ id: "conv_test001", title: "Integrity check" }, index);

		const filePath = join(TMP_DIR, "conv_test001.jsonl");
		const content = readFileSync(filePath, "utf-8");
		const fileLines = content.split("\n").filter(Boolean);

		// Should have 6 lines: 1 metadata + 5 messages
		expect(fileLines).toHaveLength(6);

		// Every line should be valid JSON
		for (const line of fileLines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}

		// First line should have the new title
		const updatedMeta = JSON.parse(fileLines[0]!) as Record<string, unknown>;
		expect(updatedMeta.title).toBe("Integrity check");
	});

	// ---------------------------------------------------------------------------
	// After update, readConversation returns the new title
	// ---------------------------------------------------------------------------

	test("readConversation returns the new title after update", async () => {
		const meta = makeMeta({ title: "Before" });
		const messages = makeMessages();
		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		writeTmpFile("conv_test001.jsonl", lines);

		await index.build(TMP_DIR);

		await handleUpdate({ id: "conv_test001", title: "After" }, index);

		const filePath = join(TMP_DIR, "conv_test001.jsonl");
		const conv = await readConversation(filePath);
		expect(conv).not.toBeNull();
		expect(conv!.meta.title).toBe("After");
	});

	// ---------------------------------------------------------------------------
	// Non-existent ID returns error
	// ---------------------------------------------------------------------------

	test("throws error for non-existent conversation ID", async () => {
		await index.build(TMP_DIR);

		await expect(
			handleUpdate({ id: "conv_nonexistent", title: "Nope" }, index),
		).rejects.toThrow("Conversation not found: conv_nonexistent");
	});

	// ---------------------------------------------------------------------------
	// Edge case: conversation with no messages
	// ---------------------------------------------------------------------------

	test("updates title on conversation with no messages", async () => {
		const meta = makeMeta({ id: "conv_empty" });
		writeTmpFile("conv_empty.jsonl", [JSON.stringify(meta)]);

		await index.build(TMP_DIR);

		const result = (await handleUpdate({ id: "conv_empty", title: "Empty conv" }, index)) as Record<string, unknown>;

		expect(result.id).toBe("conv_empty");
		expect(result.title).toBe("Empty conv");
		expect(result.messageCount).toBe(0);
		expect(result.preview).toBe("");
	});
});
