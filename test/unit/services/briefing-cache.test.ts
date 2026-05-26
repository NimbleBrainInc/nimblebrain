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
		cache.set(briefing);
		const result = cache.get();
		expect(result).not.toBeNull();
		expect(result!.cached).toBe(true);
		expect(result!.greeting).toBe("Good afternoon, Test");
	});

	test("invalidate() causes get() to return null", () => {
		cache.set(makeBriefing());
		cache.invalidate();
		expect(cache.get()).toBeNull();
		expect(cache.isStale()).toBe(true);
	});

	test("re-set after invalidation works", () => {
		cache.set(makeBriefing());
		cache.invalidate();
		expect(cache.get()).toBeNull();
		cache.set(makeBriefing({ lede: "Updated" }));
		const result = cache.get();
		expect(result).not.toBeNull();
		expect(result!.lede).toBe("Updated");
	});

	test("expired cache returns null", () => {
		const originalNow = Date.now;
		try {
			const cache31 = new BriefingCache(30);
			Date.now = originalNow;
			cache31.set(makeBriefing());
			Date.now = () => originalNow() + 31 * 60 * 1000;
			expect(cache31.get()).toBeNull();
		} finally {
			Date.now = originalNow;
		}
	});

	test("not expired within TTL", () => {
		const originalNow = Date.now;
		try {
			cache.set(makeBriefing());
			Date.now = () => originalNow() + 15 * 60 * 1000; // 15 minutes (within 30 min TTL)
			expect(cache.get()).not.toBeNull();
		} finally {
			Date.now = originalNow;
		}
	});

	test("getStale() returns an expired entry (stale-while-revalidate) while get() returns null", () => {
		const originalNow = Date.now;
		try {
			cache.set(makeBriefing({ lede: "Stale but serviceable" }));
			Date.now = () => originalNow() + 31 * 60 * 1000; // past the 30 min TTL
			expect(cache.get()).toBeNull(); // fresh check fails
			const stale = cache.getStale(); // but stale is still served
			expect(stale).not.toBeNull();
			expect(stale!.cached).toBe(true);
			expect(stale!.lede).toBe("Stale but serviceable");
		} finally {
			Date.now = originalNow;
		}
	});

	test("getStale() returns null when empty or invalidated", () => {
		expect(cache.getStale()).toBeNull(); // empty
		cache.set(makeBriefing());
		cache.invalidate();
		expect(cache.getStale()).toBeNull(); // invalidated is not served, even as stale
	});
});

