import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import type { TelemetryClient, TelemetryClientFactory } from "../../src/telemetry/manager.ts";
import type { EngineEvent, EngineEventType } from "../../src/engine/types.ts";

class MockTelemetryClient implements TelemetryClient {
	events: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }> = [];
	shutdownCalled = false;
	capture(params: { distinctId: string; event: string; properties: Record<string, unknown> }) {
		this.events.push(params);
	}
	async shutdown() {
		this.shutdownCalled = true;
	}
}

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "posthog-sink-test-"));
}

function createTestSetup(): { mock: MockTelemetryClient; sink: PostHogEventSink } {
	const mock = new MockTelemetryClient();
	const factory: TelemetryClientFactory = (_apiKey, _options) => mock;

	// Clear env vars that would disable telemetry
	delete process.env["NB_TELEMETRY_DISABLED"];
	delete process.env["DO_NOT_TRACK"];

	const mgr = TelemetryManager.create({
		workDir: makeTmpDir(),
		clientFactory: factory,
	});
	const sink = new PostHogEventSink(mgr);
	return { mock, sink };
}

function emit(sink: PostHogEventSink, type: EngineEventType, data: Record<string, unknown>): void {
	sink.emit({ type, data });
}

describe("PostHogEventSink", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		savedEnv["NB_TELEMETRY_DISABLED"] = process.env["NB_TELEMETRY_DISABLED"];
		savedEnv["DO_NOT_TRACK"] = process.env["DO_NOT_TRACK"];
		delete process.env["NB_TELEMETRY_DISABLED"];
		delete process.env["DO_NOT_TRACK"];
	});

	afterEach(() => {
		for (const [key, val] of Object.entries(savedEnv)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
	});

	it("maps run.start to agent.chat_started", () => {
		const { mock, sink } = createTestSetup();

		emit(sink, "run.start", {
			runId: "r1",
			skill: "code-review",
			toolNames: ["tool_a", "tool_b", "tool_c"],
			isResume: false,
		});

		expect(mock.events).toHaveLength(1);
		const captured = mock.events[0];
		expect(captured.event).toBe("agent.chat_started");
		expect(captured.properties.has_skill).toBe(true);
		expect(captured.properties.tool_count).toBe(3);
		expect(captured.properties.is_resume).toBe(false);
	});

	it("accumulates metrics and maps run.done to agent.chat_completed", () => {
		const { mock, sink } = createTestSetup();

		emit(sink, "run.start", {
			runId: "r1",
			toolNames: ["tool_a"],
		});

		// iteration with LLM metrics
		emit(sink, "llm.done", {
			runId: "r1",
			llmMs: 100,
			inputTokens: 500,
			outputTokens: 200,
			cacheReadTokens: 50,
		});

		// tool call
		emit(sink, "tool.done", {
			runId: "r1",
			name: "tool_a",
			ms: 75,
			ok: true,
		});

		// second iteration
		emit(sink, "llm.done", {
			runId: "r1",
			llmMs: 80,
			inputTokens: 600,
			outputTokens: 150,
			cacheReadTokens: 30,
		});

		emit(sink, "run.done", {
			runId: "r1",
			stopReason: "complete",
			inputTokens: 1100,
			outputTokens: 350,
		});

		// run.start + run.done = 2 captures (llm.done and tool.done don't emit)
		expect(mock.events).toHaveLength(2);

		const done = mock.events.find((e) => e.event === "agent.chat_completed");
		expect(done).toBeDefined();
		expect(done!.properties.iterations).toBe(2);
		expect(done!.properties.tool_calls).toBe(1);
		expect(done!.properties.stop_reason).toBe("complete");
		expect(done!.properties.llm_latency_ms).toBe(180); // 100 + 80
		expect(done!.properties.tool_latency_ms).toBe(75);
	});

	it("maps run.error to agent.error with type only", () => {
		const { mock, sink } = createTestSetup();

		class CustomError extends Error {
			constructor(msg: string) {
				super(msg);
				this.name = "CustomError";
			}
		}

		emit(sink, "run.start", { runId: "r1" });
		emit(sink, "run.error", {
			runId: "r1",
			error: new CustomError("sensitive message here"),
		});

		const errorEvent = mock.events.find((e) => e.event === "agent.error");
		expect(errorEvent).toBeDefined();
		expect(errorEvent!.properties.error_type).toBe("CustomError");
		// Must NOT contain the error message (PII protection)
		expect(errorEvent!.properties.message).toBeUndefined();
	});

	it("maps bundle.installed with source detection", () => {
		const { mock, sink } = createTestSetup();

		// mpak source (starts with @)
		emit(sink, "bundle.installed", { name: "@org/my-bundle", trustScore: 80 });
		// local source (no url, no @)
		emit(sink, "bundle.installed", { name: "my-local-bundle", trustScore: 0 });
		// remote source (has url)
		emit(sink, "bundle.installed", { name: "remote-thing", url: "https://example.com/bundle.tar.gz", trustScore: 50 });

		const installs = mock.events.filter((e) => e.event === "bundle.installed");
		expect(installs).toHaveLength(3);
		expect(installs[0].properties.source).toBe("mpak");
		expect(installs[1].properties.source).toBe("local");
		expect(installs[2].properties.source).toBe("remote");
	});

	it("skips text.delta, tool.start, tool.done, tool.progress, data.changed", () => {
		const { mock, sink } = createTestSetup();

		const skipTypes: EngineEventType[] = [
			"text.delta",
			"tool.start",
			"tool.progress",
			"data.changed",
		];

		for (const type of skipTypes) {
			emit(sink, type, { runId: "r1" });
		}

		// tool.done and llm.done accumulate but don't emit telemetry events
		emit(sink, "tool.done", { runId: "r1", name: "t", ms: 10, ok: true });
		emit(sink, "llm.done", { runId: "r1", llmMs: 10, inputTokens: 100, outputTokens: 50 });

		expect(mock.events).toHaveLength(0);
	});

	it("concurrent runs don't cross-contaminate", () => {
		const { mock, sink } = createTestSetup();

		// Start two runs
		emit(sink, "run.start", { runId: "a", toolNames: ["t1"] });
		emit(sink, "run.start", { runId: "b", toolNames: ["t1"] });

		// Interleave events
		emit(sink, "llm.done", { runId: "a", llmMs: 100, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 });
		emit(sink, "tool.done", { runId: "a", name: "t1", ms: 50, ok: true });

		emit(sink, "llm.done", { runId: "b", llmMs: 200, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 });
		emit(sink, "tool.done", { runId: "b", name: "t1", ms: 150, ok: true });
		emit(sink, "tool.done", { runId: "b", name: "t1", ms: 100, ok: true });

		// Complete both
		emit(sink, "run.done", { runId: "a", stopReason: "complete", inputTokens: 500, outputTokens: 100 });
		emit(sink, "run.done", { runId: "b", stopReason: "complete", inputTokens: 1000, outputTokens: 200 });

		const completions = mock.events.filter((e) => e.event === "agent.chat_completed");
		expect(completions).toHaveLength(2);

		// Find by order (a completes first)
		const doneA = completions[0];
		const doneB = completions[1];

		expect(doneA.properties.llm_latency_ms).toBe(100);
		expect(doneA.properties.tool_latency_ms).toBe(50);
		expect(doneA.properties.tool_calls).toBe(1);

		expect(doneB.properties.llm_latency_ms).toBe(200);
		expect(doneB.properties.tool_latency_ms).toBe(250); // 150 + 100
		expect(doneB.properties.tool_calls).toBe(2);
	});

	it("cleans up on run.error", () => {
		const { mock, sink } = createTestSetup();

		emit(sink, "run.start", { runId: "err-run" });
		emit(sink, "llm.done", { runId: "err-run", llmMs: 50, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 });
		emit(sink, "run.error", { runId: "err-run", error: new Error("boom") });

		// Start a fresh run — metrics should be independent
		emit(sink, "run.start", { runId: "fresh" });
		emit(sink, "llm.done", { runId: "fresh", llmMs: 10, inputTokens: 50, outputTokens: 25, cacheReadTokens: 0 });
		emit(sink, "run.done", { runId: "fresh", stopReason: "complete", inputTokens: 50, outputTokens: 25 });

		const freshDone = mock.events.find((e) => e.event === "agent.chat_completed");
		expect(freshDone).toBeDefined();
		expect(freshDone!.properties.llm_latency_ms).toBe(10);
		expect(freshDone!.properties.iterations).toBe(1);
	});
});
