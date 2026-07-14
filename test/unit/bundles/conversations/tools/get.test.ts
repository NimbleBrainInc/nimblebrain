import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import {
	DEFAULT_GET_CHAR_CAP,
	DEFAULT_GET_LIMIT,
	handleGet,
} from "../../../../../src/bundles/conversations/src/tools/get.ts";

function tempDir(): string {
	const dir = join(tmpdir(), `nb-get-test-${crypto.randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface WriteOpts {
	title?: string | null;
	createdAt?: string;
	updatedAt?: string;
	workspaceId?: string;
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

	// Line-1 totals are no longer read by the bundle; lastModel still is.
	const meta = JSON.stringify({
		id,
		createdAt,
		updatedAt,
		title: opts.title ?? null,
		lastModel: "claude-sonnet-4-5-20250929",
		...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
	});

	// Attach usage to the last assistant message (or fall through to the
	// default message pair) so derived totals match the test's stable
	// expectations: 500 in / 200 out / model claude-sonnet-4-5-20250929.
	const messages = opts.messages ?? [
		{ role: "user" as const, content: "Hello", timestamp: createdAt },
		{ role: "assistant" as const, content: "Hi there!", timestamp: createdAt },
	];
	const annotated = messages.map((m, i, arr) => {
		const isLastAssistant =
			m.role === "assistant" &&
			!arr.slice(i + 1).some((later) => later.role === "assistant");
		if (!isLastAssistant) return m;
		const existingMeta = (m as { metadata?: Record<string, unknown> }).metadata ?? {};
		// Don't clobber metadata.usage if the test set it explicitly.
		if ("usage" in existingMeta) return m;
		return {
			...m,
			metadata: {
				...existingMeta,
				model: "claude-sonnet-4-5-20250929",
				usage: { inputTokens: 500, outputTokens: 200 },
			},
		};
	});

	const lines = [meta, ...annotated.map((m) => JSON.stringify({ ...m, timestamp: m.timestamp ?? createdAt }))];
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

	it("surfaces the conversation's workspaceId in metadata (drives the panel re-scope)", async () => {
		writeConversation(dir, "conv-ws", { workspaceId: "ws_alpha" });
		await index.build(dir);

		const result = (await handleGet({ id: "conv-ws", expand: "metadata" }, index)) as {
			metadata: Record<string, unknown>;
		};

		expect(result.metadata.workspaceId).toBe("ws_alpha");
	});

	it("omits workspaceId for a legacy record that has none (absence ⇒ don't reconcile)", async () => {
		writeConversation(dir, "conv-legacy"); // no workspaceId written
		await index.build(dir);

		const result = (await handleGet({ id: "conv-legacy", expand: "metadata" }, index)) as {
			metadata: Record<string, unknown>;
		};

		expect("workspaceId" in result.metadata).toBe(false);
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
						usage: { inputTokens: 150, outputTokens: 80 },
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

	it('expand:"metadata" returns metadata only — no messages', async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		writeConversation(dir, "conv-meta-only", {
			title: "Metadata only",
			messages: [
				{ role: "user", content: "u1", timestamp: ts },
				{ role: "assistant", content: "a1", timestamp: ts },
				{ role: "user", content: "u2", timestamp: ts },
				{ role: "assistant", content: "a2", timestamp: ts },
			],
		});
		await index.build(dir);

		const result = (await handleGet(
			{ id: "conv-meta-only", expand: "metadata" },
			index,
		)) as {
			metadata: Record<string, unknown>;
			messages: unknown[];
			totalMessages: number;
		};

		expect(result.metadata.id).toBe("conv-meta-only");
		expect(result.metadata.title).toBe("Metadata only");
		expect(result.messages).toEqual([]);
		expect(result.totalMessages).toBe(4);
	});

	it("defaults to returning the last DEFAULT_GET_LIMIT messages when there are more", async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		const totalMsgs = DEFAULT_GET_LIMIT + 5;
		const messages = Array.from({ length: totalMsgs }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `msg-${i}`,
			timestamp: ts,
		}));
		writeConversation(dir, "conv-many", { messages });
		await index.build(dir);

		const result = (await handleGet({ id: "conv-many" }, index)) as {
			messages: Array<{ content: string }>;
			totalMessages: number;
			truncated?: boolean;
		};

		expect(result.totalMessages).toBe(totalMsgs);
		expect(result.messages).toHaveLength(DEFAULT_GET_LIMIT);
		// Most recent message preserved at the end.
		expect(result.messages.at(-1)!.content).toBe(`msg-${totalMsgs - 1}`);
		// First returned is the (totalMsgs - DEFAULT_GET_LIMIT)-th message.
		expect(result.messages[0]!.content).toBe(`msg-${totalMsgs - DEFAULT_GET_LIMIT}`);
		// No char-cap truncation when messages are small.
		expect(result.truncated).toBeUndefined();
	});

	it('expand:"full" returns every message regardless of the char cap', async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		const bigContent = "X".repeat(Math.floor(DEFAULT_GET_CHAR_CAP / 4));
		const messages = Array.from({ length: 10 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `${bigContent}-${i}`,
			timestamp: ts,
		}));
		writeConversation(dir, "conv-full", { messages });
		await index.build(dir);

		const result = (await handleGet({ id: "conv-full", expand: "full" }, index)) as {
			messages: unknown[];
			totalMessages: number;
			truncated?: boolean;
		};

		expect(result.messages).toHaveLength(10);
		expect(result.totalMessages).toBe(10);
		expect(result.truncated).toBeUndefined();
	});

	it("default mode truncates the older end of the window when the char cap is hit and surfaces a hint", async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		const bigContent = "X".repeat(Math.floor(DEFAULT_GET_CHAR_CAP / 4));
		const messages = Array.from({ length: 10 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `${bigContent}-${i}`,
			timestamp: ts,
		}));
		writeConversation(dir, "conv-bigwindow", { messages });
		await index.build(dir);

		const result = (await handleGet({ id: "conv-bigwindow" }, index)) as {
			messages: Array<{ content: string }>;
			totalMessages: number;
			truncated?: boolean;
			droppedOlderMessages?: number;
			truncationHint?: string;
		};

		expect(result.totalMessages).toBe(10);
		expect(result.truncated).toBe(true);
		expect(result.droppedOlderMessages).toBeGreaterThan(0);
		expect(result.messages.length).toBeLessThan(10);
		// Newest survives.
		expect(result.messages.at(-1)!.content).toBe(`${bigContent}-9`);
		expect(result.truncationHint).toContain("budget");
	});

	it("always returns at least the single most recent message even if it exceeds the cap", async () => {
		const ts = "2025-01-15T10:00:00.000Z";
		const overCap = "Y".repeat(DEFAULT_GET_CHAR_CAP * 2);
		writeConversation(dir, "conv-onehuge", {
			messages: [
				{ role: "user", content: "small", timestamp: ts },
				{ role: "assistant", content: overCap, timestamp: ts },
			],
		});
		await index.build(dir);

		const result = (await handleGet({ id: "conv-onehuge" }, index)) as {
			messages: Array<{ content: string }>;
			totalMessages: number;
			truncated?: boolean;
		};

		// Single most recent message kept even though it alone exceeds cap.
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe(overCap);
		expect(result.truncated).toBe(true);
	});

	it("the bounded result fits under MAX_TOOL_RESULT_CHARS once pretty-printed and wrapped", async () => {
		// The platform serializes tool results via JSON.stringify(result, null, 2)
		// (see src/tools/platform/conversations.ts), then the engine's per-result
		// cap (`MAX_TOOL_RESULT_CHARS = 50_000`) slices the resulting text from
		// the end if it overshoots. This test guards against drift between
		// DEFAULT_GET_CHAR_CAP and the actual budget the engine measures —
		// the cap must be sized so the pretty-printed wrapper stays under
		// 50,000 chars in the worst case (truncation firing on the windowed
		// slice). Bug history: DEFAULT_GET_CHAR_CAP = 50_000 originally, but
		// pretty-print inflation pushed the serialized result over the engine
		// cap, which then sliced away the `truncationHint` field.
		const MAX_TOOL_RESULT_CHARS = 50_000;

		const ts = "2025-01-15T10:00:00.000Z";
		// Worst case: many messages, each fat enough that the char-cap fires
		// inside the windowed slice. Force the cap path to do work.
		const fatChunk = "Z".repeat(2_000);
		const messages = Array.from({ length: DEFAULT_GET_LIMIT * 2 }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `${fatChunk}-${i}`,
			timestamp: ts,
			// Realistic message shape: nested usage / blocks add pretty-print overhead.
			blocks: [{ type: "text", text: `${fatChunk}-${i}` }],
			usage: { inputTokens: 100, outputTokens: 50, model: "claude-sonnet-4-6", llmMs: 1200 },
		}));
		writeConversation(dir, "conv-fits-under-engine-cap", { messages });
		await index.build(dir);

		const result = await handleGet({ id: "conv-fits-under-engine-cap" }, index);
		const serialized = JSON.stringify(result, null, 2);
		expect(serialized.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);

		// And the truncation flags must precede `messages` in the serialized
		// output, so an end-slice would lose messages first (not the flags).
		const truncatedAt = serialized.indexOf('"truncated"');
		const messagesAt = serialized.indexOf('"messages"');
		expect(truncatedAt).toBeGreaterThan(-1);
		expect(messagesAt).toBeGreaterThan(-1);
		expect(truncatedAt).toBeLessThan(messagesAt);
	});
});
