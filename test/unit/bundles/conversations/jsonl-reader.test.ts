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
			{ role: "assistant", content: "Hi! How can I help?", timestamp: "2025-01-01T00:02:00.000Z", metadata: { usage: { inputTokens: 100, outputTokens: 60 }, model: "claude-sonnet-4-5-20250929" } },
			{ role: "user", content: "What is MCP?", timestamp: "2025-01-01T00:03:00.000Z" },
			{ role: "assistant", content: "MCP stands for Model Context Protocol.", timestamp: "2025-01-01T00:04:00.000Z", metadata: { usage: { inputTokens: 200, outputTokens: 120 }, model: "claude-sonnet-4-5-20250929" } },
			{ role: "user", content: "Thanks!", timestamp: "2025-01-01T00:05:00.000Z" },
		];

		const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
		const path = writeTmpFile("conv_abc123.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		expect(result!.meta.id).toBe("conv_abc123");
		expect(result!.meta.title).toBe("Test conversation");
		// Totals derived from messages, not read from line-1 metadata.
		expect(result!.meta.totalInputTokens).toBe(300);
		expect(result!.meta.totalOutputTokens).toBe(180);
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

	test("attaches skills.loaded telemetry to the run's assistant message (reopen parity)", async () => {
		const runId = "run_sk";
		const lines = [
			JSON.stringify(eventMeta("conv_skills")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			// Full wire entry — carries layer/version/contentHash the display shape drops.
			JSON.stringify({
				ts: "2025-06-01T00:00:01.500Z",
				type: "skills.loaded",
				runId,
				skills: [
					{ id: "skills/mpak-guide.md", name: "mpak-guide", layer: 3, scope: "workspace", version: "v1", tokens: 1200, contentHash: "abc123", loadedBy: "tool_affinity", reason: "tool-affinity matched mpak__*" },
				],
				totalTokens: 1200,
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "answer" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_skills.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		const assistant = result!.messages[1]!;
		expect(assistant.role).toBe("assistant");
		expect(assistant.skillsLoaded).toBeDefined();
		expect(assistant.skillsLoaded!.skills).toHaveLength(1);
		// Projected to the display subset — layer/version/contentHash are dropped.
		expect(assistant.skillsLoaded!.skills[0]).toEqual({
			id: "skills/mpak-guide.md",
			name: "mpak-guide",
			scope: "workspace",
			tokens: 1200,
			loadedBy: "tool_affinity",
			reason: "tool-affinity matched mpak__*",
		});
		expect(assistant.skillsLoaded!.totalTokens).toBe(1200);
	});

	test("carries the connector that published a skill", async () => {
		const runId = "run_conn";
		const lines = [
			JSON.stringify(eventMeta("conv_conn")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.500Z",
				type: "skills.loaded",
				runId,
				skills: [
					{ id: "skill://acme/billing/SKILL.md", name: "billing", connector: "acme-mcp", layer: 3, scope: "bundle", version: "", tokens: 900, contentHash: "d1", loadedBy: "tool_affinity", reason: "tool-affinity matched acme-mcp__*" },
				],
				totalTokens: 900,
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "answer" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const result = await readConversation(writeTmpFile("conv_conn.jsonl", lines));
		expect(result!.messages[1]!.skillsLoaded!.skills[0]).toMatchObject({
			name: "billing",
			connector: "acme-mcp",
			scope: "bundle",
		});
	});

	// Every connector skill's id is its `skill://…/SKILL.md` entrypoint, so a
	// reader taking the last path segment names them all `SKILL`. Runs recorded
	// before `name` was on the event still have to render.
	test("derives a name for entries recorded before the field existed", async () => {
		const runId = "run_legacy";
		const lines = [
			JSON.stringify(eventMeta("conv_legacy")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.500Z",
				type: "skills.loaded",
				runId,
				skills: [
					{ id: "skill://acme/billing/refunds/SKILL.md", layer: 3, scope: "bundle", version: "", tokens: 900, contentHash: "d1", loadedBy: "tool_affinity", reason: "tool-affinity matched acme__*" },
					{ id: "/work/skills/release-notes.md", layer: 0, scope: "org", version: "v1", tokens: 300, contentHash: "d2", loadedBy: "always", reason: "always-on" },
				],
				totalTokens: 1200,
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "answer" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const result = await readConversation(writeTmpFile("conv_legacy.jsonl", lines));
		const skills = result!.messages[1]!.skillsLoaded!.skills;
		expect(skills.map((s) => s.name)).toEqual(["refunds", "release-notes"]);
		expect(skills.every((s) => s.connector === undefined)).toBe(true);
	});

	test("a zero-skill turn yields no ledger metadata (old-shape events still parse)", async () => {
		const runId = "run_none";
		const lines = [
			JSON.stringify(eventMeta("conv_noskills")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.500Z", type: "skills.loaded", runId, skills: [], totalTokens: 0 }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "answer" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_noskills.jsonl", lines);

		const result = await readConversation(path);
		expect(result!.messages[1]!.skillsLoaded).toBeUndefined();
	});

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
				usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
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
				usage: { inputTokens: 15, outputTokens: 8, cacheReadTokens: 0 },
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
				usage: { inputTokens: 30, outputTokens: 7, cacheReadTokens: 0 },
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

	test("counts aux.usage toward conversation totals but emits no message", async () => {
		const runId = "run_aux";
		const lines = [
			JSON.stringify(eventMeta("conv_aux")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:02.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "ok" }],
				usage: { inputTokens: 100, outputTokens: 20 },
				llmMs: 50,
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
			// Forked compaction summarizer call: no run, no message, just cost.
			JSON.stringify({
				ts: "2025-06-01T00:00:04.000Z",
				type: "aux.usage",
				source: "compaction",
				model: "fast-m",
				usage: { inputTokens: 400, outputTokens: 60 },
				llmMs: 120,
			}),
		];
		const path = writeTmpFile("conv_aux.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		// Totals include both the turn (100/20) and the forked call (400/60).
		expect(result!.meta.totalInputTokens).toBe(500);
		expect(result!.meta.totalOutputTokens).toBe(80);
		// aux.usage is never a message — just user + assistant.
		expect(result!.messages).toHaveLength(2);
	});

	test("flags an in-flight run (no run.done) as pending", async () => {
		const runId = "run_pending";
		const lines = [
			JSON.stringify(eventMeta("conv_pending01")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "partial" }],
				usage: { inputTokens: 5, outputTokens: 2 },
				llmMs: 30,
			}),
			// No run.done. Whether that means "still in flight" is not in the file.
		];
		const path = writeTmpFile("conv_pending01.jsonl", lines);

		// `runActive` is the RunBus saying a turn IS generating right now — the
		// only evidence that distinguishes an in-flight trailing run from one
		// whose writer died. Without it the same bytes settle to "interrupted".
		const result = await readConversation(path, { runActive: true });
		expect(result).not.toBeNull();
		const asst = result!.messages.at(-1)!;
		expect(asst.role).toBe("assistant");
		expect(asst.pending).toBe(true);
	});

	test("a trailing run with no live turn settles as interrupted, not pending", async () => {
		// The deploy case: SIGTERM cut the writer off between run.start and
		// run.done, so the log ends mid-run. Byte-identical to a turn that is
		// genuinely still generating — the RunBus is what tells them apart.
		const runId = "run_orphaned";
		const lines = [
			JSON.stringify(eventMeta("conv_orphan01")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "partial" }],
				usage: { inputTokens: 5, outputTokens: 2 },
				llmMs: 30,
			}),
		];
		const path = writeTmpFile("conv_orphan01.jsonl", lines);

		const result = await readConversation(path, { runActive: false });
		expect(result).not.toBeNull();
		const asst = result!.messages.at(-1)!;
		expect(asst.role).toBe("assistant");
		// Not "still thinking" — the turn ended, the same way an interior
		// unterminated run ends, and it carries the same stopReason.
		expect(asst.pending).toBeUndefined();
		expect(asst.stopReason).toBe("interrupted");
		// The partial output survives; settling is not truncation.
		expect(asst.content).toContain("partial");
	});

	test("defaults to settled when the caller supplies no liveness signal", async () => {
		// A reader with no RunBus in hand (export, fork, stats) must not assert
		// a turn is still coming. The dangerous default is the one that claims
		// liveness it cannot know.
		const runId = "run_nodefault";
		const lines = [
			JSON.stringify(eventMeta("conv_nodefault01")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "partial" }],
				usage: { inputTokens: 5, outputTokens: 2 },
				llmMs: 30,
			}),
		];
		const path = writeTmpFile("conv_nodefault01.jsonl", lines);

		const result = await readConversation(path);
		expect(result!.messages.at(-1)!.pending).toBeUndefined();
	});

	test("a completed run (run.done) is not pending", async () => {
		const runId = "run_complete";
		const lines = [
			JSON.stringify(eventMeta("conv_complete01")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "run.start", runId }),
			JSON.stringify({
				ts: "2025-06-01T00:00:01.000Z",
				type: "llm.response",
				runId,
				model: "m1",
				content: [{ type: "text", text: "done" }],
				usage: { inputTokens: 5, outputTokens: 2 },
				llmMs: 30,
			}),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "run.done", runId, stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_complete01.jsonl", lines);

		const result = await readConversation(path);
		expect(result!.messages.at(-1)!.pending).toBeUndefined();
	});

	test("an orphaned mid-transcript run does not swallow later turns", async () => {
		// Regression: a run killed mid-turn (process death / deploy bounce) has
		// no run.done. Before the fix, collectRun consumed the rest of the event
		// array, dropping every later turn from the rendered transcript — the
		// user perceived "I lost the last hour of conversation" even though the
		// data was fully persisted. The orphaned run must end at the next turn's
		// boundary, and subsequent turns must still render.
		const lines = [
			JSON.stringify(eventMeta("conv_orphan01")),
			// Turn 1 — complete.
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "first question" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId: "run_1" }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId: "run_1", model: "m1", content: [{ type: "text", text: "first answer" }], usage: { inputTokens: 5, outputTokens: 2 }, llmMs: 10 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId: "run_1", stopReason: "complete" }),
			// Turn 2 — ORPHANED: user message + a run that never closes (no run.done).
			JSON.stringify({ ts: "2025-06-01T00:00:04.000Z", type: "user.message", content: [{ type: "text", text: "second question" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:05.000Z", type: "run.start", runId: "run_2" }),
			JSON.stringify({ ts: "2025-06-01T00:00:06.000Z", type: "llm.response", runId: "run_2", model: "m1", content: [{ type: "text", text: "partial work before the bounce" }], usage: { inputTokens: 5, outputTokens: 2 }, llmMs: 10 }),
			// <-- pod killed here; no run.done for run_2.
			// Turn 3 — complete (came after the restart).
			JSON.stringify({ ts: "2025-06-01T00:00:07.000Z", type: "user.message", content: [{ type: "text", text: "third question" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:08.000Z", type: "run.start", runId: "run_3" }),
			JSON.stringify({ ts: "2025-06-01T00:00:09.000Z", type: "llm.response", runId: "run_3", model: "m1", content: [{ type: "text", text: "third answer" }], usage: { inputTokens: 5, outputTokens: 2 }, llmMs: 10 }),
			JSON.stringify({ ts: "2025-06-01T00:00:10.000Z", type: "run.done", runId: "run_3", stopReason: "complete" }),
		];
		const path = writeTmpFile("conv_orphan01.jsonl", lines);

		const result = await readConversation(path);
		expect(result).not.toBeNull();
		// All 6 turns render (3 user + 3 assistant) — nothing swallowed.
		const roles = result!.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
		// The post-bounce turns survive.
		expect(result!.messages[4]!.content).toBe("third question");
		expect(result!.messages[5]!.content).toBe("third answer");
		// The orphaned turn rendered its partial work...
		const orphaned = result!.messages[3]!;
		expect(orphaned.content).toBe("partial work before the bounce");
		// ...but is ABANDONED, not pending — no perpetual "still thinking" spinner.
		expect(orphaned.pending).toBeUndefined();
		expect(orphaned.stopReason).toBe("interrupted");
	});

	test("a trailing in-flight run (no later turn) is still pending, not abandoned", async () => {
		// Guard against over-correction: only a run with a LATER turn after it is
		// abandoned. A genuinely trailing incomplete run is the live turn and must
		// stay pending so chat-store's resume path reconciles it.
		const lines = [
			JSON.stringify(eventMeta("conv_orphan02")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "q" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId: "run_live" }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId: "run_live", model: "m1", content: [{ type: "text", text: "streaming..." }], usage: { inputTokens: 5, outputTokens: 2 }, llmMs: 10 }),
			// No run.done and no later turn. Identical on disk to a run whose
			// writer died — `runActive` below is what makes it "in flight".
		];
		const path = writeTmpFile("conv_orphan02.jsonl", lines);

		const result = await readConversation(path, { runActive: true });
		const asst = result!.messages.at(-1)!;
		expect(asst.pending).toBe(true);
		expect(asst.stopReason).toBeUndefined();
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
				usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0 },
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
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
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
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
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
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
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

	test("an empty first user message does not end the preview search", async () => {
		// The scan stops at the first user line that HAS text, not at the first
		// user line — an uploaded picture with no caption carries no preview.
		const meta = { id: "conv_hdrnocap", createdAt: "2025-01-01T00:00:00.000Z", format: "events" };
		const path = writeTmpFile("conv_hdrnocap.jsonl", [
			JSON.stringify(meta),
			JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", type: "user.message", content: [{ type: "image" }] }),
			JSON.stringify({ ts: "2025-01-01T00:00:01.000Z", type: "user.message", content: [{ type: "text", text: "captioned" }] }),
		]);

		const result = await readConversationHeader(path);
		expect(result).not.toBeNull();
		expect(result!.preview).toBe("captioned");
		expect(result!.messageCount).toBe(2);
	});

	// -------------------------------------------------------------------------
	// Event format: the count is messages, not lines
	//
	// `conversations__list` reports this number and opening the conversation
	// shows `readConversation`'s. They describe the same file to the same user,
	// so every case here asserts the two agree — the literal is there to say
	// which value they agree ON.
	// -------------------------------------------------------------------------

	function hdrEventMeta(id: string) {
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

	async function bothCounts(path: string): Promise<{ header: number; full: number }> {
		const header = await readConversationHeader(path);
		const full = await readConversation(path);
		expect(header).not.toBeNull();
		expect(full).not.toBeNull();
		return { header: header!.messageCount, full: full!.messageCount };
	}

	test("a turn counts as its messages, not as its events", async () => {
		// One exchange is five lines: the user's message, the run's start, the
		// response, the run's end, and the auto-titler's event. Counting lines
		// reported this conversation as 5 messages.
		const runId = "run_hdr1";
		const path = writeTmpFile("conv_hdrevt.jsonl", [
			JSON.stringify(hdrEventMeta("conv_hdrevt")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "answer" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
			JSON.stringify({ ts: "2025-06-01T00:00:04.000Z", type: "metadata.title", title: "Auto Generated Title" }),
		]);

		const { header, full } = await bothCounts(path);
		expect(header).toBe(full);
		expect(header).toBe(2);
	});

	test("tool calls inside a turn do not each become a message", async () => {
		const runId = "run_hdr2";
		const path = writeTmpFile("conv_hdrtool.jsonl", [
			JSON.stringify(hdrEventMeta("conv_hdrtool")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "search" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "tool.start", runId, id: "t1", name: "nb__search", input: {} }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "tool.done", runId, id: "t1", ok: true }),
			JSON.stringify({ ts: "2025-06-01T00:00:04.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "found it" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:05.000Z", type: "run.done", runId, stopReason: "complete" }),
		]);

		const { header, full } = await bothCounts(path);
		expect(header).toBe(full);
		expect(header).toBe(2);
	});

	test("a run that produced no response is not a message", async () => {
		// `collectRun` yields nothing for a run with no `llm.response`, so the
		// header must not count one either — this is why the rule is
		// runs-with-a-response rather than run.start or run.done.
		const path = writeTmpFile("conv_hdrempty.jsonl", [
			JSON.stringify(hdrEventMeta("conv_hdrempty")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId: "run_empty" }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "run.done", runId: "run_empty", stopReason: "error" }),
		]);

		const { header, full } = await bothCounts(path);
		expect(header).toBe(full);
		expect(header).toBe(1);
	});

	test("a run still in flight counts, as it does for the full reader", async () => {
		// No `run.done` — the turn was still generating (or the writer was cut
		// off). The full reader emits it as a pending message, so the header
		// counts it too; a rule keyed on run.done would disagree here.
		const runId = "run_hdrlive";
		const path = writeTmpFile("conv_hdrlive.jsonl", [
			JSON.stringify(hdrEventMeta("conv_hdrlive")),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "partial" }], usage: { inputTokens: 5, outputTokens: 2 }, llmMs: 30 }),
		]);

		const { header, full } = await bothCounts(path);
		expect(header).toBe(full);
		expect(header).toBe(2);
	});

	test("an event-sourced file with no explicit format marker is still counted as one", async () => {
		// Line 1 predates the `format` stamp, so the format is inferred from the
		// lines — the same fallback `readConversation` uses.
		const runId = "run_hdrnofmt";
		const { format: _dropped, ...noFormat } = hdrEventMeta("conv_hdrnofmt");
		const path = writeTmpFile("conv_hdrnofmt.jsonl", [
			JSON.stringify(noFormat),
			JSON.stringify({ ts: "2025-06-01T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] }),
			JSON.stringify({ ts: "2025-06-01T00:00:01.000Z", type: "run.start", runId }),
			JSON.stringify({ ts: "2025-06-01T00:00:02.000Z", type: "llm.response", runId, model: "m1", content: [{ type: "text", text: "answer" }], usage: { inputTokens: 10, outputTokens: 5 }, llmMs: 100 }),
			JSON.stringify({ ts: "2025-06-01T00:00:03.000Z", type: "run.done", runId, stopReason: "complete" }),
		]);

		const { header, full } = await bothCounts(path);
		expect(header).toBe(full);
		expect(header).toBe(2);
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
		expect(files.every((f) => f.filePath.endsWith(".jsonl"))).toBe(true);
		expect(files.every((f) => f.filePath.startsWith(TMP_DIR))).toBe(true);
		// Flat layout — under no workspace.
		expect(files.every((f) => f.wsId === null)).toBe(true);
	});

	test("reports the workspace a file was found under", () => {
		const owner = join(TMP_DIR, "ws_abc1234567890000", "conversations", "usr_x");
		mkdirSync(owner, { recursive: true });
		writeFileSync(join(owner, "conv_c.jsonl"), "{}");

		const files = listConversationFiles(TMP_DIR);
		const scoped = files.filter((f) => f.wsId !== null);
		expect(scoped).toHaveLength(1);
		expect(scoped[0]?.wsId).toBe("ws_abc1234567890000");
	});

	test("returns empty array for non-existent directory", () => {
		const files = listConversationFiles(join(TMP_DIR, "nope"));
		expect(files).toEqual([]);
	});
});
