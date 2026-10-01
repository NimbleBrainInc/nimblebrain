import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelemetryClient, TelemetryClientFactory } from "../../src/telemetry/manager.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import {
  engineEvent,
  llmDonePayload,
  runStartPayload,
  toolDonePayload,
} from "../helpers/engine-events.ts";

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
  delete process.env.NB_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;

  const mgr = TelemetryManager.create({
    workDir: makeTmpDir(),
    clientFactory: factory,
  });
  const sink = new PostHogEventSink(mgr);
  return { mock, sink };
}

/** A run's end, with the counters the sink does not read left neutral. */
function runDone(runId: string) {
  return engineEvent("run.done", { runId, stopReason: "complete", iterations: 1, totalMs: 0 });
}

/** One provider call's latency and token usage. */
function llmDone(runId: string, llmMs: number, input: number, output: number, cacheRead = 0) {
  return engineEvent(
    "llm.done",
    llmDonePayload({
      runId,
      llmMs,
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead },
    }),
  );
}

/** One tool call's latency. */
function toolDone(runId: string, ms: number) {
  return engineEvent("tool.done", toolDonePayload({ runId, name: "t1", ms }));
}

describe("PostHogEventSink", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.NB_TELEMETRY_DISABLED = process.env.NB_TELEMETRY_DISABLED;
    savedEnv.DO_NOT_TRACK = process.env.DO_NOT_TRACK;
    delete process.env.NB_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
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

  it("maps run.start to agent.chat_started with the tool count", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(
      engineEvent(
        "run.start",
        runStartPayload({ runId: "r1", toolNames: ["tool_a", "tool_b", "tool_c"] }),
      ),
    );

    expect(mock.events).toHaveLength(1);
    const captured = mock.events[0];
    expect(captured.event).toBe("agent.chat_started");
    expect(captured.properties.tool_count).toBe(3);
    expect("has_skill" in captured.properties).toBe(false);
    expect("is_resume" in captured.properties).toBe(false);
  });

  it("accumulates metrics and maps run.done to agent.chat_completed", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1", toolNames: ["tool_a"] })));
    sink.emit(llmDone("r1", 100, 500, 200, 50));
    sink.emit(toolDone("r1", 75));
    sink.emit(llmDone("r1", 80, 600, 150, 30));
    sink.emit(runDone("r1"));

    // run.start + run.done = 2 captures (llm.done and tool.done don't emit)
    expect(mock.events).toHaveLength(2);

    const done = mock.events.find((e) => e.event === "agent.chat_completed");
    expect(done).toBeDefined();
    expect(done!.properties.iterations).toBe(2);
    expect(done!.properties.tool_calls).toBe(1);
    expect(done!.properties.stop_reason).toBe("complete");
    expect(done!.properties.llm_latency_ms).toBe(180); // 100 + 80
    expect(done!.properties.tool_latency_ms).toBe(75);
    // Token totals come from the per-run accumulator, not from any
    // fields on the run.done event.
    expect(done!.properties.input_tokens).toBe(1100); // 500 + 600
    expect(done!.properties.output_tokens).toBe(350); // 200 + 150
    expect(done!.properties.cache_tokens).toBe(80); // 50 + 30
  });

  it("maps run.error to agent.error with the error's class name only", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(
      engineEvent("run.error", {
        runId: "r1",
        error: "sensitive message here",
        type: "CustomError",
      }),
    );

    const errorEvent = mock.events.find((e) => e.event === "agent.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.properties.error_type).toBe("CustomError");
    // Must NOT contain the error message (PII protection)
    expect(JSON.stringify(errorEvent!.properties)).not.toContain("sensitive message here");
    expect("error_code" in errorEvent!.properties).toBe(false);
  });

  it("does not report a connector's liveness as an agent error", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(
      engineEvent("connector.health", { source: "crm", event: "connector.crashed", remote: true }),
    );

    expect(mock.events).toHaveLength(0);
  });

  it("maps connector.installed as a remote install, carrying only UI presence", () => {
    const { mock, sink } = createTestSetup();

    const installed = {
      wsId: "ws_test",
      serverName: "remote-thing",
      connectorName: "https://example.com/mcp",
      version: "1.0.0",
      placements: null,
    };
    sink.emit(engineEvent("connector.installed", { ...installed, ui: null }));
    sink.emit(engineEvent("connector.installed", { ...installed, ui: { name: "UI", icon: "" } }));

    const installs = mock.events.filter((e) => e.event === "connector.installed");
    expect(installs).toHaveLength(2);
    expect(installs[0].properties.source).toBe("remote");
    expect(installs[0].properties.has_ui).toBe(false);
    expect(installs[1].properties.has_ui).toBe(true);
  });

  it("skips text.delta, tool.start, tool.progress, config.changed", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(engineEvent("text.delta", { runId: "r1", text: "hi" }));
    sink.emit(
      engineEvent("tool.start", {
        runId: "r1",
        name: "t",
        id: "c1",
        resourceUri: undefined,
        input: {},
      }),
    );
    sink.emit(engineEvent("tool.progress", { runId: "r1", id: "c1", message: "working" }));
    sink.emit(engineEvent("config.changed", { fields: ["preferences"] }));

    // tool.done and llm.done accumulate but don't emit telemetry events
    sink.emit(toolDone("r1", 10));
    sink.emit(llmDone("r1", 10, 100, 50));

    expect(mock.events).toHaveLength(0);
  });

  it("concurrent runs don't cross-contaminate", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(engineEvent("run.start", runStartPayload({ runId: "a", toolNames: ["t1"] })));
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "b", toolNames: ["t1"] })));

    // Interleave events
    sink.emit(llmDone("a", 100, 500, 100));
    sink.emit(toolDone("a", 50));
    sink.emit(llmDone("b", 200, 1000, 200));
    sink.emit(toolDone("b", 150));
    sink.emit(toolDone("b", 100));

    // Complete both
    sink.emit(runDone("a"));
    sink.emit(runDone("b"));

    const completions = mock.events.filter((e) => e.event === "agent.chat_completed");
    expect(completions).toHaveLength(2);

    // Find by order (a completes first)
    const doneA = completions[0];
    const doneB = completions[1];

    expect(doneA.properties.llm_latency_ms).toBe(100);
    expect(doneA.properties.tool_latency_ms).toBe(50);
    expect(doneA.properties.tool_calls).toBe(1);
    expect(doneA.properties.input_tokens).toBe(500);

    expect(doneB.properties.llm_latency_ms).toBe(200);
    expect(doneB.properties.tool_latency_ms).toBe(250); // 150 + 100
    expect(doneB.properties.tool_calls).toBe(2);
    expect(doneB.properties.input_tokens).toBe(1000);
  });

  it("cleans up on run.error", () => {
    const { mock, sink } = createTestSetup();

    sink.emit(engineEvent("run.start", runStartPayload({ runId: "err-run" })));
    sink.emit(llmDone("err-run", 50, 100, 50));
    sink.emit(engineEvent("run.error", { runId: "err-run", error: "boom", type: "Error" }));

    // Start a fresh run — metrics should be independent
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "fresh" })));
    sink.emit(llmDone("fresh", 10, 50, 25));
    sink.emit(runDone("fresh"));

    const freshDone = mock.events.find((e) => e.event === "agent.chat_completed");
    expect(freshDone).toBeDefined();
    expect(freshDone!.properties.llm_latency_ms).toBe(10);
    expect(freshDone!.properties.iterations).toBe(1);
  });
});
