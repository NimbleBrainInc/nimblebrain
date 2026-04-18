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
// Event-sourced format — the DisplayMessage reducer path
// ---------------------------------------------------------------------------

describe("readConversation (event format)", () => {
	function eventMeta(id = "conv_evt001") {
		return {
			id,
			createdAt: "2025-06-01T00:00:00.000Z",
			updatedAt: "2025-06-01T00:00:00.000Z",
			title: null,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCostUsd: 0,
			lastModel: null,
			format: "events",
		};
	}

	test("emits one assistant DisplayMessage per run — merging iterations", async () => {
		// A single run with 3 iterations: text → tool-call → final text. The old
		// per-iteration reducer emitted 3 messages; the display reducer must emit 1.
		const runId = "run_a";
		const lines = [
			JSON.stringify(eventMeta()),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:02.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "I'll look it up." }],
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				llmMs: 100,
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:03.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [
					{ type: "tool-call", toolCallId: "t1", toolName: "search", input: { q: "foo" } },
				],
				inputTokens: 15,
				outputTokens: 8,
				cacheReadTokens: 0,
				llmMs: 120,
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:04.000Z",
				type: "tool.done",
				runId,
				id: "t1",
				name: "search",
				ok: true,
				ms: 42,
				output: "found 3 items",
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:05.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "Here's what I found." }],
				inputTokens: 30,
				outputTokens: 7,
				cacheReadTokens: 0,
				llmMs: 80,
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:06.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_evt001.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();

		// Two messages: one user, one assistant — not one user + three assistants.
		expect(result!.messages).toHaveLength(2);
		const assistant = result!.messages[1]!;
		expect(assistant.role).toBe("assistant");

		// Blocks in event-order: text, tool, text.
		expect(assistant.blocks).toHaveLength(3);
		expect(assistant.blocks[0]).toEqual({ type: "text", text: "I'll look it up." });
		expect(assistant.blocks[1]!.type).toBe("tool");
		expect(assistant.blocks[2]).toEqual({ type: "text", text: "Here's what I found." });

		// Aggregated usage across all llm.responses in the run.
		expect(assistant.usage).toEqual({
			inputTokens: 55,
			outputTokens: 20,
			model: "m1",
			llmMs: 300,
		});

		// Flat toolCalls — one entry, fully hydrated.
		expect(assistant.toolCalls).toHaveLength(1);
		const tc = assistant.toolCalls![0]!;
		expect(tc.id).toBe("t1");
		expect(tc.name).toBe("search");
		expect(tc.status).toBe("done");
		expect(tc.ok).toBe(true);
		expect(tc.result.content[0]).toEqual({ type: "text", text: "found 3 items" });
		expect(tc.result.isError).toBe(false);

		// Timestamp = run.done ts (end of the turn).
		expect(assistant.timestamp).toBe("2025-06-01T00:00:06.000Z");
	});

	test("sets status='error' and isError=true for a failed tool call", async () => {
		const runId = "run_b";
		const lines = [
			JSON.stringify(eventMeta("conv_evt_err")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [
					{ type: "tool-call", toolCallId: "t2", toolName: "patch_source", input: {} },
				],
				inputTokens: 5,
				outputTokens: 2,
				cacheReadTokens: 0,
				llmMs: 50,
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:02.000Z",
				type: "tool.done",
				runId,
				id: "t2",
				name: "patch_source",
				ok: false,
				ms: 12,
				output: "text not found",
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_evt_err.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		const tc = result!.messages[0]!.toolCalls![0]!;
		expect(tc.status).toBe("error");
		expect(tc.ok).toBe(false);
		expect(tc.result.isError).toBe(true);
	});

	test("derives appName from 'server__tool' prefix", async () => {
		const runId = "run_c";
		const lines = [
			JSON.stringify(eventMeta("conv_evt_app")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [
					{
						type: "tool-call",
						toolCallId: "t3",
						toolName: "synapse-collateral__patch_source",
						input: {},
					},
				],
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				llmMs: 1,
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:02.000Z",
				type: "tool.done",
				runId,
				id: "t3",
				name: "synapse-collateral__patch_source",
				ok: true,
				ms: 5,
				output: "ok",
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_evt_app.jsonl", lines);

		const result = await readConversation(path);
		const tc = result!.messages[0]!.toolCalls![0]!;
		expect(tc.appName).toBe("synapse-collateral");
	});

	test("propagates non-'complete' stopReason to the DisplayMessage", async () => {
		const runId = "run_d";
		const lines = [
			JSON.stringify(eventMeta("conv_evt_stop")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "partial" }],
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				llmMs: 1,
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:02.000Z",
				type: "run.done",
				runId,
				stopReason: "max_iterations",
			}),
		];
		const path = writeTmpFile("conv_evt_stop.jsonl", lines);

		const result = await readConversation(path);
		expect(result!.messages[0]!.stopReason).toBe("max_iterations");
	});

	test("run.error is treated as a stopReason terminator", async () => {
		const runId = "run_e";
		const lines = [
			JSON.stringify(eventMeta("conv_evt_runerr")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "before failure" }],
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				llmMs: 1,
			}),
			JSON.stringify({
				ts: "2025-06-01T00:00:02.000Z",
				type: "run.error",
				runId,
				error: "boom",
			}),
		];
		const path = writeTmpFile("conv_evt_runerr.jsonl", lines);

		const result = await readConversation(path);
		expect(result!.messages[0]!.stopReason).toBe("error");
	});

	test("does not confuse 'type:text' inside blocks with event lines (format detection)", async () => {
		// A legacy-format file whose messages contain blocks-like structures.
		// The format detector must not misfire on "type":"text" substring.
		const meta = {
			id: "conv_ambig",
			createdAt: "2025-01-01T00:00:00.000Z",
		};
		const msg = {
			role: "user",
			content: "just text",
			timestamp: "2025-01-01T00:00:01.000Z",
			// Contains "type":"text" as substring, but this is a message, not an event.
			blocks: [{ type: "text", text: "just text" }],
		};
		const path = writeTmpFile("conv_ambig.jsonl", [JSON.stringify(meta), JSON.stringify(msg)]);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		// Should be parsed via the legacy path, not the event reducer.
		expect(result!.messages).toHaveLength(1);
		expect(result!.messages[0]!.content).toBe("just text");
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
