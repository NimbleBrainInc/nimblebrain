import { describe, test, expect, mock } from "bun:test";
import { HomeService } from "../../src/bundles/home/src/services/home-service.ts";
import { BriefingCache } from "../../src/bundles/home/src/services/briefing-cache.ts";
import type { ActivityOutput, BriefingOutput } from "../../src/bundles/home/src/services/types.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const EMPTY_ACTIVITY: ActivityOutput = {
	period: { since: "2026-03-24T00:00:00Z", until: "2026-03-25T00:00:00Z" },
	conversations: [],
	bundle_events: [],
	tool_usage: [],
	errors: [],
	totals: {
		conversations: 0,
		tool_calls: 0,
		input_tokens: 0,
		output_tokens: 0,
		errors: 0,
	},
};

const MOCK_BRIEFING: BriefingOutput = {
	greeting: "Good afternoon, there",
	date: "Wednesday, March 25, 2026",
	lede: "It's been a quiet day. No activity in the last 24 hours.",
	sections: [],
	state: "quiet",
	generated_at: new Date().toISOString(),
	cached: false,
};

function createMockCollector() {
	return {
		collect: mock(async () => EMPTY_ACTIVITY),
	};
}

function createMockGenerator() {
	return {
		generate: mock(async () => ({ ...MOCK_BRIEFING })),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Home Bundle — HomeService", () => {
	test("getBriefing returns briefing with expected structure", async () => {
		const collector = createMockCollector();
		const generator = createMockGenerator();
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		const result = await service.getBriefing({});
		expect(result.greeting).toBe("Good afternoon, there");
		expect(result.date).toBe("Wednesday, March 25, 2026");
		expect(typeof result.lede).toBe("string");
		expect(result.lede.length).toBeGreaterThan(0);
		expect(Array.isArray(result.sections)).toBe(true);
		expect(result.state).toBe("quiet");
		expect(typeof result.generated_at).toBe("string");
		expect(result.cached).toBe(false);
		expect(collector.collect).toHaveBeenCalledTimes(1);
		expect(generator.generate).toHaveBeenCalledTimes(1);
	});

	test("getBriefing returns cached result on second call", async () => {
		const collector = createMockCollector();
		const generator = createMockGenerator();
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		await service.getBriefing({});
		const result2 = await service.getBriefing({});
		expect(result2.cached).toBe(true);
		expect(generator.generate).toHaveBeenCalledTimes(1);
	});

	test("getBriefing with force_refresh bypasses cache", async () => {
		const collector = createMockCollector();
		const generator = createMockGenerator();
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		await service.getBriefing({});
		await service.getBriefing({ force_refresh: true });
		expect(generator.generate).toHaveBeenCalledTimes(2);
	});

	test("getActivity returns activity with expected structure", async () => {
		const collector = createMockCollector();
		const generator = createMockGenerator();
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		const result = await service.getActivity({});
		expect(result.period.since).toBe("2026-03-24T00:00:00Z");
		expect(result.period.until).toBe("2026-03-25T00:00:00Z");
		expect(result.conversations).toEqual([]);
		expect(result.bundle_events).toEqual([]);
		expect(result.tool_usage).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.totals).toEqual({
			conversations: 0,
			tool_calls: 0,
			input_tokens: 0,
			output_tokens: 0,
			errors: 0,
		});
		expect(collector.collect).toHaveBeenCalledTimes(1);
	});

	test("getActivity passes filter parameters to collector", async () => {
		const collector = createMockCollector();
		const generator = createMockGenerator();
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		await service.getActivity({
			since: "2026-03-20T00:00:00Z",
			category: "conversations",
			limit: 10,
		});
		const call = collector.collect.mock.calls[0][0];
		expect(call.since).toBe("2026-03-20T00:00:00Z");
		expect(call.category).toBe("conversations");
		expect(call.limit).toBe(10);
	});

	test("getBriefing propagates generator errors", async () => {
		const collector = createMockCollector();
		const generator = {
			generate: mock(async () => {
				throw new Error("LLM unavailable");
			}),
		};
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		await expect(service.getBriefing({})).rejects.toThrow("LLM unavailable");
	});

	test("getActivity propagates collector errors", async () => {
		const collector = {
			collect: mock(async () => {
				throw new Error("Log dir missing");
			}),
		};
		const generator = createMockGenerator();
		const cache = new BriefingCache(30);
		const service = new HomeService(
			collector as any,
			generator as any,
			cache,
		);

		await expect(service.getActivity({})).rejects.toThrow("Log dir missing");
	});
});

describe("Home Bundle — BriefingCache", () => {
	test("returns null when empty", () => {
		const cache = new BriefingCache(30);
		expect(cache.get()).toBeNull();
	});

	test("returns cached briefing with cached: true", () => {
		const cache = new BriefingCache(30);
		cache.set(MOCK_BRIEFING, "hash1");
		const result = cache.get();
		expect(result).not.toBeNull();
		expect(result!.cached).toBe(true);
	});

	test("invalidate makes cache return null", () => {
		const cache = new BriefingCache(30);
		cache.set(MOCK_BRIEFING, "hash1");
		cache.invalidate();
		expect(cache.get()).toBeNull();
	});
});
