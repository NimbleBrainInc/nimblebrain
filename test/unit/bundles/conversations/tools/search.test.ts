import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationIndex } from "../../../../../src/bundles/conversations/src/index-cache.ts";
import { handleSearch } from "../../../../../src/bundles/conversations/src/tools/search.ts";

function tempDir(): string {
	const dir = join(tmpdir(), `nb-search-test-${crypto.randomUUID()}`);
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

describe("conversations__search", () => {
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

	it("finds a term that appears in message content but NOT in title/preview", async () => {
		writeConversation(dir, "conv-1", {
			title: "Unrelated Title",
			messages: [
				{ role: "user", content: "Tell me about Kubernetes" },
				{ role: "assistant", content: "Kubernetes is an orchestration platform for containers." },
			],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "orchestration" }, index)) as {
			results: Array<{ id: string; matches: Array<{ snippet: string }> }>;
		};

		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.id).toBe("conv-1");
		expect(result.results[0]!.matches[0]!.snippet).toContain("orchestration");
	});

	it("matches case-insensitively", async () => {
		writeConversation(dir, "conv-ci", {
			messages: [
				{ role: "user", content: "Set up auth middleware" },
				{ role: "assistant", content: "Here is the Auth configuration." },
			],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "Auth" }, index)) as {
			results: Array<{ id: string; matches: Array<{ messageIndex: number }> }>;
		};

		// Should match the first message ("auth middleware") case-insensitively
		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.matches.length).toBeGreaterThanOrEqual(1);
	});

	it("caps at 3 snippets per conversation even when more messages match", async () => {
		writeConversation(dir, "conv-many", {
			messages: [
				{ role: "user", content: "deploy step 1" },
				{ role: "assistant", content: "deploy step 2" },
				{ role: "user", content: "deploy step 3" },
				{ role: "assistant", content: "deploy step 4" },
				{ role: "user", content: "deploy step 5" },
			],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "deploy" }, index)) as {
			results: Array<{ id: string; matches: Array<{ messageIndex: number }> }>;
		};

		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.matches).toHaveLength(3);
	});

	it("respects limit=1 and returns only 1 conversation", async () => {
		writeConversation(dir, "conv-a", {
			messages: [{ role: "user", content: "database migration" }],
		});
		writeConversation(dir, "conv-b", {
			messages: [{ role: "user", content: "database backup" }],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "database", limit: 1 }, index)) as {
			results: Array<{ id: string }>;
		};

		expect(result.results).toHaveLength(1);
	});

	it("throws error for empty query", async () => {
		await index.build(dir);

		await expect(handleSearch({ query: "" }, index)).rejects.toThrow(
			"query is required and cannot be empty",
		);
	});

	it("throws error for whitespace-only query", async () => {
		await index.build(dir);

		await expect(handleSearch({ query: "   " }, index)).rejects.toThrow(
			"query is required and cannot be empty",
		);
	});

	it("returns empty results when no messages match", async () => {
		writeConversation(dir, "conv-nomatch", {
			messages: [
				{ role: "user", content: "Hello world" },
				{ role: "assistant", content: "Greetings!" },
			],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "xyznonexistent" }, index)) as {
			results: Array<unknown>;
		};

		expect(result.results).toHaveLength(0);
	});

	it("snippet includes context around the match", async () => {
		const longPrefix = "A".repeat(150);
		const longSuffix = "B".repeat(150);
		const content = `${longPrefix} target_word ${longSuffix}`;

		writeConversation(dir, "conv-ctx", {
			messages: [{ role: "user", content }],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "target_word" }, index)) as {
			results: Array<{ matches: Array<{ snippet: string }> }>;
		};

		expect(result.results).toHaveLength(1);
		const snippet = result.results[0]!.matches[0]!.snippet;

		// Snippet should contain the match plus surrounding context
		expect(snippet).toContain("target_word");
		// Should have ellipsis since content is longer than snippet
		expect(snippet).toContain("...");
		// Snippet should be roughly 200 chars + ellipses, not the full content
		expect(snippet.length).toBeLessThan(content.length);
		expect(snippet.length).toBeGreaterThan(50);
	});

	it("returns conversation id and title in results", async () => {
		writeConversation(dir, "conv-titled", {
			title: "My Important Chat",
			messages: [{ role: "user", content: "special keyword here" }],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "special keyword" }, index)) as {
			results: Array<{ id: string; title: string | null; matches: Array<{ snippet: string }> }>;
		};

		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.id).toBe("conv-titled");
		expect(result.results[0]!.title).toBe("My Important Chat");
		expect(result.results[0]!.matches.length).toBeGreaterThan(0);
	});

	it("returns empty results for empty directory", async () => {
		await index.build(dir);

		const result = (await handleSearch({ query: "anything" }, index)) as {
			results: Array<unknown>;
		};

		expect(result.results).toHaveLength(0);
	});

	it("searches across multiple conversations", async () => {
		writeConversation(dir, "conv-x", {
			title: "Chat X",
			messages: [{ role: "user", content: "shared term in first" }],
		});
		writeConversation(dir, "conv-y", {
			title: "Chat Y",
			messages: [{ role: "user", content: "shared term in second" }],
		});
		writeConversation(dir, "conv-z", {
			title: "Chat Z",
			messages: [{ role: "user", content: "no match here" }],
		});
		await index.build(dir);

		const result = (await handleSearch({ query: "shared term" }, index)) as {
			results: Array<{ id: string }>;
			totalMatches: number;
		};

		expect(result.results).toHaveLength(2);
		expect(result.totalMatches).toBe(2);
		const ids = result.results.map((r) => r.id);
		expect(ids).toContain("conv-x");
		expect(ids).toContain("conv-y");
	});
});
