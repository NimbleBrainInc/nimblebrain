import { describe, test, expect, beforeEach } from "bun:test";
import { BriefingCache } from "../../../src/services/briefing-cache.ts";
import type { BriefingOutput } from "../../../src/services/home-types.ts";

function makeBriefing(overrides?: Partial<BriefingOutput>): BriefingOutput {
	return {
		greeting: "Good afternoon, Test",
		date: "Wednesday, March 25, 2026",
		lede: "All clear.",
		sections: [],
		state: "all-clear",
		generated_at: new Date().toISOString(),
		cached: false,
		...overrides,
	};
}

describe("BriefingCache", () => {
	let cache: BriefingCache;

	beforeEach(() => {
		cache = new BriefingCache(30); // 30 min TTL
	});

	test("initial state: get() returns null, isStale() returns true", () => {
		expect(cache.get()).toBeNull();
		expect(cache.isStale()).toBe(true);
	});

	test("set() then get() returns briefing with cached: true", () => {
		const briefing = makeBriefing();
		cache.set(briefing, "hash1");
		const result = cache.get();
		expect(result).not.toBeNull();
		expect(result!.cached).toBe(true);
		expect(result!.greeting).toBe("Good afternoon, Test");
	});

	test("invalidate() causes get() to return null", () => {
		cache.set(makeBriefing(), "hash1");
		cache.invalidate();
		expect(cache.get()).toBeNull();
		expect(cache.isStale()).toBe(true);
	});

	test("re-set after invalidation works", () => {
		cache.set(makeBriefing(), "hash1");
		cache.invalidate();
		expect(cache.get()).toBeNull();
		cache.set(makeBriefing({ lede: "Updated" }), "hash2");
		const result = cache.get();
		expect(result).not.toBeNull();
		expect(result!.lede).toBe("Updated");
	});

	test("expired cache returns null", () => {
		const originalNow = Date.now;
		try {
			const cache31 = new BriefingCache(30);
			Date.now = originalNow;
			cache31.set(makeBriefing(), "hash1");
			Date.now = () => originalNow() + 31 * 60 * 1000;
			expect(cache31.get()).toBeNull();
		} finally {
			Date.now = originalNow;
		}
	});

	test("not expired within TTL", () => {
		const originalNow = Date.now;
		try {
			cache.set(makeBriefing(), "hash1");
			Date.now = () => originalNow() + 15 * 60 * 1000; // 15 minutes (within 30 min TTL)
			expect(cache.get()).not.toBeNull();
		} finally {
			Date.now = originalNow;
		}
	});
});
