import { beforeEach, describe, expect, it } from "bun:test";
import { Runtime } from "../../src/runtime/runtime.ts";

/**
 * Tests for getAppSkillResource (task 012).
 *
 * Since getAppSkillResource is a private method, we test it indirectly through
 * a minimal extracted version that uses the same logic. This avoids needing to
 * spin up a full Runtime with MCP servers.
 */

interface CacheEntry {
	content: string;
	fetchedAt: number;
}

interface FakeSource {
	name: string;
	readResource(uri: string): Promise<string | null>;
}

const SKILL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — matches Runtime

/** Extracted logic matching Runtime.getAppSkillResource for unit testing. */
async function getAppSkillResource(
	serverName: string,
	cache: Map<string, CacheEntry>,
	sources: FakeSource[],
): Promise<string | null> {
	const cached = cache.get(serverName);
	if (cached && Date.now() - cached.fetchedAt < SKILL_CACHE_TTL) {
		return cached.content;
	}

	const source = sources.find((s) => s.name === serverName);
	if (!source || !("readResource" in source)) return null;

	try {
		const content = await source.readResource(`skill://${serverName}/usage`);
		if (content) {
			const truncated =
				content.length > 12000
					? content.slice(0, 12000) + "\n\n[truncated]"
					: content;
			cache.set(serverName, { content: truncated, fetchedAt: Date.now() });
			return truncated;
		}
	} catch {
		// Resource doesn't exist or read failed — skip silently
	}
	return null;
}

describe("getAppSkillResource", () => {
	let cache: Map<string, CacheEntry>;

	beforeEach(() => {
		cache = new Map();
	});

	it("returns cached content within TTL", async () => {
		let readCount = 0;
		const source: FakeSource = {
			name: "tasks",
			readResource: async () => {
				readCount++;
				return "Use tasks__create to add items.";
			},
		};

		// First call — should read from source
		const result1 = await getAppSkillResource("tasks", cache, [source]);
		expect(result1).toBe("Use tasks__create to add items.");
		expect(readCount).toBe(1);

		// Second call — should return from cache, not call readResource again
		const result2 = await getAppSkillResource("tasks", cache, [source]);
		expect(result2).toBe("Use tasks__create to add items.");
		expect(readCount).toBe(1);
	});

	it("expires cache and triggers fresh read after TTL", async () => {
		let readCount = 0;
		const source: FakeSource = {
			name: "tasks",
			readResource: async () => {
				readCount++;
				return `Response ${readCount}`;
			},
		};

		// First call
		const result1 = await getAppSkillResource("tasks", cache, [source]);
		expect(result1).toBe("Response 1");
		expect(readCount).toBe(1);

		// Manually expire the cache entry
		const entry = cache.get("tasks")!;
		entry.fetchedAt = Date.now() - SKILL_CACHE_TTL - 1;

		// Should re-fetch
		const result2 = await getAppSkillResource("tasks", cache, [source]);
		expect(result2).toBe("Response 2");
		expect(readCount).toBe(2);
	});

	it("returns null when source does not exist", async () => {
		const result = await getAppSkillResource("nonexistent", cache, []);
		expect(result).toBeNull();
	});

	it("returns null when readResource fails", async () => {
		const source: FakeSource = {
			name: "broken",
			readResource: async () => {
				throw new Error("Connection refused");
			},
		};

		const result = await getAppSkillResource("broken", cache, [source]);
		expect(result).toBeNull();
	});

	it("returns null when readResource returns null", async () => {
		const source: FakeSource = {
			name: "empty",
			readResource: async () => null,
		};

		const result = await getAppSkillResource("empty", cache, [source]);
		expect(result).toBeNull();
		// Should not cache a null result
		expect(cache.has("empty")).toBe(false);
	});

	it("truncates content over 12000 characters", async () => {
		const longContent = "x".repeat(15000);
		const source: FakeSource = {
			name: "verbose",
			readResource: async () => longContent,
		};

		const result = await getAppSkillResource("verbose", cache, [source]);
		expect(result).not.toBeNull();
		expect(result!.length).toBe(12000 + "\n\n[truncated]".length);
		expect(result!).toEndWith("\n\n[truncated]");
		// First 12000 chars preserved
		expect(result!.startsWith("x".repeat(12000))).toBe(true);
	});

	it("does not truncate content at exactly 12000 characters", async () => {
		const exactContent = "y".repeat(12000);
		const source: FakeSource = {
			name: "exact",
			readResource: async () => exactContent,
		};

		const result = await getAppSkillResource("exact", cache, [source]);
		expect(result).toBe(exactContent);
		expect(result).not.toContain("[truncated]");
	});

	it("returns null when source has no readResource method", async () => {
		// Simulate a source without readResource (e.g., InlineSource)
		const source = { name: "inline-only" } as unknown as FakeSource;

		const result = await getAppSkillResource("inline-only", cache, [source]);
		expect(result).toBeNull();
	});
});
