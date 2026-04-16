import { describe, test, expect, beforeEach } from "bun:test";
import { HomeService } from "../../../src/services/home-service.ts";
import { BriefingCache } from "../../../src/services/briefing-cache.ts";
import type { ActivityOutput, BriefingOutput } from "../../../src/services/home-types.ts";

// --- Canned data ---

const cannedActivity: ActivityOutput = {
	period: { since: "2026-03-24T00:00:00.000Z", until: "2026-03-25T00:00:00.000Z" },
	conversations: [],
	bundle_events: [],
	tool_usage: [],
	errors: [],
	totals: { conversations: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, errors: 0 },
};

const cannedBriefing: BriefingOutput = {
	greeting: "Good morning, Mat",
	date: "Tuesday, March 25, 2026",
	lede: "All clear — no activity in the last 24 hours.",
	sections: [],
	state: "quiet",
	generated_at: "2026-03-25T12:00:00.000Z",
	cached: false,
};

// --- Mocks ---

function createMockCollector(output: ActivityOutput = cannedActivity) {
	const calls: unknown[] = [];
	return {
		calls,
		collect: async (input?: unknown) => {
			calls.push(input);
			return output;
		},
	};
}

function createMockGenerator(output: BriefingOutput = cannedBriefing) {
	const calls: unknown[] = [];
	return {
		calls,
		generate: async (activity: unknown) => {
			calls.push(activity);
			return output;
		},
	};
}

function createMockEventManager() {
	let storedCallback: ((event: string, data: Record<string, unknown>) => void) | null = null;
	return {
		onEvent(cb: (event: string, data: Record<string, unknown>) => void) {
			storedCallback = cb;
		},
		trigger(event: string, data: Record<string, unknown> = {}) {
			if (storedCallback) storedCallback(event, data);
		},
	};
}

// --- Tests ---

describe("HomeService", () => {
	let collector: ReturnType<typeof createMockCollector>;
	let generator: ReturnType<typeof createMockGenerator>;
	let cache: BriefingCache;
	let eventManager: ReturnType<typeof createMockEventManager>;
	let service: HomeService;

	beforeEach(() => {
		collector = createMockCollector();
		generator = createMockGenerator();
		cache = new BriefingCache(30);
		eventManager = createMockEventManager();
		service = new HomeService(
			collector as any,
			generator as any,
			cache,
			eventManager as any,
		);
	});

	test("cached briefing returned without calling generator", async () => {
		// Prime the cache by calling once
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		// Second call should use cache
		const result = await service.getBriefing();
		expect(result.cached).toBe(true);
		expect(generator.calls).toHaveLength(1); // generator not called again
		expect(collector.calls).toHaveLength(1); // collector not called again
	});

	test("force refresh bypasses cache", async () => {
		// Prime the cache
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		// Force refresh should regenerate
		const result = await service.getBriefing({ force_refresh: true });
		expect(result.cached).toBe(false);
		expect(generator.calls).toHaveLength(2);
		expect(collector.calls).toHaveLength(2);
	});

	test("stale cache triggers regeneration", async () => {
		// Prime the cache
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		// Manually invalidate to simulate staleness
		cache.invalidate();

		// Next call should regenerate
		await service.getBriefing();
		expect(generator.calls).toHaveLength(2);
	});

	test("event-driven invalidation", async () => {
		// Prime the cache
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		// Verify cache is working
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		// Trigger a data.changed event
		eventManager.trigger("data.changed");

		// Next call should regenerate because cache was invalidated
		await service.getBriefing();
		expect(generator.calls).toHaveLength(2);
	});

	test("bundle events also invalidate cache", async () => {
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		eventManager.trigger("bundle.installed", { name: "test-bundle" });

		await service.getBriefing();
		expect(generator.calls).toHaveLength(2);
	});

	test("non-matching events do not invalidate cache", async () => {
		await service.getBriefing();
		expect(generator.calls).toHaveLength(1);

		eventManager.trigger("heartbeat");

		await service.getBriefing();
		expect(generator.calls).toHaveLength(1); // still cached
	});

	test("activity passthrough with defaults", async () => {
		const before = Date.now();
		await service.getActivity();
		const after = Date.now();

		expect(collector.calls).toHaveLength(1);
		const input = collector.calls[0] as Record<string, unknown>;

		// since should be ~24h ago
		const since = new Date(input.since as string).getTime();
		const expectedSince = before - 24 * 60 * 60 * 1000;
		expect(Math.abs(since - expectedSince)).toBeLessThan(1000);

		// until should be ~now
		const until = new Date(input.until as string).getTime();
		expect(Math.abs(until - before)).toBeLessThan(1000);

		// limit should be 50
		expect(input.limit).toBe(50);
	});

	test("activity passthrough with custom input", async () => {
		await service.getActivity({
			since: "2026-03-20T00:00:00.000Z",
			category: "errors",
			limit: 10,
		});

		const input = collector.calls[0] as Record<string, unknown>;
		expect(input.since).toBe("2026-03-20T00:00:00.000Z");
		expect(input.category).toBe("errors");
		expect(input.limit).toBe(10);
	});

	test("error in collector propagates", async () => {
		const failingCollector = {
			collect: async () => {
				throw new Error("collector failure");
			},
		};
		const svc = new HomeService(
			failingCollector as any,
			generator as any,
			cache,
			eventManager as any,
		);

		expect(svc.getBriefing()).rejects.toThrow("collector failure");
	});

	test("error in generator propagates", async () => {
		const failingGenerator = {
			generate: async () => {
				throw new Error("generator failure");
			},
		};
		const svc = new HomeService(
			collector as any,
			failingGenerator as any,
			cache,
			eventManager as any,
		);

		expect(svc.getBriefing()).rejects.toThrow("generator failure");
	});
});
