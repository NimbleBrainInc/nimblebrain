import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationIndex } from "../../src/conversation/index-cache.ts";
import type { ConversationSummary } from "../../src/conversation/types.ts";

function tempDir(): string {
	const dir = join(tmpdir(), `nb-index-test-${crypto.randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConversation(
	dir: string,
	id: string,
	opts: {
		createdAt?: string;
		updatedAt?: string;
		title?: string | null;
		userMessage?: string;
		extraMessages?: number;
	} = {},
): void {
	const createdAt = opts.createdAt ?? "2025-01-01T00:00:00.000Z";
	const updatedAt = opts.updatedAt ?? createdAt;
	const meta = JSON.stringify({
		id,
		createdAt,
		updatedAt,
		title: opts.title ?? null,
		totalInputTokens: 100,
		totalOutputTokens: 50,
		totalCostUsd: 0.01,
		lastModel: "claude-sonnet-4-5-20250929",
	});
	const userMsg = JSON.stringify({
		role: "user",
		content: opts.userMessage ?? "Hello",
		timestamp: createdAt,
	});
	const assistantMsg = JSON.stringify({
		role: "assistant",
		content: "Hi there",
		timestamp: createdAt,
	});

	let content = `${meta}\n${userMsg}\n${assistantMsg}\n`;
	for (let i = 0; i < (opts.extraMessages ?? 0); i++) {
		content += `${JSON.stringify({ role: "user", content: `msg ${i}`, timestamp: createdAt })}\n`;
	}
	writeFileSync(join(dir, `${id}.jsonl`), content);
}

describe("ConversationIndex", () => {
	let dir: string;
	let index: ConversationIndex;

	beforeEach(() => {
		dir = tempDir();
		index = new ConversationIndex();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("populate() with 3 JSONL files builds index with 3 entries", async () => {
		writeConversation(dir, "conv_aaa", { createdAt: "2025-01-01T00:00:00.000Z" });
		writeConversation(dir, "conv_bbb", { createdAt: "2025-02-01T00:00:00.000Z" });
		writeConversation(dir, "conv_ccc", { createdAt: "2025-03-01T00:00:00.000Z" });

		await index.populate(dir);

		expect(index.get("conv_aaa")).toBeDefined();
		expect(index.get("conv_bbb")).toBeDefined();
		expect(index.get("conv_ccc")).toBeDefined();
		expect(index.get("conv_zzz")).toBeUndefined();
	});

	it('search("Q2") matches conversation with "Q2" in title', async () => {
		writeConversation(dir, "conv_q2", {
			title: "Q2 Planning Meeting",
			userMessage: "Let's plan",
		});
		writeConversation(dir, "conv_other", {
			title: "Sprint Review",
			userMessage: "Review time",
		});

		await index.populate(dir);

		const results = index.search("Q2");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("conv_q2");
	});

	it('search("xyz") returns empty array', async () => {
		writeConversation(dir, "conv_one", { title: "Alpha" });
		writeConversation(dir, "conv_two", { title: "Beta" });

		await index.populate(dir);

		const results = index.search("xyz");
		expect(results).toHaveLength(0);
	});

	it("search matches against preview (user message)", async () => {
		writeConversation(dir, "conv_budget", {
			title: "Meeting",
			userMessage: "What is our Q3 budget?",
		});

		await index.populate(dir);

		const results = index.search("budget");
		expect(results).toHaveLength(1);
		expect(results[0]!.id).toBe("conv_budget");
	});

	it("list with limit=2 returns 2 items and a nextCursor", async () => {
		writeConversation(dir, "conv_1", {
			updatedAt: "2025-01-01T00:00:00.000Z",
		});
		writeConversation(dir, "conv_2", {
			updatedAt: "2025-02-01T00:00:00.000Z",
		});
		writeConversation(dir, "conv_3", {
			updatedAt: "2025-03-01T00:00:00.000Z",
		});

		await index.populate(dir);

		const result = index.list({ limit: 2 });
		expect(result.conversations).toHaveLength(2);
		expect(result.nextCursor).not.toBeNull();
		expect(result.totalCount).toBe(3);
		// Sorted by updatedAt descending — conv_3 first, then conv_2
		expect(result.conversations[0]!.id).toBe("conv_3");
		expect(result.conversations[1]!.id).toBe("conv_2");
	});

	it("list with cursor returns items after that cursor", async () => {
		writeConversation(dir, "conv_1", {
			updatedAt: "2025-01-01T00:00:00.000Z",
		});
		writeConversation(dir, "conv_2", {
			updatedAt: "2025-02-01T00:00:00.000Z",
		});
		writeConversation(dir, "conv_3", {
			updatedAt: "2025-03-01T00:00:00.000Z",
		});

		await index.populate(dir);

		// First page
		const page1 = index.list({ limit: 2 });
		expect(page1.nextCursor).toBe("conv_2");

		// Second page using cursor
		const page2 = index.list({ limit: 2, cursor: page1.nextCursor! });
		expect(page2.conversations).toHaveLength(1);
		expect(page2.conversations[0]!.id).toBe("conv_1");
		expect(page2.nextCursor).toBeNull();
	});

	it("invalidate() causes re-scan on next populate()", async () => {
		writeConversation(dir, "conv_first", {
			updatedAt: "2025-01-01T00:00:00.000Z",
		});

		await index.populate(dir);
		expect(index.list().totalCount).toBe(1);

		// Add another file — populate() should be a no-op because already populated
		writeConversation(dir, "conv_second", {
			updatedAt: "2025-02-01T00:00:00.000Z",
		});
		await index.populate(dir);
		expect(index.list().totalCount).toBe(1); // Still 1, no re-scan

		// Invalidate and re-populate
		index.invalidate();
		await index.populate(dir);
		expect(index.list().totalCount).toBe(2); // Now sees both
	});

	it("upsert() updates an existing entry without re-scanning", async () => {
		writeConversation(dir, "conv_up", { title: "Original" });

		await index.populate(dir);
		expect(index.get("conv_up")!.title).toBe("Original");

		const updated: ConversationSummary = {
			...index.get("conv_up")!,
			title: "Updated Title",
		};
		index.upsert(updated);

		expect(index.get("conv_up")!.title).toBe("Updated Title");
	});

	it("remove() deletes an entry from the index", async () => {
		writeConversation(dir, "conv_del", { title: "To Delete" });

		await index.populate(dir);
		expect(index.get("conv_del")).toBeDefined();

		index.remove("conv_del");
		expect(index.get("conv_del")).toBeUndefined();
		expect(index.list().totalCount).toBe(0);
	});

	it("list sorts by createdAt when specified", async () => {
		writeConversation(dir, "conv_old_create", {
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-06-01T00:00:00.000Z", // updated recently
		});
		writeConversation(dir, "conv_new_create", {
			createdAt: "2025-05-01T00:00:00.000Z",
			updatedAt: "2025-02-01T00:00:00.000Z", // updated earlier
		});

		await index.populate(dir);

		const byUpdated = index.list({ sortBy: "updatedAt" });
		expect(byUpdated.conversations[0]!.id).toBe("conv_old_create");

		const byCreated = index.list({ sortBy: "createdAt" });
		expect(byCreated.conversations[0]!.id).toBe("conv_new_create");
	});

	it("handles old-format files missing updatedAt and title", async () => {
		// Write a minimal old-format file (only id and createdAt)
		const meta = JSON.stringify({ id: "conv_old", createdAt: "2024-06-01T00:00:00.000Z" });
		const userMsg = JSON.stringify({ role: "user", content: "old message", timestamp: "2024-06-01T00:00:00.000Z" });
		writeFileSync(join(dir, "conv_old.jsonl"), `${meta}\n${userMsg}\n`);

		await index.populate(dir);

		const entry = index.get("conv_old");
		expect(entry).toBeDefined();
		expect(entry!.updatedAt).toBe("2024-06-01T00:00:00.000Z"); // falls back to createdAt
		expect(entry!.title).toBeNull();
		expect(entry!.totalInputTokens).toBe(0);
		expect(entry!.preview).toBe("old message");
	});

	it("populate() handles non-existent directory gracefully", async () => {
		const missingDir = join(tmpdir(), `nb-missing-${crypto.randomUUID()}`);
		await index.populate(missingDir);
		expect(index.list().totalCount).toBe(0);
	});

	it("list with search filters results", async () => {
		writeConversation(dir, "conv_match", { title: "Deploy Pipeline" });
		writeConversation(dir, "conv_nope", { title: "Budget Review" });

		await index.populate(dir);

		const result = index.list({ search: "deploy" });
		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0]!.id).toBe("conv_match");
		expect(result.totalCount).toBe(1);
	});
});
