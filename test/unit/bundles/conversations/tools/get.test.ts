import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { handleGet } from "../../../../../src/bundles/conversations/src/tools/get.ts";

function tempDir(): string {
	const dir = join(tmpdir(), `nb-get-test-${crypto.randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface WriteOpts {
	title?: string | null;
	createdAt?: string;
	updatedAt?: string;
	messages?: Array<{
		role: "user" | "assistant";
		content: string;
		timestamp?: string;
		metadata?: Record<string, unknown>;
	}>;
}

function writeConversation(dir: string, id: string, opts: WriteOpts = {}): void {
	const createdAt = opts.createdAt ?? "2025-01-15T10:00:00.000Z";
	const updatedAt = opts.updatedAt ?? createdAt;

	const meta = JSON.stringify({
		id,
		createdAt,
		updatedAt,
		title: opts.title ?? null,
		totalInputTokens: 500,
		totalOutputTokens: 200,
		totalCostUsd: 0.05,
		lastModel: "claude-sonnet-4-5-20250929",
	});

	const messages = opts.messages ?? [
		{ role: "user" as const, content: "Hello", timestamp: createdAt },
		{ role: "assistant" as const, content: "Hi there!", timestamp: createdAt },
	];

	const lines = [meta, ...messages.map((m) => JSON.stringify({ ...m, timestamp: m.timestamp ?? createdAt }))];
	writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

describe("conversations__get", () => {
	let dir: string;
	let index: ConversationIndex;

	beforeEach(async () => {
		dir = tempDir();
		index = new ConversationIndex();
	});

	afterEach(() => {
		index.stopWatching();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns all messages with correct metadata for a valid conversation", async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		writeConversation(dir, "conv-5msgs", {
			title: "Test Chat",
			createdAt: ts,
			updatedAt: "2025-01-15T10:05:00.000Z",
			messages: [
				{ role: "user", content: "Message 1", timestamp: ts },
				{ role: "assistant", content: "Reply 1", timestamp: ts },
				{ role: "user", content: "Message 2", timestamp: ts },
				{ role: "assistant", content: "Reply 2", timestamp: ts },
				{ role: "user", content: "Message 3", timestamp: ts },
			],
		});
		await index.build(dir);

		const result = (await handleGet({ id: "conv-5msgs" }, index)) as {
			metadata: Record<string, unknown>;
			messages: Array<{ role: string; content: string }>;
			totalMessages: number;
		};

		expect(result.metadata.id).toBe("conv-5msgs");
		expect(result.metadata.title).toBe("Test Chat");
		expect(result.metadata.createdAt).toBe(ts);
		expect(result.metadata.updatedAt).toBe("2025-01-15T10:05:00.000Z");
		expect(result.metadata.totalInputTokens).toBe(500);
		expect(result.metadata.totalOutputTokens).toBe(200);
		expect(result.metadata.lastModel).toBe("claude-sonnet-4-5-20250929");
		expect(result.messages).toHaveLength(5);
		expect(result.totalMessages).toBe(5);
		expect(result.messages[0]!.content).toBe("Message 1");
		expect(result.messages[4]!.content).toBe("Message 3");
	});

	it("returns only the last N messages when limit is provided", async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		writeConversation(dir, "conv-limited", {
			messages: [
				{ role: "user", content: "First", timestamp: ts },
				{ role: "assistant", content: "Second", timestamp: ts },
				{ role: "user", content: "Third", timestamp: ts },
				{ role: "assistant", content: "Fourth", timestamp: ts },
				{ role: "user", content: "Fifth", timestamp: ts },
			],
		});
		await index.build(dir);

		const result = (await handleGet({ id: "conv-limited", limit: 2 }, index)) as {
			messages: Array<{ role: string; content: string }>;
			totalMessages: number;
		};

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.content).toBe("Fourth");
		expect(result.messages[1]!.content).toBe("Fifth");
		expect(result.totalMessages).toBe(5);
	});

	it("returns isError response for non-existent conversation ID", async () => {
		await index.build(dir);

		await expect(handleGet({ id: "does-not-exist" }, index)).rejects.toThrow(
			"Conversation not found: does-not-exist",
		);
	});

	it("surfaces tool calls and usage as top-level DisplayMessage fields", async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		writeConversation(dir, "conv-meta", {
			messages: [
				{
					role: "user",
					content: "Do something",
					timestamp: ts,
				},
				{
					role: "assistant",
					content: "Done!",
					timestamp: ts,
					metadata: {
						toolCalls: [
							{
								id: "tc-1",
								name: "read_file",
								input: { path: "/tmp/test.ts" },
								output: "file contents",
								ok: true,
								ms: 42,
							},
						],
						inputTokens: 150,
						outputTokens: 80,
						model: "claude-sonnet-4-5-20250929",
						llmMs: 1200,
					},
				},
			],
		});
		await index.build(dir);

		const result = (await handleGet({ id: "conv-meta" }, index)) as {
			messages: Array<{
				role: string;
				content: string;
				blocks?: Array<{ type: string }>;
				toolCalls?: Array<{ id: string; name: string; ok: boolean }>;
				usage?: {
					inputTokens: number;
					outputTokens: number;
					model: string;
					llmMs: number;
				};
			}>;
		};

		expect(result.messages).toHaveLength(2);

		const assistantMsg = result.messages[1]!;
		expect(assistantMsg.toolCalls).toHaveLength(1);
		expect(assistantMsg.toolCalls![0]!.name).toBe("read_file");
		expect(assistantMsg.toolCalls![0]!.ok).toBe(true);
		expect(assistantMsg.usage).toBeDefined();
		expect(assistantMsg.usage!.inputTokens).toBe(150);
		expect(assistantMsg.usage!.outputTokens).toBe(80);
		expect(assistantMsg.usage!.model).toBe("claude-sonnet-4-5-20250929");
		expect(assistantMsg.usage!.llmMs).toBe(1200);
	});
});
