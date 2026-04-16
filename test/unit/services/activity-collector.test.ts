import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityCollector } from "../../../src/services/activity-collector.ts";
import type { ConversationStore, ConversationListResult, Conversation, ConversationPatch, ListOptions } from "../../../src/conversation/types.ts";
import type { SseEventManager, BufferedEvent } from "../../../src/api/events.ts";
import type { StoredMessage } from "../../../src/conversation/types.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockStore(
	conversations: ConversationListResult["conversations"] = [],
): ConversationStore {
	return {
		list: async (_options?: ListOptions): Promise<ConversationListResult> => ({
			conversations,
			nextCursor: null,
			totalCount: conversations.length,
		}),
		create: async () => ({}) as Conversation,
		load: async () => null,
		append: async () => {},
		history: async () => [] as StoredMessage[],
		delete: async () => false,
		update: async () => null,
		fork: async () => null,
	};
}

function makeMockEventManager(
	events: BufferedEvent[] = [],
): SseEventManager {
	return {
		getEventsSince: (since: string) =>
			events.filter((e) => e.timestamp >= since),
	} as unknown as SseEventManager;
}

function makeLogDir(): string {
	return mkdtempSync(join(tmpdir(), "activity-test-"));
}

function writeLogFile(
	logDir: string,
	date: string,
	lines: Record<string, unknown>[],
): void {
	const filename = `nimblebrain-${date}.jsonl`;
	const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	writeFileSync(join(logDir, filename), content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ActivityCollector", () => {
	let logDir: string;

	beforeEach(() => {
		logDir = makeLogDir();
	});

	it("returns zeroed output for empty workspace", async () => {
		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

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
		expect(result.period.since).toBe("2025-01-01T00:00:00Z");
		expect(result.period.until).toBe("2025-01-02T00:00:00Z");
	});

	it("maps conversation fields correctly", async () => {
		const store = makeMockStore([
			{
				id: "conv-1",
				createdAt: "2025-01-01T10:00:00Z",
				updatedAt: "2025-01-01T11:00:00Z",
				title: "Test conversation",
				messageCount: 5,
				preview: "Hello world",
				totalInputTokens: 1000,
				totalOutputTokens: 200,
				totalCostUsd: 0.01,
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			store,
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.conversations).toHaveLength(1);
		const c = result.conversations[0];
		expect(c.id).toBe("conv-1");
		expect(c.created_at).toBe("2025-01-01T10:00:00Z");
		expect(c.updated_at).toBe("2025-01-01T11:00:00Z");
		expect(c.message_count).toBe(5);
		expect(c.input_tokens).toBe(1000);
		expect(c.output_tokens).toBe(200);
		expect(c.preview).toBe("Hello world");
		expect(c.tool_call_count).toBe(0);
		expect(c.had_errors).toBe(false);

		expect(result.totals.conversations).toBe(1);
		expect(result.totals.input_tokens).toBe(1000);
		expect(result.totals.output_tokens).toBe(200);
	});

	it("filters conversations outside date range", async () => {
		const store = makeMockStore([
			{
				id: "old",
				createdAt: "2024-12-01T00:00:00Z",
				updatedAt: "2024-12-01T01:00:00Z",
				title: "Old",
				messageCount: 1,
				preview: "old",
				totalInputTokens: 100,
				totalOutputTokens: 50,
				totalCostUsd: 0.001,
			},
			{
				id: "in-range",
				createdAt: "2025-01-01T10:00:00Z",
				updatedAt: "2025-01-01T12:00:00Z",
				title: "In range",
				messageCount: 3,
				preview: "in range",
				totalInputTokens: 500,
				totalOutputTokens: 100,
				totalCostUsd: 0.005,
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			store,
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.conversations).toHaveLength(1);
		expect(result.conversations[0].id).toBe("in-range");
	});

	it("aggregates tool usage from log files", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				sid: "conv-1",
				inputTokens: 1000,
				outputTokens: 200,
				toolCalls: 3,
				toolErrors: 0,
				toolStats: {
					"granola__list_notes": { count: 2, totalMs: 300 },
					"bash__run": { count: 1, totalMs: 150 },
				},
			},
			{
				ts: "2025-01-01T14:00:00Z",
				event: "run.done",
				sid: "conv-2",
				inputTokens: 2000,
				outputTokens: 400,
				toolCalls: 1,
				toolErrors: 0,
				toolStats: {
					"granola__list_notes": { count: 1, totalMs: 100 },
				},
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.tool_usage).toHaveLength(2);

		// Sorted by call_count descending
		const granola = result.tool_usage.find(
			(t) => t.tool === "granola__list_notes",
		);
		expect(granola).toBeDefined();
		expect(granola!.call_count).toBe(3);
		expect(granola!.server).toBe("granola");
		expect(granola!.avg_latency_ms).toBe(Math.round(400 / 3));

		const bash = result.tool_usage.find((t) => t.tool === "bash__run");
		expect(bash).toBeDefined();
		expect(bash!.call_count).toBe(1);
		expect(bash!.server).toBe("bash");

		expect(result.totals.tool_calls).toBe(4);
	});

	it("collects errors from log files", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				sid: "conv-1",
				inputTokens: 1000,
				outputTokens: 200,
				toolCalls: 2,
				toolErrors: 1,
			},
			{
				ts: "2025-01-01T12:00:00Z",
				event: "run.error",
				sid: "conv-2",
				error: "Model API timeout",
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.errors).toHaveLength(2);
		expect(result.errors[0].source).toBe("tool");
		expect(result.errors[0].message).toContain("1 tool error");
		expect(result.errors[1].source).toBe("engine");
		expect(result.errors[1].message).toBe("Model API timeout");
		expect(result.totals.errors).toBe(2);
	});

	it("filters bundle events from event buffer", async () => {
		const events: BufferedEvent[] = [
			{
				event: "bundle.installed",
				data: { name: "@nimblebraininc/echo" },
				timestamp: "2025-01-01T10:00:00Z",
			},
			{
				event: "heartbeat",
				data: { timestamp: "2025-01-01T10:01:00Z" },
				timestamp: "2025-01-01T10:01:00Z",
			},
			{
				event: "bundle.crashed",
				data: { name: "@nimblebraininc/postgres", reason: "OOM" },
				timestamp: "2025-01-01T10:05:00Z",
			},
			{
				event: "data.changed",
				data: { source: "tool" },
				timestamp: "2025-01-01T10:06:00Z",
			},
		];

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(events),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.bundle_events).toHaveLength(2);
		expect(result.bundle_events[0].bundle).toBe("@nimblebraininc/echo");
		expect(result.bundle_events[0].event).toBe("installed");
		expect(result.bundle_events[1].bundle).toBe("@nimblebraininc/postgres");
		expect(result.bundle_events[1].event).toBe("crashed");
		expect(result.bundle_events[1].detail).toBe("OOM");
	});

	it("filters by category = conversations", async () => {
		const store = makeMockStore([
			{
				id: "conv-1",
				createdAt: "2025-01-01T10:00:00Z",
				updatedAt: "2025-01-01T11:00:00Z",
				title: "Test",
				messageCount: 1,
				preview: "hi",
				totalInputTokens: 100,
				totalOutputTokens: 50,
				totalCostUsd: 0.001,
			},
		]);

		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				toolCalls: 1,
				toolStats: { "test__tool": { count: 1, totalMs: 100 } },
			},
		]);

		const events: BufferedEvent[] = [
			{
				event: "bundle.installed",
				data: { name: "test" },
				timestamp: "2025-01-01T10:00:00Z",
			},
		];

		const collector = new ActivityCollector(logDir, store, makeMockEventManager(events));

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
			category: "conversations",
		});

		expect(result.conversations).toHaveLength(1);
		expect(result.bundle_events).toEqual([]);
		expect(result.tool_usage).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("filters by category = tools", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				toolCalls: 1,
				toolErrors: 1,
				toolStats: { "test__tool": { count: 1, totalMs: 100 } },
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
			category: "tools",
		});

		expect(result.tool_usage).toHaveLength(1);
		expect(result.errors).toEqual([]); // errors filtered out by category
		expect(result.conversations).toEqual([]);
		expect(result.bundle_events).toEqual([]);
	});

	it("filters by category = errors", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.error",
				error: "boom",
			},
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				toolCalls: 1,
				toolStats: { "test__tool": { count: 1, totalMs: 100 } },
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
			category: "errors",
		});

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toBe("boom");
		expect(result.tool_usage).toEqual([]); // tools filtered out by category
		expect(result.conversations).toEqual([]);
		expect(result.bundle_events).toEqual([]);
	});

	// Regression: HTTP error middleware writes http.error records to workspace logs.
	// ActivityCollector must parse these so `home__activity` surfaces them.
	// The record format here must match what src/api/middleware/error-log.ts writes.
	it("collects http.error events from log files", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "http.error",
				status: 400,
				method: "POST",
				path: "/v1/tools/call",
				error: "invalid_input",
				message: "/description: must be string",
				userId: "usr_1",
				workspaceId: "ws_test",
			},
			{
				ts: "2025-01-01T11:00:00Z",
				event: "http.error",
				status: 401,
				method: "POST",
				path: "/v1/chat/stream",
				error: "unknown",
				message: "Unauthorized",
				userId: null,
				workspaceId: "ws_test",
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.errors).toHaveLength(2);
		expect(result.errors[0].source).toBe("http");
		expect(result.errors[0].message).toBe("400 invalid_input: /description: must be string");
		expect(result.errors[0].context).toBe("POST /v1/tools/call");
		expect(result.errors[0].timestamp).toBe("2025-01-01T10:00:00Z");
		expect(result.errors[1].source).toBe("http");
		expect(result.errors[1].message).toBe("401 unknown: Unauthorized");
		expect(result.errors[1].context).toBe("POST /v1/chat/stream");
		expect(result.totals.errors).toBe(2);
	});

	it("includes http.error when filtering by category = errors", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "http.error",
				status: 403,
				method: "POST",
				path: "/v1/tools/call",
				error: "forbidden",
				message: "Insufficient permissions",
			},
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				toolCalls: 1,
				toolStats: { "test__tool": { count: 1, totalMs: 100 } },
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
			category: "errors",
		});

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].source).toBe("http");
		expect(result.tool_usage).toEqual([]); // filtered out by category
	});

	it("mixes http.error with engine and tool errors", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T09:00:00Z",
				event: "run.done",
				toolCalls: 1,
				toolErrors: 1,
				sid: "conv-1",
			},
			{
				ts: "2025-01-01T10:00:00Z",
				event: "http.error",
				status: 400,
				method: "POST",
				path: "/v1/tools/call",
				error: "invalid_input",
				message: "bad args",
			},
			{
				ts: "2025-01-01T11:00:00Z",
				event: "run.error",
				error: "Model timeout",
				sid: "conv-2",
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.errors).toHaveLength(3);
		expect(result.errors[0].source).toBe("tool");
		expect(result.errors[1].source).toBe("http");
		expect(result.errors[2].source).toBe("engine");
		expect(result.totals.errors).toBe(3);
	});

	it("handles missing log directory gracefully", async () => {
		const collector = new ActivityCollector(
			"/tmp/nonexistent-log-dir-12345",
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		expect(result.tool_usage).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("skips malformed JSON lines in log files", async () => {
		const filename = `nimblebrain-2025-01-01.jsonl`;
		const content = [
			JSON.stringify({
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				toolCalls: 1,
				toolStats: { "test__tool": { count: 1, totalMs: 50 } },
			}),
			"not valid json {{{",
			"",
			JSON.stringify({
				ts: "2025-01-01T11:00:00Z",
				event: "run.done",
				toolCalls: 2,
				toolStats: { "test__tool": { count: 2, totalMs: 200 } },
			}),
		].join("\n");
		writeFileSync(join(logDir, filename), content);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		// Both valid lines should be parsed
		expect(result.tool_usage).toHaveLength(1);
		expect(result.tool_usage[0].call_count).toBe(3);
	});

	it("reads log files spanning multiple days", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T22:00:00Z",
				event: "run.done",
				toolStats: { "tool_a": { count: 1, totalMs: 100 } },
			},
		]);
		writeLogFile(logDir, "2025-01-02", [
			{
				ts: "2025-01-02T08:00:00Z",
				event: "run.done",
				toolStats: { "tool_a": { count: 2, totalMs: 200 } },
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-03T00:00:00Z",
		});

		expect(result.tool_usage).toHaveLength(1);
		expect(result.tool_usage[0].call_count).toBe(3);
	});

	it("defaults to 24-hour window when no since/until provided", async () => {
		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect();

		const sinceDt = new Date(result.period.since).getTime();
		const untilDt = new Date(result.period.until).getTime();
		const diffMs = untilDt - sinceDt;

		// Should be approximately 24 hours (allow 5s tolerance)
		expect(diffMs).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000);
		expect(diffMs).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
	});

	it("extracts server name from tool name with double underscore", async () => {
		writeLogFile(logDir, "2025-01-01", [
			{
				ts: "2025-01-01T10:00:00Z",
				event: "run.done",
				toolStats: {
					"granola__list_notes": { count: 1, totalMs: 100 },
					"system_tool": { count: 1, totalMs: 50 },
				},
			},
		]);

		const collector = new ActivityCollector(
			logDir,
			makeMockStore(),
			makeMockEventManager(),
		);

		const result = await collector.collect({
			since: "2025-01-01T00:00:00Z",
			until: "2025-01-02T00:00:00Z",
		});

		const granola = result.tool_usage.find(
			(t) => t.tool === "granola__list_notes",
		);
		expect(granola!.server).toBe("granola");

		const sys = result.tool_usage.find((t) => t.tool === "system_tool");
		expect(sys!.server).toBe("system");
	});
});
