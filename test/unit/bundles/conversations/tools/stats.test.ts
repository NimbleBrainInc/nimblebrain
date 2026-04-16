import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { handleStats } from "../../../../../src/bundles/conversations/src/tools/stats.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-stats-test");

interface ConvOptions {
	id: string;
	createdAt: string;
	updatedAt?: string;
	title?: string | null;
	totalInputTokens?: number;
	totalOutputTokens?: number;
	lastModel?: string | null;
	messages?: Array<{
		role: "user" | "assistant";
		content: string;
		timestamp: string;
		metadata?: {
			model?: string;
			skill?: string | null;
			inputTokens?: number;
			outputTokens?: number;
			toolCalls?: Array<{
				id: string;
				name: string;
				input: Record<string, unknown>;
				output: string;
				ok: boolean;
				ms: number;
			}>;
		};
	}>;
}

function writeConv(opts: ConvOptions): void {
	const meta = {
		id: opts.id,
		createdAt: opts.createdAt,
		updatedAt: opts.updatedAt ?? opts.createdAt,
		title: opts.title ?? null,
		totalInputTokens: opts.totalInputTokens ?? 0,
		totalOutputTokens: opts.totalOutputTokens ?? 0,
		totalCostUsd: 0,
		lastModel: opts.lastModel ?? null,
	};
	const lines = [JSON.stringify(meta)];
	for (const msg of opts.messages ?? []) {
		lines.push(JSON.stringify(msg));
	}
	writeFileSync(join(TMP_DIR, `${opts.id}.jsonl`), lines.join("\n") + "\n");
}

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("handleStats", () => {
	test("returns zeros for empty directory", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.totalConversations).toBe(0);
		expect(result.totalInputTokens).toBe(0);
		expect(result.totalOutputTokens).toBe(0);
		expect(result.byModel).toEqual({});
		expect(result.bySkill).toEqual({});
		expect(result.topTools).toEqual([]);
	});

	test("sums token totals from metadata across conversations", async () => {
		writeConv({
			id: "conv_a",
			createdAt: new Date().toISOString(),
			totalInputTokens: 500,
			totalOutputTokens: 200,
		});
		writeConv({
			id: "conv_b",
			createdAt: new Date().toISOString(),
			totalInputTokens: 300,
			totalOutputTokens: 100,
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.totalConversations).toBe(2);
		expect(result.totalInputTokens).toBe(800);
		expect(result.totalOutputTokens).toBe(300);
	});

	test("aggregates byModel from assistant message metadata", async () => {
		writeConv({
			id: "conv_m1",
			createdAt: new Date().toISOString(),
			totalInputTokens: 600,
			totalOutputTokens: 400,
			messages: [
				{ role: "user", content: "Hi", timestamp: new Date().toISOString() },
				{
					role: "assistant",
					content: "Hello",
					timestamp: new Date().toISOString(),
					metadata: { model: "claude-sonnet-4-5-20250929", inputTokens: 200, outputTokens: 100 },
				},
				{ role: "user", content: "More", timestamp: new Date().toISOString() },
				{
					role: "assistant",
					content: "Sure",
					timestamp: new Date().toISOString(),
					metadata: { model: "claude-sonnet-4-5-20250929", inputTokens: 400, outputTokens: 300 },
				},
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.byModel["claude-sonnet-4-5-20250929"]).toEqual({
			inputTokens: 600,
			outputTokens: 400,
			conversations: 1,
		});
	});

	test("counts conversations per model (not messages)", async () => {
		const now = new Date().toISOString();
		writeConv({
			id: "conv_x",
			createdAt: now,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: "Hello",
					timestamp: now,
					metadata: { model: "model-a", inputTokens: 100, outputTokens: 50 },
				},
			],
		});
		writeConv({
			id: "conv_y",
			createdAt: now,
			totalInputTokens: 200,
			totalOutputTokens: 80,
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: "Hello",
					timestamp: now,
					metadata: { model: "model-a", inputTokens: 100, outputTokens: 40 },
				},
				{ role: "user", content: "More", timestamp: now },
				{
					role: "assistant",
					content: "Sure",
					timestamp: now,
					metadata: { model: "model-a", inputTokens: 100, outputTokens: 40 },
				},
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		// Two conversations, not three messages
		expect(result.byModel["model-a"]!.conversations).toBe(2);
	});

	test("aggregates bySkill with conversation count and tool calls", async () => {
		const now = new Date().toISOString();
		writeConv({
			id: "conv_s1",
			createdAt: now,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: "Hello",
					timestamp: now,
					metadata: {
						model: "model-a",
						skill: "code-review",
						toolCalls: [
							{ id: "tc1", name: "read_file", input: {}, output: "ok", ok: true, ms: 10 },
							{ id: "tc2", name: "write_file", input: {}, output: "ok", ok: true, ms: 20 },
						],
					},
				},
				{ role: "user", content: "More", timestamp: now },
				{
					role: "assistant",
					content: "Done",
					timestamp: now,
					metadata: {
						model: "model-a",
						skill: "code-review",
						toolCalls: [
							{ id: "tc3", name: "read_file", input: {}, output: "ok", ok: true, ms: 5 },
						],
					},
				},
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.bySkill["code-review"]).toEqual({
			conversations: 1,
			toolCalls: 3,
		});
	});

	test("topTools sorted descending by callCount", async () => {
		const now = new Date().toISOString();
		writeConv({
			id: "conv_t1",
			createdAt: now,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: "Hello",
					timestamp: now,
					metadata: {
						model: "model-a",
						toolCalls: [
							{ id: "tc1", name: "read_file", input: {}, output: "ok", ok: true, ms: 10 },
							{ id: "tc2", name: "write_file", input: {}, output: "ok", ok: true, ms: 20 },
							{ id: "tc3", name: "read_file", input: {}, output: "ok", ok: true, ms: 5 },
							{ id: "tc4", name: "read_file", input: {}, output: "ok", ok: true, ms: 5 },
							{ id: "tc5", name: "search", input: {}, output: "ok", ok: true, ms: 5 },
							{ id: "tc6", name: "search", input: {}, output: "ok", ok: true, ms: 5 },
						],
					},
				},
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.topTools[0]).toEqual({ name: "read_file", callCount: 3 });
		expect(result.topTools[1]).toEqual({ name: "search", callCount: 2 });
		expect(result.topTools[2]).toEqual({ name: "write_file", callCount: 1 });
	});

	test("filters by period — day excludes old conversations", async () => {
		const now = new Date();
		const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

		writeConv({
			id: "conv_recent",
			createdAt: now.toISOString(),
			totalInputTokens: 100,
			totalOutputTokens: 50,
		});
		writeConv({
			id: "conv_old",
			createdAt: twoDaysAgo.toISOString(),
			totalInputTokens: 999,
			totalOutputTokens: 888,
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "day" }, index);

		expect(result.totalConversations).toBe(1);
		expect(result.totalInputTokens).toBe(100);
		expect(result.totalOutputTokens).toBe(50);
	});

	test("filters by period — week includes 3-day-old conversations", async () => {
		const now = new Date();
		const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

		writeConv({
			id: "conv_recent",
			createdAt: now.toISOString(),
			totalInputTokens: 100,
			totalOutputTokens: 50,
		});
		writeConv({
			id: "conv_3d",
			createdAt: threeDaysAgo.toISOString(),
			totalInputTokens: 200,
			totalOutputTokens: 80,
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "week" }, index);

		expect(result.totalConversations).toBe(2);
		expect(result.totalInputTokens).toBe(300);
	});

	test("defaults to week when period is omitted", async () => {
		const now = new Date();
		const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

		writeConv({
			id: "conv_recent",
			createdAt: now.toISOString(),
			totalInputTokens: 100,
			totalOutputTokens: 50,
		});
		writeConv({
			id: "conv_10d",
			createdAt: tenDaysAgo.toISOString(),
			totalInputTokens: 500,
			totalOutputTokens: 200,
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// No period specified — should default to "week"
		const result = await handleStats({}, index);

		expect(result.totalConversations).toBe(1);
		expect(result.totalInputTokens).toBe(100);
	});

	test("period.since and period.until are ISO strings", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "week" }, index);

		// since should be parseable and roughly 7 days before until
		expect(result.period.since).toBeTruthy();
		expect(result.period.until).toBeTruthy();
		const since = new Date(result.period.since);
		const until = new Date(result.period.until);
		const diffMs = until.getTime() - since.getTime();
		const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
		// Should be approximately 7 days (allow 1 second tolerance)
		expect(Math.abs(diffMs - sevenDaysMs)).toBeLessThan(1000);
	});

	test("period 'all' has empty since string", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.period.since).toBe("");
		expect(result.period.until).toBeTruthy();
	});

	test("skips user messages for model/skill/tool aggregation", async () => {
		const now = new Date().toISOString();
		writeConv({
			id: "conv_skip",
			createdAt: now,
			totalInputTokens: 100,
			totalOutputTokens: 50,
			messages: [
				{
					role: "user",
					content: "Hi",
					timestamp: now,
					// User messages should not contribute even if they have metadata-like fields
				},
				{
					role: "assistant",
					content: "Hello",
					timestamp: now,
					metadata: { model: "model-x", inputTokens: 100, outputTokens: 50 },
				},
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(Object.keys(result.byModel)).toEqual(["model-x"]);
	});

	test("does not include USD cost in output", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		const json = JSON.stringify(result);
		expect(json).not.toContain("cost");
		expect(json).not.toContain("usd");
		expect(json).not.toContain("USD");
	});

	test("handles assistant messages without metadata gracefully", async () => {
		const now = new Date().toISOString();
		writeConv({
			id: "conv_nometa",
			createdAt: now,
			totalInputTokens: 50,
			totalOutputTokens: 25,
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{ role: "assistant", content: "Hello", timestamp: now },
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = await handleStats({ period: "all" }, index);

		expect(result.totalConversations).toBe(1);
		expect(result.totalInputTokens).toBe(50);
		expect(result.byModel).toEqual({});
		expect(result.topTools).toEqual([]);
	});
});
