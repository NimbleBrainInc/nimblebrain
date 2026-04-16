import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	listConversationFiles,
	readConversation,
	readConversationHeader,
} from "../../../../src/bundles/conversations/src/jsonl-reader.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-jsonl-reader");

function writeTmpFile(name: string, lines: string[]): string {
	const path = join(TMP_DIR, name);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Well-formed file with 5 messages
// ---------------------------------------------------------------------------

describe("readConversation", () => {
	test("parses a well-formed JSONL file with 5 messages", async () => {
		const meta = {
			id: "conv_abc123",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:05:00.000Z",
			title: "Test conversation",
			totalInputTokens: 500,
			totalOutputTokens: 300,
			totalCostUsd: 0.02,
			lastModel: "claude-sonnet-4-5-20250929",
		};
		const messages = [
			{ role: "user", content: "Hello there", timestamp: "2025-01-01T00:01:00.000Z" },
			{ role: "assistant", content: "Hi! How can I help?", timestamp: "2025-01-01T00:02:00.000Z", metadata: { inputTokens: 100, outputTokens: 60, model: "claude-sonnet-4-5-20250929" } },
			{ role: "user", content: "What is MCP?", timestamp: "2025-01-01T00:03:00.000Z" },
			{ role: "assistant", content: "MCP stands for Model Context Protocol.", timestamp: "2025-01-01T00:04:00.000Z", metadata: { inputTokens: 200, outputTokens: 120, model: "claude-sonnet-4-5-20250929" } },
			{ role: "user", content: "Thanks!", timestamp: "2025-01-01T00:05:00.000Z" },
		];

		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		const path = writeTmpFile("conv_abc123.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		expect(result!.meta.id).toBe("conv_abc123");
		expect(result!.meta.title).toBe("Test conversation");
		expect(result!.meta.totalInputTokens).toBe(500);
		expect(result!.meta.totalOutputTokens).toBe(300);
		expect(result!.meta.totalCostUsd).toBe(0.02);
		expect(result!.meta.lastModel).toBe("claude-sonnet-4-5-20250929");
		expect(result!.messageCount).toBe(5);
		expect(result!.messages).toHaveLength(5);
		expect(result!.preview).toBe("Hello there");
	});

	test("applies defaults for old format (only id + createdAt)", async () => {
		const meta = { id: "conv_old001", createdAt: "2024-06-15T12:00:00.000Z" };
		const msg = { role: "user", content: "Old message", timestamp: "2024-06-15T12:01:00.000Z" };
		const path = writeTmpFile("conv_old001.jsonl", [JSON.stringify(meta), JSON.stringify(msg)]);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		expect(result!.meta.updatedAt).toBe("2024-06-15T12:00:00.000Z"); // defaults to createdAt
		expect(result!.meta.title).toBeNull();
		expect(result!.meta.totalInputTokens).toBe(0);
		expect(result!.meta.totalOutputTokens).toBe(0);
		expect(result!.meta.totalCostUsd).toBe(0);
		expect(result!.meta.lastModel).toBeNull();
		expect(result!.messageCount).toBe(1);
		expect(result!.preview).toBe("Old message");
	});

	test("skips malformed lines and parses the rest", async () => {
		const meta = { id: "conv_bad001", createdAt: "2025-02-01T00:00:00.000Z" };
		const msg1 = { role: "user", content: "First", timestamp: "2025-02-01T00:01:00.000Z" };
		const msg3 = { role: "assistant", content: "Response", timestamp: "2025-02-01T00:03:00.000Z" };
		const lines = [
			JSON.stringify(meta),
			JSON.stringify(msg1),
			"this is not valid json {{{",
			JSON.stringify(msg3),
		];
		const path = writeTmpFile("conv_bad001.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		expect(result!.messageCount).toBe(2);
		expect(result!.messages).toHaveLength(2);
		expect(result!.messages[0]!.content).toBe("First");
		expect(result!.messages[1]!.content).toBe("Response");
		expect(result!.preview).toBe("First");
	});

	test("returns null for empty file", async () => {
		const path = writeTmpFile("empty.jsonl", []);
		// Write an actually empty file (no lines at all)
		writeFileSync(path, "");

		const result = await readConversation(path);
		expect(result).toBeNull();
	});

	test("returns null for non-existent file", async () => {
		const result = await readConversation(join(TMP_DIR, "does_not_exist.jsonl"));
		expect(result).toBeNull();
	});

	test("handles file with only metadata line (no messages)", async () => {
		const meta = {
			id: "conv_nomsg",
			createdAt: "2025-03-01T00:00:00.000Z",
			updatedAt: "2025-03-01T00:00:00.000Z",
			title: "Empty conv",
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCostUsd: 0,
			lastModel: null,
		};
		const path = writeTmpFile("conv_nomsg.jsonl", [JSON.stringify(meta)]);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		expect(result!.meta.id).toBe("conv_nomsg");
		expect(result!.messages).toHaveLength(0);
		expect(result!.messageCount).toBe(0);
		expect(result!.preview).toBe("");
	});

	test("preview is empty string when no user message exists", async () => {
		const meta = { id: "conv_nouser", createdAt: "2025-04-01T00:00:00.000Z" };
		const msg = { role: "assistant", content: "I started talking first", timestamp: "2025-04-01T00:01:00.000Z" };
		const path = writeTmpFile("conv_nouser.jsonl", [JSON.stringify(meta), JSON.stringify(msg)]);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		expect(result!.preview).toBe("");
		expect(result!.messageCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// readConversationHeader
// ---------------------------------------------------------------------------

describe("readConversationHeader", () => {
	test("reads metadata + preview + count without full message parse", async () => {
		const meta = {
			id: "conv_hdr001",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:05:00.000Z",
			title: "Header test",
			totalInputTokens: 100,
			totalOutputTokens: 50,
			totalCostUsd: 0.01,
			lastModel: "claude-sonnet-4-5-20250929",
		};
		const messages = [
			{ role: "user", content: "Preview text", timestamp: "2025-01-01T00:01:00.000Z" },
			{ role: "assistant", content: "Reply", timestamp: "2025-01-01T00:02:00.000Z" },
			{ role: "user", content: "Follow up", timestamp: "2025-01-01T00:03:00.000Z" },
		];
		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		const path = writeTmpFile("conv_hdr001.jsonl", lines);

		const result = await readConversationHeader(path);
		expect(result).not.toBeNull();
		expect(result!.meta.id).toBe("conv_hdr001");
		expect(result!.meta.title).toBe("Header test");
		expect(result!.preview).toBe("Preview text");
		expect(result!.messageCount).toBe(3);
	});

	test("returns null for non-existent file", async () => {
		const result = await readConversationHeader(join(TMP_DIR, "nope.jsonl"));
		expect(result).toBeNull();
	});

	test("returns null for empty file", async () => {
		const path = join(TMP_DIR, "empty_hdr.jsonl");
		writeFileSync(path, "");
		const result = await readConversationHeader(path);
		expect(result).toBeNull();
	});

	test("applies backward-compat defaults", async () => {
		const meta = { id: "conv_oldhdr", createdAt: "2024-01-01T00:00:00.000Z" };
		const path = writeTmpFile("conv_oldhdr.jsonl", [JSON.stringify(meta)]);

		const result = await readConversationHeader(path);
		expect(result).not.toBeNull();
		expect(result!.meta.updatedAt).toBe("2024-01-01T00:00:00.000Z");
		expect(result!.meta.title).toBeNull();
		expect(result!.meta.totalInputTokens).toBe(0);
		expect(result!.meta.lastModel).toBeNull();
		expect(result!.messageCount).toBe(0);
		expect(result!.preview).toBe("");
	});

	test("skips malformed message lines in count", async () => {
		const meta = { id: "conv_badhdr", createdAt: "2025-01-01T00:00:00.000Z" };
		const msg = { role: "user", content: "Valid", timestamp: "2025-01-01T00:01:00.000Z" };
		const lines = [JSON.stringify(meta), JSON.stringify(msg), "broken json {{"];
		const path = writeTmpFile("conv_badhdr.jsonl", lines);

		const result = await readConversationHeader(path);
		expect(result).not.toBeNull();
		expect(result!.messageCount).toBe(1);
		expect(result!.preview).toBe("Valid");
	});
});

// ---------------------------------------------------------------------------
// listConversationFiles
// ---------------------------------------------------------------------------

describe("listConversationFiles", () => {
	test("lists .jsonl files in directory", () => {
		writeFileSync(join(TMP_DIR, "conv_a.jsonl"), "{}");
		writeFileSync(join(TMP_DIR, "conv_b.jsonl"), "{}");
		writeFileSync(join(TMP_DIR, "notes.txt"), "not a jsonl");

		const files = listConversationFiles(TMP_DIR);
		expect(files).toHaveLength(2);
		expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
		expect(files.every((f) => f.startsWith(TMP_DIR))).toBe(true);
	});

	test("returns empty array for non-existent directory", () => {
		const files = listConversationFiles(join(TMP_DIR, "nope"));
		expect(files).toEqual([]);
	});
});
