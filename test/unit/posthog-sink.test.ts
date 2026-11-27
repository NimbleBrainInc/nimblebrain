import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsLoadedPayload } from "../../src/runtime/skills-loaded-payload.ts";
import { synthesizeConnectorSkill } from "../../src/skills/connector-skills.ts";
import type {
  TelemetryClient,
  TelemetryClientFactory,
  TelemetrySubject,
} from "../../src/telemetry/manager.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import { costBreakdown } from "../../src/usage/cost.ts";
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
  delete process.env.DO_NOT_TRACK;

  const mgr = TelemetryManager.create({
    workDir: makeTmpDir(),
    clientFactory: factory,
  });
  mgr.setConsent("on");
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

/** A model the catalog prices, and one it does not. */
const PRICED = "anthropic:claude-sonnet-4-6";
const UNPRICED = "acme:unlisted-model";

/** One model call at a named model, with cache reads and writes. */
function llmDoneAt(runId: string, model: string, input: number, output: number) {
  return engineEvent(
    "llm.done",
    llmDonePayload({
      runId,
      model,
      llmMs: 5,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: input / 2,
        cacheWriteTokens: input / 4,
      },
    }),
  );
}

/** One tool call's latency. */
function toolDone(runId: string, ms: number) {
  return engineEvent("tool.done", toolDonePayload({ runId, name: "t1", ms }));
}

/** One finished call to a named tool. */
function toolDoneNamed(runId: string, name: string, ok = true) {
  return engineEvent("tool.done", toolDonePayload({ runId, name, ms: 1, ok }));
}

describe("PostHogEventSink", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.DO_NOT_TRACK = process.env.DO_NOT_TRACK;
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
      wsId: "ws_0076759dbbe19fcc",
      serverName: "remote-thing",
      connectorName: "https://example.com/mcp",
      version: "1.0.0",
      placements: null,
    };
    sink.emit(engineEvent("connector.installed", { ...installed, ui: null }));
    sink.emit(engineEvent("connector.installed", { ...installed, ui: { placements: [] } }));

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

  it("leaves llm_latency_ms out of a run whose model calls were untimed", () => {
    const { mock, sink } = createTestSetup();

    // An external agent's calls carry tokens but `llmMs` 0: unknown, not instant.
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "acp" })));
    sink.emit(llmDone("acp", 0, 500, 200));
    sink.emit(llmDone("acp", 0, 600, 150));
    sink.emit(runDone("acp"));

    const done = mock.events.find((e) => e.event === "agent.chat_completed");
    expect(done).toBeDefined();
    expect("llm_latency_ms" in done!.properties).toBe(false);
    expect(done!.properties.iterations).toBe(2);
    expect(done!.properties.input_tokens).toBe(1100);
    expect(done!.properties.output_tokens).toBe(350);
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

  it("does not count a held call, which ran nothing, as a call or a failure", async () => {
    const { mock, sink } = createTestSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(
      engineEvent(
        "tool.done",
        toolDonePayload({ runId: "r1", name: "linear__list_issues", ms: 0, ok: false, held: true }),
      ),
    );
    sink.emit(toolDoneNamed("r1", "linear__list_issues"));
    sink.emit(runDone("r1"));
    const done = mock.events.find((e) => e.event === "agent.chat_completed");
    expect(done?.properties.tool_calls).toBe(1);
    expect(done?.properties.connector_tool_calls).toBe(1);
  });

  it("counts calls to connector tools apart from the kernel's own", () => {
    const { mock, sink } = createTestSetup();
    sink.addBuiltinSources(["tasks", "usage"]);
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    for (const name of [
      "nb__search",
      "files__read",
      "usage__report",
      "linear__list_issues",
      "my_gmail__send",
    ]) {
      sink.emit(toolDoneNamed("r1", name));
    }
    sink.emit(runDone("r1"));
    const done = mock.events.find((e) => e.event === "agent.chat_completed");
    expect(done?.properties.tool_calls).toBe(5);
    expect(done?.properties.connector_tool_calls).toBe(2);
  });

  it("sends no cost when the deployment does not identify", () => {
    const { mock, sink } = createTestSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1", model: PRICED })));
    sink.emit(llmDoneAt("r1", PRICED, 1000, 100));
    sink.emit(runDone("r1"));

    const done = mock.events.find((e) => e.event === "agent.chat_completed");
    expect(done && "cost_usd" in done.properties).toBe(false);
  });

  it("reports an automation the agent created, by event alone", () => {
    const { mock, sink } = createTestSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(toolDoneNamed("r1", "tasks__create"));
    sink.emit(toolDoneNamed("r1", "tasks__create", false));
    const created = mock.events.filter((e) => e.event === "task.created");
    expect(created).toHaveLength(1);
    expect(Object.keys(created[0]?.properties ?? {})).not.toContain("name");
  });
});

describe("PostHogEventSink on an identified deployment", () => {
  /** A sink whose manager the operator set to identify, with a catalog of one connector. */
  function identifiedSetup(subject: TelemetrySubject = { userId: "usr_1", workspaceId: "ws_1" }): {
    mock: MockTelemetryClient;
    sink: PostHogEventSink;
  } {
    const mock = new MockTelemetryClient();
    const mgr = TelemetryManager.create({
      workDir: makeTmpDir(),
      enabled: true,
      identify: true,
      clientFactory: () => mock,
      env: {},
    });
    mgr.setSubjectSource(() => subject);
    const sink = new PostHogEventSink(mgr);
    sink.addBuiltinSources(["tasks", "crm"]);
    // `linear` is the workspace's from the catalog; `gmail` is the person's own
    // plugin from the catalog; anything else was added by URL.
    sink.setConnectorResolver(async (owner, serverName) => {
      if ("workspaceId" in owner) return serverName === "linear" ? "app.linear/linear" : undefined;
      return owner.userId === "usr_1" && serverName === "gmail" ? "com.google/gmail" : undefined;
    });
    return { mock, sink };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** An event's own properties, without those every event carries. */
  // What the event says about the call itself: the common properties and the run id
  // (tested on its own below) are left out.
  const own = ({ nb_version, os, arch, bun_version, run_id, ...rest }: Record<string, unknown>) =>
    rest;
  const toolDoneIn = (name: string, ok = true) =>
    engineEvent(
      "tool.done",
      toolDonePayload({ runId: "r1", name, ms: 3, ok, workspaceId: "ws_1" }),
    );

  it("sends no anonymous task.created: automation.created reports every create there", () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(toolDoneIn("tasks__create"));
    expect(mock.events.some((e) => e.event === "task.created")).toBe(false);
  });

  it("names each tool call by its kernel, app or catalog name, and never a custom connector's", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(toolDoneIn("nb__search"));
    sink.emit(toolDoneIn("crm__list_contacts"));
    sink.emit(toolDoneIn("linear__list_issues", false));
    sink.emit(toolDoneIn("acme-internal__export_payroll"));
    await settle();

    const calls = mock.events
      .filter((e) => e.event === "tool.called")
      .map((e) => own(e.properties));
    expect(calls).toContainEqual({
      ok: true,
      duration_ms: 3,
      source: "kernel",
      app: "nb",
      tool: "search",
    });
    expect(calls).toContainEqual({
      ok: true,
      duration_ms: 3,
      source: "app",
      app: "crm",
      tool: "list_contacts",
    });
    expect(calls).toContainEqual({
      ok: false,
      duration_ms: 3,
      source: "connector",
      connector: "app.linear/linear",
      tool: "list_issues",
    });
    expect(calls).toContainEqual({
      ok: true,
      duration_ms: 3,
      source: "connector",
      connector: "custom",
      tool: "custom",
    });
    expect(JSON.stringify(mock.events)).not.toContain("acme-internal");
    expect(JSON.stringify(mock.events)).not.toContain("export_payroll");
  });

  it("names a catalog connector when the tool event lacks its workspace stamp (an agent runtime's run)", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(
      engineEvent(
        "tool.done",
        toolDonePayload({ runId: "r1", name: "linear__list_issues", ms: 3 }),
      ),
    );
    await settle();

    const calls = mock.events
      .filter((e) => e.event === "tool.called")
      .map((e) => own(e.properties));
    expect(calls).toContainEqual({
      ok: true,
      duration_ms: 3,
      source: "connector",
      connector: "app.linear/linear",
      tool: "list_issues",
    });
  });

  it("says what woke the run, as the run-start door recorded it", async () => {
    for (const trigger of ["chat", "schedule"]) {
      const { mock, sink } = identifiedSetup({ userId: "usr_1", workspaceId: "ws_1", trigger });
      sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
      sink.emit(runDone("r1"));
      await settle();
      expect(mock.events.find((e) => e.event === "agent.chat_started")?.properties.trigger).toBe(
        trigger,
      );
      expect(mock.events.find((e) => e.event === "agent.chat_completed")?.properties.trigger).toBe(
        trigger,
      );
    }
  });

  it("stamps the run id on a run's events, so they join", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(toolDoneIn("linear__list_issues"));
    sink.emit(runDone("r1"));
    await settle();
    const ids = mock.events
      .filter((e) =>
        ["agent.chat_started", "tool.called", "agent.chat_completed"].includes(e.event),
      )
      .map((e) => [e.event, e.properties.run_id]);
    expect(ids).toEqual([
      ["agent.chat_started", "r1"],
      ["tool.called", "r1"],
      ["agent.chat_completed", "r1"],
    ]);
  });

  it("sends no tool.called for a held call, only for the call that ran", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(
      engineEvent(
        "tool.done",
        toolDonePayload({
          runId: "r1",
          name: "linear__list_issues",
          ms: 0,
          ok: false,
          held: true,
          workspaceId: "ws_1",
        }),
      ),
    );
    sink.emit(toolDoneIn("linear__list_issues"));
    await settle();

    const calls = mock.events
      .filter((e) => e.event === "tool.called")
      .map((e) => own(e.properties));
    expect(calls).toEqual([
      {
        ok: true,
        duration_ms: 3,
        source: "connector",
        connector: "app.linear/linear",
        tool: "list_issues",
      },
    ]);
  });

  it("names a person's own plugin by its catalog id, read from their records", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    sink.emit(toolDoneIn("my_gmail__send"));
    sink.emit(toolDoneIn("my_private-thing__go"));
    await settle();

    const calls = mock.events
      .filter((e) => e.event === "tool.called")
      .map((e) => own(e.properties));
    expect(calls).toContainEqual({
      ok: true,
      duration_ms: 3,
      source: "connector",
      connector: "com.google/gmail",
      tool: "send",
    });
    expect(calls).toContainEqual({
      ok: true,
      duration_ms: 3,
      source: "connector",
      connector: "custom",
      tool: "custom",
    });
    expect(JSON.stringify(mock.events)).not.toContain("private-thing");
  });

  it("adds the model, the connectors used and the skills used to a finished chat", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(
      engineEvent("run.start", runStartPayload({ runId: "r1", model: "anthropic:claude-x" })),
    );
    sink.emit(
      engineEvent("skills.loaded", {
        runId: "r1",
        totalTokens: 0,
        skills: [
          {
            id: "a",
            name: "triage",
            connector: "linear",
            scope: "provided",
            layer: 3,
            version: "1",
            tokens: 0,
            contentHash: "h",
            loadedBy: "tool_affinity",
            reason: "",
          },
          {
            id: "b",
            name: "Our secret playbook",
            scope: "workspace",
            layer: 4,
            version: "1",
            tokens: 0,
            contentHash: "h",
            loadedBy: "trigger",
            reason: "",
          },
        ],
      }),
    );
    sink.emit(toolDoneIn("linear__list_issues"));
    sink.emit(toolDoneIn("acme-internal__export_payroll"));
    sink.emit(runDone("r1"));
    await settle();

    const done = mock.events.find((e) => e.event === "agent.chat_completed")?.properties;
    expect(done?.model).toBe("anthropic:claude-x");
    expect(done?.connectors_used).toEqual(["app.linear/linear", "custom"]);
    expect(done?.skills_used).toEqual(["app.linear/linear:triage", "custom"]);
    expect(JSON.stringify(mock.events)).not.toContain("secret playbook");
  });

  it("reports a run's cost, each model call priced on its own card", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1", model: PRICED })));
    sink.emit(llmDoneAt("r1", PRICED, 4000, 200));
    sink.emit(llmDoneAt("r1", PRICED, 8000, 300));
    // A replayed segment is not a model call: neither counted nor priced.
    sink.emit(
      engineEvent(
        "llm.done",
        llmDonePayload({
          runId: "r1",
          model: PRICED,
          transcriptOnly: true,
          usage: { inputTokens: 99_999, outputTokens: 9_999 },
        }),
      ),
    );
    sink.emit(runDone("r1"));
    await settle();

    const expected =
      costBreakdown(PRICED, {
        inputTokens: 4000,
        outputTokens: 200,
        cacheReadTokens: 2000,
        cacheWriteTokens: 1000,
      }).total +
      costBreakdown(PRICED, {
        inputTokens: 8000,
        outputTokens: 300,
        cacheReadTokens: 4000,
        cacheWriteTokens: 2000,
      }).total;
    const done = mock.events.find((e) => e.event === "agent.chat_completed")?.properties;
    expect(expected).toBeGreaterThan(0);
    expect(done?.cost_usd).toBeCloseTo(expected, 12);
  });

  it("reports no cost for a run with a call no rates are known for, never 0 or a partial sum", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1", model: PRICED })));
    sink.emit(llmDoneAt("r1", PRICED, 4000, 200));
    sink.emit(llmDoneAt("r1", UNPRICED, 4000, 200));
    sink.emit(runDone("r1"));
    await settle();

    const done = mock.events.find((e) => e.event === "agent.chat_completed")?.properties;
    expect(done && "cost_usd" in done).toBe(false);
    // The run's tokens are still reported.
    expect(done?.input_tokens).toBe(8000);
  });

  it("reports a cost of 0 for a run that made no model call", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1", model: PRICED })));
    sink.emit(runDone("r1"));
    await settle();

    const done = mock.events.find((e) => e.event === "agent.chat_completed")?.properties;
    expect(done?.cost_usd).toBe(0);
  });

  it("names a custom connector's skill as custom, never its install or skill name", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(engineEvent("run.start", runStartPayload({ runId: "r1" })));
    const published = (serverName: string, skillName: string) =>
      synthesizeConnectorSkill({
        serverName,
        skillName,
        description: "",
        uri: `skill://${serverName}/${skillName}/SKILL.md`,
      });
    const payload = buildSkillsLoadedPayload([
      {
        skill: published("private-acme-payroll", "confidential-restructuring"),
        loadedBy: "always",
        reason: "",
      },
      { skill: published("linear", "triage"), loadedBy: "always", reason: "" },
    ]);
    sink.emit(engineEvent("skills.loaded", { ...payload, runId: "r1" }));
    sink.emit(runDone("r1"));
    await settle();

    const done = mock.events.find((e) => e.event === "agent.chat_completed")?.properties;
    expect(done?.skills_used).toEqual(["app.linear/linear:triage", "custom"]);
    const sent = JSON.stringify(mock.events);
    expect(sent).not.toContain("acme-payroll");
    expect(sent).not.toContain("restructuring");
  });

  it("names a catalog connector on install, and a skill someone wrote by its scope only", async () => {
    const { mock, sink } = identifiedSetup();
    sink.emit(
      engineEvent("connector.installed", {
        wsId: "ws_1",
        serverName: "linear",
        connectorName: "linear",
        version: "1",
        ui: null,
        placements: null,
      }),
    );
    sink.emit(
      engineEvent("skill.created", { id: "/x", name: "Q3 pricing secrets", scope: "workspace" }),
    );
    await settle();

    expect(
      own(mock.events.find((e) => e.event === "connector.installed")?.properties ?? {}),
    ).toEqual({
      source: "remote",
      has_ui: false,
      connector: "app.linear/linear",
    });
    expect(mock.events.find((e) => e.event === "skill.created")?.properties).toMatchObject({
      scope: "workspace",
    });
    expect(JSON.stringify(mock.events)).not.toContain("pricing secrets");
  });

  it("sends no names at all when the deployment does not identify", async () => {
    const { mock, sink } = createTestSetup();
    sink.setConnectorResolver(async () => "app.linear/linear");
    sink.emit(
      engineEvent("run.start", runStartPayload({ runId: "r1", model: "anthropic:claude-x" })),
    );
    sink.emit(toolDoneIn("linear__list_issues"));
    sink.emit(engineEvent("skill.created", { id: "/x", name: "n", scope: "workspace" }));
    sink.emit(runDone("r1"));
    await settle();

    expect(mock.events.map((e) => e.event)).toEqual(["agent.chat_started", "agent.chat_completed"]);
    expect(JSON.stringify(mock.events)).not.toContain("linear");
    expect(JSON.stringify(mock.events)).not.toContain("claude-x");
  });
});
