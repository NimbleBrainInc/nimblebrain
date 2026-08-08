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
	ownerId?: string;
	workspaceId?: string | null;
	messages?: Array<{ role: string; content: string; timestamp: string }>;
}

function writeConvFile(spec: ConvSpec): string {
	const meta = {
		id: spec.id,
		createdAt: spec.createdAt,
		updatedAt: spec.updatedAt,
		title: spec.title,
		lastModel: spec.lastModel ?? null,
		...(spec.ownerId ? { ownerId: spec.ownerId } : {}),
		...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}),
	};

	// Bundle no longer reads line-1 totals — attach the requested totals
	// as `metadata.usage` on the last assistant message so the read-time
	// derivation produces matching numbers without changing message count.
	const messages = (spec.messages ?? []).map((m) => ({ ...m })) as Array<
		Record<string, unknown>
	>;
	const wantsTotals = spec.totalInputTokens || spec.totalOutputTokens;
	if (wantsTotals) {
		const lastAssistantIdx = (() => {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]!.role === "assistant") return i;
			}
			return -1;
		})();
		if (lastAssistantIdx >= 0) {
			messages[lastAssistantIdx]!.metadata = {
				model: spec.lastModel ?? "claude-sonnet-4-5-20250929",
				usage: {
					inputTokens: spec.totalInputTokens ?? 0,
					outputTokens: spec.totalOutputTokens ?? 0,
				},
			};
		}
	}

	const lines = [JSON.stringify(meta)];
	for (const msg of messages) {
		lines.push(JSON.stringify(msg));
	}

	const filename = `conv_${spec.id}.jsonl`;
	// The index takes an entry's workspace from its DIRECTORY, so a fixture that
	// names a workspace has to live under it. A spec with no workspace stays flat
	// (the legacy layout), which is under no workspace at all.
	const dir = spec.workspaceId
		? join(TMP_DIR, spec.workspaceId, "conversations", spec.ownerId ?? "unknown")
		: TMP_DIR;
	mkdirSync(dir, { recursive: true });
	const path = join(dir, filename);
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
// list() — workspace (workspace) filtering
// ---------------------------------------------------------------------------

describe("list workspace filtering", () => {
	// One owner's chats across two workspaces, a workspaceless (legacy) chat, and another
	// owner's chat in one of the workspaces (to prove the workspace filter composes with
	// the ownership filter).
	async function buildWorkspaceIndex(): Promise<ConversationIndex> {
		writeConvFile({
			id: "helix1",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Helix chat",
			ownerId: "u1",
			workspaceId: "ws_helix",
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "acme1",
			createdAt: "2025-01-02T00:00:00.000Z",
			updatedAt: "2025-01-02T00:00:00.000Z",
			title: "Acme chat",
			ownerId: "u1",
			workspaceId: "ws_acme",
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-02T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "legacy1",
			createdAt: "2025-01-03T00:00:00.000Z",
			updatedAt: "2025-01-03T00:00:00.000Z",
			title: "Workspaceless legacy chat",
			ownerId: "u1",
			// no workspaceId — belongs to the personal workspace
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-03T00:01:00.000Z" }],
		});
		writeConvFile({
			id: "helix_other",
			createdAt: "2025-01-04T00:00:00.000Z",
			updatedAt: "2025-01-04T00:00:00.000Z",
			title: "Another owner in Helix",
			ownerId: "u2",
			workspaceId: "ws_helix",
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-04T00:01:00.000Z" }],
		});
		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		return index;
	}

	test("workspaceId scopes to that workspace, excluding other workspaces and workspaceless chats", async () => {
		const index = await buildWorkspaceIndex();
		const r = index.list({ workspaceId: "ws_helix" }, { userId: "u1" });
		expect(r.conversations.map((c) => c.id)).toEqual(["helix1"]);
		expect(r.totalCount).toBe(1);
	});

	test("a legacy flat-layout chat is under no workspace, so no workspace lists it", async () => {
		// The directory is the binding, so a file that is not under a workspace is
		// not in one — including from the owner's own personal workspace.
		const index = await buildWorkspaceIndex();
		expect(
			index.list({ workspaceId: "ws_user_u1" }, { userId: "u1" }).conversations,
		).toHaveLength(0);
		expect(
			index.list({ workspaceId: "ws_helix" }, { userId: "u1" }).conversations.map((c) => c.id),
		).toEqual(["helix1"]);
	});

	test("no workspaceId returns all of the owner's workspaces", async () => {
		const index = await buildWorkspaceIndex();
		const r = index.list({}, { userId: "u1" });
		expect(r.conversations.map((c) => c.id).sort()).toEqual(["acme1", "helix1", "legacy1"]);
	});

	test("the workspace filter runs before the limit (no post-pagination under-count)", async () => {
		// 25 Acme chats newer than one older Helix chat. A global most-recent
		// page of 20 is all Acme, so post-pagination filtering would return the
		// Helix workspace empty. Filtering server-side before the slice returns it.
		for (let i = 0; i < 25; i++) {
			const day = String(i + 1).padStart(2, "0");
			writeConvFile({
				id: `acme_${i}`,
				createdAt: `2025-02-${day}T00:00:00.000Z`,
				updatedAt: `2025-02-${day}T00:00:00.000Z`,
				title: `Acme ${i}`,
				ownerId: "u1",
				workspaceId: "ws_acme",
				messages: [{ role: "user", content: "hi", timestamp: `2025-02-${day}T00:01:00.000Z` }],
			});
		}
		writeConvFile({
			id: "helix_old",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "Old Helix chat",
			ownerId: "u1",
			workspaceId: "ws_helix",
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// The Helix chat is NOT in the global most-recent page of 20.
		const globalPage = index.list({ limit: 20 }, { userId: "u1" });
		expect(globalPage.conversations.map((c) => c.id)).not.toContain("helix_old");

		// Workspace-scoped: the limit applies to Helix's set, so its chat is returned.
		const helix = index.list({ limit: 20, workspaceId: "ws_helix" }, { userId: "u1" });
		expect(helix.conversations.map((c) => c.id)).toEqual(["helix_old"]);
		expect(helix.totalCount).toBe(1);
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
// Incremental invalidation
// ---------------------------------------------------------------------------

describe("incremental invalidation", () => {
	function conv(id: string, title: string, updatedAt = "2025-01-01T00:00:00.000Z"): string {
		return writeConvFile({
			id,
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt,
			title,
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
	}

	test("a named change re-reads only that conversation", async () => {
		const aPath = conv("inc_a", "A");
		const bPath = conv("inc_b", "B");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(2);

		// Rewrite A's title, and delete B behind the index's back. A targeted
		// refresh must pick up A and must NOT notice B — if it walked the
		// directory, B would vanish and this assertion would fail. That is the
		// whole point of the change, so it is asserted rather than assumed.
		writeConvFile({
			id: "inc_a",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-06-01T00:00:00.000Z",
			title: "A renamed",
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		rmSync(bPath);

		index.invalidate({ id: "inc_a", filePath: aPath, wsId: null });
		await index.refresh();

		expect(index.get("inc_a")!.title).toBe("A renamed");
		expect(index.get("inc_b")).toBeDefined();
		expect(index.size).toBe(2);
	});

	test("a named change indexes a conversation the index has never seen", async () => {
		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(0);

		const path = conv("inc_new", "Brand new");
		index.invalidate({ id: "inc_new", filePath: path, wsId: null });
		await index.refresh();

		expect(index.size).toBe(1);
		expect(index.get("inc_new")!.title).toBe("Brand new");
	});

	test("a named change whose file is gone drops the entry", async () => {
		const path = conv("inc_del", "Will be deleted");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.get("inc_del")).toBeDefined();

		rmSync(path);
		index.invalidate({ id: "inc_del", filePath: path, wsId: null });
		await index.refresh();

		expect(index.size).toBe(0);
		expect(index.get("inc_del")).toBeUndefined();
	});

	test("repeated changes to one conversation collapse to a single entry", async () => {
		const path = conv("inc_burst", "v1");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		for (const title of ["v2", "v3", "v4"]) {
			writeConvFile({
				id: "inc_burst",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				title,
				messages: [{ role: "user", content: "hi", timestamp: "2025-01-01T00:01:00.000Z" }],
			});
			index.invalidate({ id: "inc_burst", filePath: path, wsId: null });
		}

		await index.refresh();

		expect(index.size).toBe(1);
		expect(index.get("inc_burst")!.title).toBe("v4");
	});

	test("an unattributed change still rebuilds the whole index", async () => {
		const bPath = conv("inc_x", "X");
		conv("inc_y", "Y");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);
		expect(index.size).toBe(2);

		// No change argument — the caller cannot say what moved (a workspace
		// archive-delete), so the vanished file must be noticed.
		rmSync(bPath);
		index.invalidate();
		await index.refresh();

		expect(index.size).toBe(1);
		expect(index.get("inc_x")).toBeUndefined();
		expect(index.get("inc_y")).toBeDefined();
	});

	test("a full rebuild subsumes pending targeted changes", async () => {
		const aPath = conv("inc_p", "P");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		writeConvFile({
			id: "inc_p",
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			title: "P renamed",
			messages: [{ role: "user", content: "hi", timestamp: "2025-01-01T00:01:00.000Z" }],
		});
		index.invalidate({ id: "inc_p", filePath: aPath, wsId: null });
		index.invalidate();
		await index.refresh();

		expect(index.get("inc_p")!.title).toBe("P renamed");

		// The rebuild consumed the pending change; a second refresh has nothing
		// left to do and must not resurrect it.
		rmSync(aPath);
		await index.refresh();
		expect(index.get("inc_p")!.title).toBe("P renamed");
	});

	test("refresh is a no-op when nothing was invalidated", async () => {
		const path = conv("inc_clean", "Clean");

		const index = new ConversationIndex();
		await index.build(TMP_DIR);

		// Nothing signalled a change, so a stale index is the correct answer —
		// refresh must not walk the directory looking for one.
		rmSync(path);
		await index.refresh();

		expect(index.size).toBe(1);
	});
});
