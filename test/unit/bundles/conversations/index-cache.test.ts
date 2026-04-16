import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../../../../src/bundles/conversations/src/index-cache.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-index-cache");

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
// build()
// ---------------------------------------------------------------------------

describe("build", () => {
	test("builds index from a directory with 3 JSONL files", async () => {
		writeConvFile({
			id: "aaa",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T01:00:00.000Z",
			title: "First conversation",
			totalInputTokens: 100,
			totalOutputTokens: 50,
			lastModel: "claude-sonnet-4-5-20250929",
			messages: [
				{ role: "user", content: "Hello world", timestamp: "2025-01-01T00:01:00.000Z" },
				{ role: "assistant", content: "Hi there!", timestamp: "2025-01-01T00:02:00.000Z" },
			],
		});

		writeConvFile({
			id: "bbb",
			createdAt: "2025-01-02T00:00:00.000Z",
			updatedAt: "2025-01-02T02:00:00.000Z",
			title: "Second conversation",
			totalInputTokens: 200,
			totalOutputTokens: 100,
			messages: [
				{ role: "user", content: "How does MCP work?", timestamp: "2025-01-02T00:01:00.000Z" },
			],
		});

		writeConvFile({
			id: "ccc",
			createdAt: "2025-01-03T00:00:00.000Z",
			updatedAt: "2025-01-03T03:00:00.000Z",
			title: null,
			messages: [
				{ role: "user", content: "Deploy to production", timestamp: "2025-01-03T00:01:00.000Z" },
				{ role: "assistant", content: "Deploying...", timestamp: "2025-01-03T00:02:00.000Z" },
				{ role: "user", content: "Status?", timestamp: "2025-01-03T00:03:00.000Z" },
			],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		expect(index.size).toBe(3);

		const a = index.get("aaa");
		expect(a).toBeDefined();
		expect(a!.title).toBe("First conversation");
		expect(a!.messageCount).toBe(2);
		expect(a!.totalInputTokens).toBe(100);
		expect(a!.totalOutputTokens).toBe(50);
		expect(a!.lastModel).toBe("claude-sonnet-4-5-20250929");
		expect(a!.preview).toBe("Hello world");

		const b = index.get("bbb");
		expect(b).toBeDefined();
		expect(b!.messageCount).toBe(1);
		expect(b!.preview).toBe("How does MCP work?");

		const c = index.get("ccc");
		expect(c).toBeDefined();
		expect(c!.title).toBeNull();
		expect(c!.messageCount).toBe(3);
		expect(c!.preview).toBe("Deploy to production");
	});

	test("empty directory results in size 0", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(0);

		const result = index.list();
		expect(result.conversations).toEqual([]);
		expect(result.nextCursor).toBeNull();
		expect(result.totalCount).toBe(0);
	});

	test("skips non-JSONL files and malformed files", async () => {
		writeConvFile({
			id: "good",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Good",
			messages: [{ role: "user", content: "Hi", timestamp: "2025-01-01T00:01:00.000Z" }],
		});

		// Non-JSONL file
		writeFileSync(join(TMP_DIR, "readme.txt"), "not a conversation");

		// Malformed JSONL
		writeFileSync(join(TMP_DIR, "conv_broken.jsonl"), "this is not valid json\n");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(1);
		expect(index.get("good")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// list() — pagination
// ---------------------------------------------------------------------------

describe("list pagination", () => {
	test("paginates with limit=2 across 3 conversations", async () => {
		writeConvFile({
			id: "p1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Page one A",
			messages: [{ role: "user", content: "msg1", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "p2",
			createdAt: "2025-01-02T00:00:00.000Z",
			updatedAt: "2025-01-02T00:00:00.000Z",
			title: "Page one B",
			messages: [{ role: "user", content: "msg2", timestamp: "2025-01-02T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "p3",
			createdAt: "2025-01-03T00:00:00.000Z",
			updatedAt: "2025-01-03T00:00:00.000Z",
			title: "Page two",
			messages: [{ role: "user", content: "msg3", timestamp: "2025-01-03T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// First page
		const page1 = index.list({ limit: 2 });
		expect(page1.conversations).toHaveLength(2);
		expect(page1.totalCount).toBe(3);
		expect(page1.nextCursor).not.toBeNull();

		// Second page using cursor
		const page2 = index.list({ limit: 2, cursor: page1.nextCursor! });
		expect(page2.conversations).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
		expect(page2.totalCount).toBe(3);

		// All three IDs are present across pages
		const allIds = [
			...page1.conversations.map((c) => c.id),
			...page2.conversations.map((c) => c.id),
		];
		expect(allIds.sort()).toEqual(["p1", "p2", "p3"]);
	});
});

// ---------------------------------------------------------------------------
// list() — search
// ---------------------------------------------------------------------------

describe("list search", () => {
	test("filters by case-insensitive substring on title and preview", async () => {
		writeConvFile({
			id: "s1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Kubernetes Deployment",
			messages: [{ role: "user", content: "Deploy my app", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "s2",
			createdAt: "2025-01-02T00:00:00.000Z",
			updatedAt: "2025-01-02T00:00:00.000Z",
			title: "Database Setup",
			messages: [{ role: "user", content: "Setup postgres", timestamp: "2025-01-02T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "s3",
			createdAt: "2025-01-03T00:00:00.000Z",
			updatedAt: "2025-01-03T00:00:00.000Z",
			title: "Quick Question",
			messages: [{ role: "user", content: "How to deploy kubernetes?", timestamp: "2025-01-03T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// Search by title
		const r1 = index.list({ search: "kubernetes" });
		expect(r1.conversations).toHaveLength(2);
		expect(r1.totalCount).toBe(2);
		const ids1 = r1.conversations.map((c) => c.id).sort();
		expect(ids1).toEqual(["s1", "s3"]);

		// Search by preview content
		const r2 = index.list({ search: "postgres" });
		expect(r2.conversations).toHaveLength(1);
		expect(r2.conversations[0]!.id).toBe("s2");

		// Case insensitive
		const r3 = index.list({ search: "DEPLOY" });
		expect(r3.conversations).toHaveLength(2);

		// No match
		const r4 = index.list({ search: "nonexistent" });
		expect(r4.conversations).toHaveLength(0);
		expect(r4.totalCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// list() — date filtering
// ---------------------------------------------------------------------------

describe("list date filtering", () => {
	test("filters by dateFrom and dateTo", async () => {
		writeConvFile({
			id: "d1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "January",
			messages: [{ role: "user", content: "jan", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "d2",
			createdAt: "2025-02-15T00:00:00.000Z",
			updatedAt: "2025-02-15T00:00:00.000Z",
			title: "February",
			messages: [{ role: "user", content: "feb", timestamp: "2025-02-15T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "d3",
			createdAt: "2025-03-20T00:00:00.000Z",
			updatedAt: "2025-03-20T00:00:00.000Z",
			title: "March",
			messages: [{ role: "user", content: "mar", timestamp: "2025-03-20T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// Only February onwards
		const r1 = index.list({ dateFrom: "2025-02-01T00:00:00.000Z" });
		expect(r1.totalCount).toBe(2);
		expect(r1.conversations.map((c) => c.id).sort()).toEqual(["d2", "d3"]);

		// Only up to February
		const r2 = index.list({ dateTo: "2025-02-28T00:00:00.000Z" });
		expect(r2.totalCount).toBe(2);
		expect(r2.conversations.map((c) => c.id).sort()).toEqual(["d1", "d2"]);

		// Exact range: February only
		const r3 = index.list({
			dateFrom: "2025-02-01T00:00:00.000Z",
			dateTo: "2025-02-28T23:59:59.999Z",
		});
		expect(r3.totalCount).toBe(1);
		expect(r3.conversations[0]!.id).toBe("d2");
	});
});

// ---------------------------------------------------------------------------
// list() — sorting
// ---------------------------------------------------------------------------

describe("list sorting", () => {
	test("sort by created vs updated produces different orderings", async () => {
		// Created first, but updated last
		writeConvFile({
			id: "sort1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-03-01T00:00:00.000Z",
			title: "Old but recently updated",
			messages: [{ role: "user", content: "msg", timestamp: "2025-01-01T00:01:00.000Z" }],
		});

		// Created second, updated in the middle
		writeConvFile({
			id: "sort2",
			createdAt: "2025-02-01T00:00:00.000Z",
			updatedAt: "2025-02-01T00:00:00.000Z",
			title: "Middle",
			messages: [{ role: "user", content: "msg", timestamp: "2025-02-01T00:01:00.000Z" }],
		});

		// Created last, but updated earliest
		writeConvFile({
			id: "sort3",
			createdAt: "2025-03-01T00:00:00.000Z",
			updatedAt: "2025-01-15T00:00:00.000Z",
			title: "New but stale",
			messages: [{ role: "user", content: "msg", timestamp: "2025-03-01T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// Sort by created (desc): sort3, sort2, sort1
		const byCreated = index.list({ sortBy: "created" });
		expect(byCreated.conversations.map((c) => c.id)).toEqual(["sort3", "sort2", "sort1"]);

		// Sort by updated (desc): sort1, sort2, sort3
		const byUpdated = index.list({ sortBy: "updated" });
		expect(byUpdated.conversations.map((c) => c.id)).toEqual(["sort1", "sort2", "sort3"]);
	});

	test("default sort is by updated", async () => {
		writeConvFile({
			id: "def1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-03-01T00:00:00.000Z",
			title: "A",
			messages: [{ role: "user", content: "a", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "def2",
			createdAt: "2025-02-01T00:00:00.000Z",
			updatedAt: "2025-02-01T00:00:00.000Z",
			title: "B",
			messages: [{ role: "user", content: "b", timestamp: "2025-02-01T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		const result = index.list();
		// def1 has later updatedAt, so comes first
		expect(result.conversations[0]!.id).toBe("def1");
	});
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("get", () => {
	test("returns entry by ID", async () => {
		writeConvFile({
			id: "get1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Get test",
			messages: [{ role: "user", content: "hello", timestamp: "2025-01-01T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		expect(index.get("get1")).toBeDefined();
		expect(index.get("get1")!.title).toBe("Get test");
		expect(index.get("nonexistent")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// fs.watch integration
// ---------------------------------------------------------------------------

describe("fs.watch integration", () => {
	test("detects new file after debounce", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(0);

		index.startWatching(TMP_DIR);

		try {
			// Write a new file
			writeConvFile({
				id: "watch1",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				title: "Watched file",
				messages: [
					{ role: "user", content: "new message", timestamp: "2025-01-01T00:01:00.000Z" },
				],
			});

			// Wait for debounce (500ms) + processing — poll to handle slow CI/load
			for (let attempt = 0; attempt < 20 && index.size === 0; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}

			expect(index.size).toBe(1);
			expect(index.get("watch1")).toBeDefined();
			expect(index.get("watch1")!.title).toBe("Watched file");
		} finally {
			index.stopWatching();
		}
	}, 10_000);

	test("removes deleted file from index when processPendingFiles runs", async () => {
		const filePath = writeConvFile({
			id: "watch_del",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Will be deleted",
			messages: [{ role: "user", content: "bye", timestamp: "2025-01-01T00:01:00.000Z" }],
		});

		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(1);
		expect(index.get("watch_del")).toBeDefined();

		// Delete the file, then simulate a watch event by directly invoking
		// processPendingFiles. This tests the cleanup logic without depending
		// on fs.watch event delivery timing, which is unreliable under CI load.
		rmSync(filePath);

		// Access private pendingFiles + processPendingFiles via the instance
		const priv = index as any;
		priv.dir = TMP_DIR;
		priv.pendingFiles.add("conv_watch_del.jsonl");
		await priv.processPendingFiles();

		expect(index.size).toBe(0);
		expect(index.get("watch_del")).toBeUndefined();
	});

	test("stopWatching cleans up", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		index.startWatching(TMP_DIR);
		index.stopWatching();

		// Write a file after stopping — should NOT be indexed
		writeConvFile({
			id: "after_stop",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Should not appear",
			messages: [{ role: "user", content: "ignored", timestamp: "2025-01-01T00:01:00.000Z" }],
		});

		await new Promise((resolve) => setTimeout(resolve, 800));

		expect(index.size).toBe(0);
	});
});
