import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { handleExport } from "../../../../../src/bundles/conversations/src/tools/export.ts";
import type { DisplayMessage } from "../../../../../src/bundles/conversations/src/jsonl-reader.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-export");

function writeTmpFile(name: string, lines: string[]): string {
	const path = join(TMP_DIR, name);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

const META = {
	id: "conv_export001",
	createdAt: "2025-06-01T10:00:00.000Z",
	updatedAt: "2025-06-01T10:10:00.000Z",
	title: "Export Test Conversation",
	totalInputTokens: 1200,
	totalOutputTokens: 800,
	totalCostUsd: 0.05,
	lastModel: "claude-sonnet-4-5-20250929",
};

const MESSAGES = [
	{ role: "user", content: "Hello there", timestamp: "2025-06-01T10:01:00.000Z" },
	{
		role: "assistant",
		content: "Hi! How can I help you today?",
		timestamp: "2025-06-01T10:02:00.000Z",
		metadata: { inputTokens: 300, outputTokens: 200, model: "claude-sonnet-4-5-20250929" },
	},
	{ role: "user", content: "Tell me about MCP", timestamp: "2025-06-01T10:03:00.000Z" },
	{
		role: "assistant",
		content: "MCP stands for Model Context Protocol. It provides a standard way for AI models to interact with tools.",
		timestamp: "2025-06-01T10:04:00.000Z",
		metadata: { inputTokens: 500, outputTokens: 400, model: "claude-sonnet-4-5-20250929" },
	},
];

let index: ConversationIndex;

beforeEach(async () => {
	mkdirSync(TMP_DIR, { recursive: true });
	index = new ConversationIndex();
});

afterEach(() => {
	index.stopWatching();
	rmSync(TMP_DIR, { recursive: true, force: true });
});

async function setupConversation(
	meta: Record<string, unknown>,
	messages: Record<string, unknown>[],
	filename?: string,
): Promise<void> {
	const id = meta.id as string;
	const fname = filename ?? `${id}.jsonl`;
	const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
	writeTmpFile(fname, lines);
	await index.build(TMP_DIR);
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

describe("handleExport — markdown", () => {
	test("exports 4 messages as readable markdown", async () => {
		await setupConversation(META, MESSAGES);

		const result = (await handleExport({ id: "conv_export001", format: "markdown" }, index)) as {
			content: string;
		};

		expect(result.content).toContain("# Conversation: Export Test Conversation");
		expect(result.content).toContain("**Created:** 2025-06-01T10:00:00.000Z");
		expect(result.content).toContain("**Messages:** 4");
		expect(result.content).toContain("**Tokens:** 1200 in / 800 out");
		expect(result.content).toContain("## User");
		expect(result.content).toContain("## Assistant");
		expect(result.content).toContain("Hello there");
		expect(result.content).toContain("Hi! How can I help you today?");
		expect(result.content).toContain("Tell me about MCP");
		expect(result.content).toContain("MCP stands for Model Context Protocol.");
		expect(result.content).toContain("---");
	});

	test("uses 'Untitled' when title is null", async () => {
		const meta = { ...META, id: "conv_notitle", title: null };
		await setupConversation(meta, MESSAGES.slice(0, 2), "conv_notitle.jsonl");

		const result = (await handleExport({ id: "conv_notitle", format: "markdown" }, index)) as {
			content: string;
		};

		expect(result.content).toContain("# Conversation: Untitled");
	});

	test("renders tool calls as blockquotes", async () => {
		const messagesWithTools = [
			{ role: "user", content: "Search for files", timestamp: "2025-06-01T10:01:00.000Z" },
			{
				role: "assistant",
				content: "I found some files.",
				timestamp: "2025-06-01T10:02:00.000Z",
				metadata: {
					inputTokens: 300,
					outputTokens: 200,
					toolCalls: [
						{
							id: "tc_001",
							name: "file_search",
							input: { query: "*.ts", directory: "/src" },
							output: "Found 15 TypeScript files in /src directory",
							ok: true,
							ms: 120,
						},
						{
							id: "tc_002",
							name: "read_file",
							input: { path: "/src/index.ts" },
							output: "export function main() { console.log('hello'); }",
							ok: true,
							ms: 50,
						},
					],
				},
			},
		];

		const meta = { ...META, id: "conv_tools001" };
		await setupConversation(meta, messagesWithTools, "conv_tools001.jsonl");

		const result = (await handleExport({ id: "conv_tools001", format: "markdown" }, index)) as {
			content: string;
		};

		expect(result.content).toContain("> **Tool call:** file_search");
		expect(result.content).toContain("> Input:");
		expect(result.content).toContain("> Result:");
		expect(result.content).toContain("> **Tool call:** read_file");
		expect(result.content).toContain("Found 15 TypeScript files");
	});

	test("preserves code blocks in message content", async () => {
		const codeMessage = [
			{
				role: "user",
				content: "Here is some code:\n\n```typescript\nfunction hello() {\n  return 'world';\n}\n```\n\nWhat does it do?",
				timestamp: "2025-06-01T10:01:00.000Z",
			},
			{
				role: "assistant",
				content: "That function returns the string `'world'`. Here's an improved version:\n\n```typescript\nfunction hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n```",
				timestamp: "2025-06-01T10:02:00.000Z",
			},
		];

		const meta = { ...META, id: "conv_code001" };
		await setupConversation(meta, codeMessage, "conv_code001.jsonl");

		const result = (await handleExport({ id: "conv_code001", format: "markdown" }, index)) as {
			content: string;
		};

		expect(result.content).toContain("```typescript\nfunction hello() {");
		expect(result.content).toContain("```typescript\nfunction hello(name: string): string {");
		// Ensure no double-escaping of backticks
		expect(result.content).not.toContain("\\`\\`\\`");
	});

	test("truncates long tool call input and output", async () => {
		const longInput: Record<string, unknown> = {
			query: "a".repeat(200),
		};
		const longOutput = "b".repeat(400);

		const messagesWithLongToolCalls = [
			{ role: "user", content: "Do something", timestamp: "2025-06-01T10:01:00.000Z" },
			{
				role: "assistant",
				content: "Done.",
				timestamp: "2025-06-01T10:02:00.000Z",
				metadata: {
					toolCalls: [
						{
							id: "tc_long",
							name: "big_tool",
							input: longInput,
							output: longOutput,
							ok: true,
							ms: 500,
						},
					],
				},
			},
		];

		const meta = { ...META, id: "conv_long001" };
		await setupConversation(meta, messagesWithLongToolCalls, "conv_long001.jsonl");

		const result = (await handleExport({ id: "conv_long001", format: "markdown" }, index)) as {
			content: string;
		};

		// Input should be truncated to ~100 chars + "..."
		const inputLine = result.content.split("\n").find((l: string) => l.startsWith("> Input:"));
		expect(inputLine).toBeDefined();
		// The truncated input JSON should be around 108 chars (100 + "..." + "> Input: " prefix)
		expect(inputLine!.length).toBeLessThan(200);

		// Output should be truncated to ~200 chars + "..."
		const resultLine = result.content.split("\n").find((l: string) => l.startsWith("> Result:"));
		expect(resultLine).toBeDefined();
		expect(resultLine!.length).toBeLessThan(300);
	});
});

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

describe("handleExport — json", () => {
	test("exports valid JSON array of messages", async () => {
		await setupConversation(META, MESSAGES);

		const result = (await handleExport({ id: "conv_export001", format: "json" }, index)) as {
			content: string;
		};

		const parsed = JSON.parse(result.content) as DisplayMessage[];
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(4);
		expect(parsed[0]!.role).toBe("user");
		expect(parsed[0]!.content).toBe("Hello there");
		expect(parsed[1]!.role).toBe("assistant");
		expect(parsed[3]!.content).toContain("Model Context Protocol");
	});

	test("JSON output is pretty-printed", async () => {
		await setupConversation(META, MESSAGES);

		const result = (await handleExport({ id: "conv_export001", format: "json" }, index)) as {
			content: string;
		};

		// Pretty-printed JSON has newlines and indentation
		expect(result.content).toContain("\n");
		expect(result.content).toContain("  ");
	});
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("handleExport — errors", () => {
	test("throws for non-existent conversation ID", async () => {
		await index.build(TMP_DIR);

		expect(
			handleExport({ id: "conv_nonexistent", format: "markdown" }, index),
		).rejects.toThrow("Conversation not found: conv_nonexistent");
	});
});
