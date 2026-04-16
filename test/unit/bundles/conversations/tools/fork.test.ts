import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { readConversation } from "../../../../../src/bundles/conversations/src/jsonl-reader.ts";
import { handleFork } from "../../../../../src/bundles/conversations/src/tools/fork.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-fork");

function writeTmpFile(name: string, lines: string[]): string {
	const path = join(TMP_DIR, name);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

// Helpers to build test data
const SOURCE_ID = "conv_source00000001";

function makeMeta(overrides: Record<string, unknown> = {}) {
	return {
		id: SOURCE_ID,
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:05:00.000Z",
		title: "Source conversation",
		totalInputTokens: 400,
		totalOutputTokens: 240,
		totalCostUsd: 0.03,
		lastModel: "claude-sonnet-4-5-20250929",
		...overrides,
	};
}

function makeMessages() {
	return [
		{
			role: "user",
			content: "Hello there",
			timestamp: "2025-01-01T00:01:00.000Z",
		},
		{
			role: "assistant",
			content: "Hi! How can I help?",
			timestamp: "2025-01-01T00:02:00.000Z",
			metadata: {
				inputTokens: 100,
				outputTokens: 60,
				costUsd: 0.005,
				model: "claude-sonnet-4-5-20250929",
			},
		},
		{
			role: "user",
			content: "What is MCP?",
			timestamp: "2025-01-01T00:03:00.000Z",
		},
		{
			role: "assistant",
			content: "MCP stands for Model Context Protocol.",
			timestamp: "2025-01-01T00:04:00.000Z",
			metadata: {
				inputTokens: 200,
				outputTokens: 120,
				costUsd: 0.015,
				model: "claude-sonnet-4-5-20250929",
			},
		},
		{
			role: "user",
			content: "Thanks!",
			timestamp: "2025-01-01T00:05:00.000Z",
		},
	];
}

function writeSourceConversation(): string {
	const meta = makeMeta();
	const messages = makeMessages();
	const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
	return writeTmpFile(`${SOURCE_ID}.jsonl`, lines);
}

async function buildIndex(): Promise<ConversationIndex> {
	const index = new ConversationIndex();
	await index.build(TMP_DIR);
	return index;
}

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fork full conversation
// ---------------------------------------------------------------------------

describe("handleFork", () => {
	test("fork full conversation — new file with all messages, same token totals", async () => {
		writeSourceConversation();
		const index = await buildIndex();

		const result = (await handleFork({ id: SOURCE_ID }, index)) as Record<string, unknown>;

		// Result should have a new ID
		expect(result.id).not.toBe(SOURCE_ID);
		expect(typeof result.id).toBe("string");
		expect((result.id as string).startsWith("conv_")).toBe(true);
		expect((result.id as string).length).toBe(5 + 16); // "conv_" + 16 hex chars

		// Message count should match
		expect(result.messageCount).toBe(5);

		// Token totals should match source (recalculated from assistant messages)
		// Source has 2 assistant messages: 100+200=300 input, 60+120=180 output, 0.005+0.015=0.02 cost
		expect(result.totalInputTokens).toBe(300);
		expect(result.totalOutputTokens).toBe(180);
		expect(result.lastModel).toBe("claude-sonnet-4-5-20250929");

		// updatedAt should be last message timestamp
		expect(result.updatedAt).toBe("2025-01-01T00:05:00.000Z");

		// Preview should be first user message
		expect(result.preview).toBe("Hello there");

		// title should be null for forked conversations
		expect(result.title).toBeNull();

		// Verify the new JSONL file is valid and readable
		const newFilePath = join(TMP_DIR, `${result.id}.jsonl`);
		const newConv = await readConversation(newFilePath);
		expect(newConv).not.toBeNull();
		expect(newConv!.meta.id).toBe(result.id);
		expect(newConv!.messageCount).toBe(5);
		expect(newConv!.meta.totalInputTokens).toBe(300);
		expect(newConv!.meta.totalOutputTokens).toBe(180);
	});

	// ---------------------------------------------------------------------------
	// Fork at message index
	// ---------------------------------------------------------------------------

	test("fork at message 3 — new file with only messages 0-2, recalculated tokens", async () => {
		writeSourceConversation();
		const index = await buildIndex();

		const result = (await handleFork({ id: SOURCE_ID, atMessage: 3 }, index)) as Record<
			string,
			unknown
		>;

		// Should have 3 messages (indices 0, 1, 2)
		expect(result.messageCount).toBe(3);

		// Only 1 assistant message in first 3 messages (index 1: 100 input, 60 output)
		expect(result.totalInputTokens).toBe(100);
		expect(result.totalOutputTokens).toBe(60);
		expect(result.lastModel).toBe("claude-sonnet-4-5-20250929");

		// updatedAt should be timestamp of message at index 2
		expect(result.updatedAt).toBe("2025-01-01T00:03:00.000Z");

		// Verify the new file
		const newFilePath = join(TMP_DIR, `${result.id}.jsonl`);
		const newConv = await readConversation(newFilePath);
		expect(newConv).not.toBeNull();
		expect(newConv!.messageCount).toBe(3);
		expect(newConv!.messages[0]!.content).toBe("Hello there");
		expect(newConv!.messages[1]!.content).toBe("Hi! How can I help?");
		expect(newConv!.messages[2]!.content).toBe("What is MCP?");
	});

	// ---------------------------------------------------------------------------
	// Fork non-existent ID
	// ---------------------------------------------------------------------------

	test("fork non-existent ID — error", async () => {
		writeSourceConversation();
		const index = await buildIndex();

		expect(
			handleFork({ id: "conv_doesnotexist00" }, index),
		).rejects.toThrow("Conversation not found: conv_doesnotexist00");
	});

	// ---------------------------------------------------------------------------
	// Source file unchanged after fork
	// ---------------------------------------------------------------------------

	test("source file unchanged after fork", async () => {
		writeSourceConversation();
		const sourcePath = join(TMP_DIR, `${SOURCE_ID}.jsonl`);
		const originalContent = readFileSync(sourcePath, "utf-8");

		const index = await buildIndex();
		await handleFork({ id: SOURCE_ID, atMessage: 2 }, index);

		const afterContent = readFileSync(sourcePath, "utf-8");
		expect(afterContent).toBe(originalContent);
	});

	// ---------------------------------------------------------------------------
	// New file is valid JSONL (parseable by readConversation)
	// ---------------------------------------------------------------------------

	test("new file is valid JSONL parseable by readConversation", async () => {
		writeSourceConversation();
		const index = await buildIndex();

		const result = (await handleFork({ id: SOURCE_ID }, index)) as Record<string, unknown>;
		const newFilePath = join(TMP_DIR, `${result.id}.jsonl`);

		// Read raw content and verify structure
		const raw = readFileSync(newFilePath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);

		// First line should be valid JSON metadata
		const meta = JSON.parse(lines[0]!);
		expect(meta.id).toBe(result.id);
		expect(typeof meta.createdAt).toBe("string");
		expect(typeof meta.updatedAt).toBe("string");

		// Each subsequent line should be a valid message
		for (let i = 1; i < lines.length; i++) {
			const msg = JSON.parse(lines[i]!);
			expect(msg.role).toBeDefined();
			expect(msg.content).toBeDefined();
			expect(msg.timestamp).toBeDefined();
		}

		// And readConversation should parse it successfully
		const conv = await readConversation(newFilePath);
		expect(conv).not.toBeNull();
		expect(conv!.meta.id).toBe(result.id);
	});

	// ---------------------------------------------------------------------------
	// Fork at 0 — empty conversation
	// ---------------------------------------------------------------------------

	test("fork at message 0 — creates conversation with no messages", async () => {
		writeSourceConversation();
		const index = await buildIndex();

		const result = (await handleFork({ id: SOURCE_ID, atMessage: 0 }, index)) as Record<
			string,
			unknown
		>;

		expect(result.messageCount).toBe(0);
		expect(result.totalInputTokens).toBe(0);
		expect(result.totalOutputTokens).toBe(0);
		expect(result.lastModel).toBeNull();
		expect(result.preview).toBe("");

		// Verify the file exists and is parseable
		const newFilePath = join(TMP_DIR, `${result.id}.jsonl`);
		const newConv = await readConversation(newFilePath);
		expect(newConv).not.toBeNull();
		expect(newConv!.messageCount).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// ID format validation
	// ---------------------------------------------------------------------------

	test("generated ID follows conv_<16 hex chars> pattern", async () => {
		writeSourceConversation();
		const index = await buildIndex();

		const result = (await handleFork({ id: SOURCE_ID }, index)) as Record<string, unknown>;
		const id = result.id as string;

		expect(id).toMatch(/^conv_[0-9a-f]{16}$/);
	});
});
