import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { handleList } from "../../../../../src/bundles/conversations/src/tools/list.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-list-tool");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConvSpec {
	id: string;
	createdAt: string;
	updatedAt: string;
	title: string | null;
	totalInputTokens?: number;
	totalOutputTokens?: number;
	lastModel?: string | null;
	messages?: Array<{ role: string; content: string; timestamp: string }>;
}

function writeConvFile(spec: ConvSpec): string {
	const meta = {
		id: spec.id,
		createdAt: spec.createdAt,
		updatedAt: spec.updatedAt,
		title: spec.title,
		totalInputTokens: spec.totalInputTokens ?? 0,
		totalOutputTokens: spec.totalOutputTokens ?? 0,
		totalCostUsd: 0,
		lastModel: spec.lastModel ?? null,
	};

	const lines = [JSON.stringify(meta)];
	for (const msg of spec.messages ?? []) {
		lines.push(JSON.stringify(msg));
	}

	const filename = `conv_${spec.id}.jsonl`;
	const path = join(TMP_DIR, filename);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

async function buildIndex(specs: ConvSpec[]): Promise<ConversationIndex> {
	for (const spec of specs) {
		writeConvFile(spec);
	}
	const index = new ConversationIndex();
	await index.build(TMP_DIR);
	return index;
}

// Sample conversations with varied dates and content
const CONVS: ConvSpec[] = [
	{
		id: "conv-1",
		createdAt: "2025-01-10T00:00:00.000Z",
		updatedAt: "2025-01-10T02:00:00.000Z",
		title: "Auth system design",
		totalInputTokens: 500,
		totalOutputTokens: 300,
		lastModel: "claude-sonnet-4-5-20250929",
		messages: [
			{ role: "user", content: "Design an auth system", timestamp: "2025-01-10T00:01:00.000Z" },
			{ role: "assistant", content: "Here is a design...", timestamp: "2025-01-10T00:02:00.000Z" },
		],
	},
	{
		id: "conv-2",
		createdAt: "2025-01-12T00:00:00.000Z",
		updatedAt: "2025-01-15T00:00:00.000Z",
		title: "Database migration plan",
		totalInputTokens: 1000,
		totalOutputTokens: 800,
		lastModel: "claude-sonnet-4-5-20250929",
		messages: [
			{ role: "user", content: "Plan the database migration", timestamp: "2025-01-12T00:01:00.000Z" },
			{ role: "assistant", content: "Migration steps...", timestamp: "2025-01-12T00:02:00.000Z" },
			{ role: "user", content: "What about rollback?", timestamp: "2025-01-12T00:03:00.000Z" },
		],
	},
	{
		id: "conv-3",
		createdAt: "2025-01-08T00:00:00.000Z",
		updatedAt: "2025-01-20T00:00:00.000Z",
		title: "API authentication review",
		totalInputTokens: 200,
		totalOutputTokens: 150,
		lastModel: "claude-haiku-3-20250929",
		messages: [
			{ role: "user", content: "Review the API auth flow", timestamp: "2025-01-08T00:01:00.000Z" },
		],
	},
	{
		id: "conv-4",
		createdAt: "2025-02-01T00:00:00.000Z",
		updatedAt: "2025-02-01T00:00:00.000Z",
		title: "Quick question",
		totalInputTokens: 50,
		totalOutputTokens: 30,
		lastModel: "claude-sonnet-4-5-20250929",
		messages: [
			{ role: "user", content: "What is the weather?", timestamp: "2025-02-01T00:01:00.000Z" },
		],
	},
	{
		id: "conv-5",
		createdAt: "2025-01-05T00:00:00.000Z",
		updatedAt: "2025-01-06T00:00:00.000Z",
		title: "Project kickoff",
		totalInputTokens: 800,
		totalOutputTokens: 600,
		lastModel: "claude-sonnet-4-5-20250929",
		messages: [
			{ role: "user", content: "Let's kick off the project", timestamp: "2025-01-05T00:01:00.000Z" },
			{ role: "assistant", content: "Great, here is the plan", timestamp: "2025-01-05T00:02:00.000Z" },
		],
	},
];

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleList", () => {
	test("returns up to 20 sorted by updatedAt desc with no params", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({}, index);

		expect(result.totalCount).toBe(5);
		expect(result.nextCursor).toBeNull();
		expect(result.conversations).toHaveLength(5);

		// Should be sorted by updatedAt descending
		const dates = result.conversations.map((c) => c.updatedAt);
		for (let i = 1; i < dates.length; i++) {
			expect(dates[i]! <= dates[i - 1]!).toBe(true);
		}
	});

	test("each conversation entry has the expected fields", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({}, index);

		const conv = result.conversations[0]!;
		expect(conv).toHaveProperty("id");
		expect(conv).toHaveProperty("title");
		expect(conv).toHaveProperty("createdAt");
		expect(conv).toHaveProperty("updatedAt");
		expect(conv).toHaveProperty("messageCount");
		expect(conv).toHaveProperty("totalInputTokens");
		expect(conv).toHaveProperty("totalOutputTokens");
		expect(conv).toHaveProperty("lastModel");
		expect(conv).toHaveProperty("preview");
	});

	test("limit=2 returns 2 conversations and sets nextCursor", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({ limit: 2 }, index);

		expect(result.conversations).toHaveLength(2);
		expect(result.nextCursor).not.toBeNull();
		expect(result.totalCount).toBe(5);
	});

	test("search filters by title (case-insensitive)", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({ search: "auth" }, index);

		// "Auth system design" and "API authentication review" match
		expect(result.conversations).toHaveLength(2);
		expect(result.totalCount).toBe(2);
		for (const conv of result.conversations) {
			const matches =
				conv.title?.toLowerCase().includes("auth") ||
				conv.preview.toLowerCase().includes("auth");
			expect(matches).toBe(true);
		}
	});

	test("search filters by preview content", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({ search: "weather" }, index);

		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0]!.id).toBe("conv-4");
	});

	test("dateFrom filters conversations created on or after the date", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({ dateFrom: "2025-01-12T00:00:00.000Z" }, index);

		// conv-2 (Jan 12), conv-4 (Feb 1) match
		expect(result.totalCount).toBe(2);
		for (const conv of result.conversations) {
			expect(conv.createdAt >= "2025-01-12T00:00:00.000Z").toBe(true);
		}
	});

	test("dateTo filters conversations created on or before the date", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({ dateTo: "2025-01-08T00:00:00.000Z" }, index);

		// conv-3 (Jan 8), conv-5 (Jan 5) match
		expect(result.totalCount).toBe(2);
		for (const conv of result.conversations) {
			expect(conv.createdAt <= "2025-01-08T00:00:00.000Z").toBe(true);
		}
	});

	test("dateFrom and dateTo combined narrows the range", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({
			dateFrom: "2025-01-08T00:00:00.000Z",
			dateTo: "2025-01-12T00:00:00.000Z",
		}, index);

		// conv-1 (Jan 10), conv-2 (Jan 12), conv-3 (Jan 8) match
		expect(result.totalCount).toBe(3);
		for (const conv of result.conversations) {
			expect(conv.createdAt >= "2025-01-08T00:00:00.000Z").toBe(true);
			expect(conv.createdAt <= "2025-01-12T00:00:00.000Z").toBe(true);
		}
	});

	test("empty directory returns empty array and totalCount 0", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		const result = await handleList({}, index);

		expect(result.conversations).toEqual([]);
		expect(result.nextCursor).toBeNull();
		expect(result.totalCount).toBe(0);
	});

	test("cursor pagination: page 1 then page 2 covers all conversations without duplicates", async () => {
		const index = await buildIndex(CONVS);

		// Page 1: limit=3
		const page1 = await handleList({ limit: 3 }, index);
		expect(page1.conversations).toHaveLength(3);
		expect(page1.nextCursor).not.toBeNull();

		// Page 2: use cursor from page 1
		const page2 = await handleList({ limit: 3, cursor: page1.nextCursor! }, index);
		expect(page2.conversations).toHaveLength(2);
		expect(page2.nextCursor).toBeNull();

		// No duplicates — all IDs are unique
		const allIds = [
			...page1.conversations.map((c) => c.id),
			...page2.conversations.map((c) => c.id),
		];
		expect(new Set(allIds).size).toBe(5);
	});

	test("sortBy=created sorts by createdAt descending", async () => {
		const index = await buildIndex(CONVS);
		const result = await handleList({ sortBy: "created" }, index);

		const dates = result.conversations.map((c) => c.createdAt);
		for (let i = 1; i < dates.length; i++) {
			expect(dates[i]! <= dates[i - 1]!).toBe(true);
		}
	});

	test("passes through all input fields to the index", async () => {
		const index = await buildIndex(CONVS);

		// Combine search + date filter + sort + limit
		const result = await handleList({
			search: "auth",
			sortBy: "created",
			dateFrom: "2025-01-01T00:00:00.000Z",
			dateTo: "2025-01-31T00:00:00.000Z",
			limit: 1,
		}, index);

		expect(result.conversations).toHaveLength(1);
		expect(result.totalCount).toBe(2); // 2 match search+date, but limit=1
		expect(result.nextCursor).not.toBeNull();
	});
});
