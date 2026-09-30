import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../src/engine/types.ts";
import type { TelemetryClient } from "../../src/telemetry/manager.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import {
  engineEvent,
  llmDonePayload,
  runStartPayload,
  toolDonePayload,
} from "../helpers/engine-events.ts";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

class MockTelemetryClient implements TelemetryClient {
  events: Array<{
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }> = [];
  shutdownCalled = false;

  capture(params: { distinctId: string; event: string; properties: Record<string, unknown> }) {
    this.events.push(params);
  }

  async shutdown() {
    this.shutdownCalled = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMON_KEYS = new Set(["nb_version", "os", "arch", "bun_version"]);

function createMockSetup(): {
  client: MockTelemetryClient;
  sink: PostHogEventSink;
  tmpDir: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "nb-telemetry-test-"));
  const client = new MockTelemetryClient();
  const manager = TelemetryManager.create({
    workDir: tmpDir,
    clientFactory: () => client,
  });
  const sink = new PostHogEventSink(manager);
  return { client, sink, tmpDir };
}

/**
 * Fields an engine payload does not declare, carrying the kind of data the sink
 * must never copy through. A payload built in a variable and then spread can
 * carry extra fields at runtime; the sink has to ignore them.
 */
const LEAKY = {
  conversationId: "conv-123",
  userMessage: "email me at john@example.com",
  path: "/Users/john/secret-project",
  apiKey: "sk-ant-abc123",
  stack: "Error at /Users/john/project/index.ts:42",
};

/** An event whose payload also carries `LEAKY`'s undeclared fields. */
function leaky(event: EngineEvent): EngineEvent {
  const data = { ...event.data, ...LEAKY };
  return { ...event, data } as EngineEvent;
}

const runStart = (runId: string) =>
  engineEvent("run.start", runStartPayload({ runId, toolNames: ["bash", "read"] }));
const runDone = (runId: string) =>
  engineEvent("run.done", { runId, stopReason: "complete", iterations: 1, totalMs: 10 });
const runError = (runId: string, error: string) =>
  engineEvent("run.error", { runId, error, type: "TypeError" });
const connectorFields = {
  wsId: "ws_test",
  serverName: "tasks",
  connectorName: "@nimblebraininc/tasks",
};
const connectorInstalled = engineEvent("connector.installed", {
  ...connectorFields,
  version: "1.2.3",
  ui: { name: "Tasks", icon: "tasks" },
  placements: null,
});
const connectorUninstalled = engineEvent("connector.uninstalled", connectorFields);

function lastCaptured(client: MockTelemetryClient) {
  return client.events[client.events.length - 1];
}

// ---------------------------------------------------------------------------
// Saved env state
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  savedEnv = {
    NB_TELEMETRY_DISABLED: process.env.NB_TELEMETRY_DISABLED,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  };
}

function restoreEnv() {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Telemetry Privacy", () => {
  let client: MockTelemetryClient;
  let sink: PostHogEventSink;
  let tmpDir: string;

  beforeEach(() => {
    saveEnv();
    delete process.env.NB_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    const setup = createMockSetup();
    client = setup.client;
    sink = setup.sink;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    restoreEnv();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // -----------------------------------------------------------------------
  // 1. Property Allowlist Tests
  // -----------------------------------------------------------------------

  describe("property allowlist", () => {
    const allowlists: Record<
      string,
      { telemetryEvent: string; allowed: Set<string>; events: EngineEvent[] }
    > = {
      "agent.chat_started": {
        telemetryEvent: "agent.chat_started",
        allowed: new Set(["tool_count", ...COMMON_KEYS]),
        events: [leaky(runStart("r1"))],
      },
      "agent.chat_completed": {
        telemetryEvent: "agent.chat_completed",
        allowed: new Set([
          "iterations",
          "tool_calls",
          "stop_reason",
          "llm_latency_ms",
          "tool_latency_ms",
          "total_ms",
          "input_tokens",
          "output_tokens",
          "cache_tokens",
          ...COMMON_KEYS,
        ]),
        // run.start first, so the run's metrics exist.
        events: [runStart("r1"), leaky(runDone("r1"))],
      },
      "agent.error": {
        telemetryEvent: "agent.error",
        allowed: new Set(["error_type", ...COMMON_KEYS]),
        events: [leaky(runError("r1", "ENOENT: /Users/john/.config"))],
      },
      "connector.installed": {
        telemetryEvent: "connector.installed",
        allowed: new Set(["source", "has_ui", ...COMMON_KEYS]),
        events: [leaky(connectorInstalled)],
      },
      "connector.uninstalled": {
        telemetryEvent: "connector.uninstalled",
        allowed: new Set(["source", ...COMMON_KEYS]),
        events: [leaky(connectorUninstalled)],
      },
    };

    for (const [label, spec] of Object.entries(allowlists)) {
      it(`${label}: only allowlisted keys appear`, () => {
        for (const event of spec.events) sink.emit(event);

        const captured = client.events.find((e) => e.event === spec.telemetryEvent);
        expect(captured).toBeDefined();

        const keys = new Set(Object.keys(captured!.properties));
        for (const key of keys) {
          expect(spec.allowed.has(key)).toBe(true);
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // 2. PII Pattern Scanning
  // -----------------------------------------------------------------------

  describe("PII pattern scanning", () => {
    it("no captured event contains PII patterns", () => {
      // Emit every captured event type, with PII in the declared string
      // fields and in undeclared extras.
      sink.emit(leaky(runStart("r1")));
      sink.emit(
        leaky(
          engineEvent(
            "llm.done",
            llmDonePayload({
              runId: "r1",
              llmMs: 100,
              usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 50 },
            }),
          ),
        ),
      );
      sink.emit(
        leaky(
          engineEvent(
            "tool.done",
            toolDonePayload({
              runId: "r1",
              name: "bash",
              ms: 50,
              output: "Bearer eyJhbGciOiJIUzI1NiJ9",
            }),
          ),
        ),
      );
      sink.emit(leaky(runDone("r1")));
      sink.emit(leaky(runError("r2", "ENOENT: /home/user/.ssh/id_rsa")));
      sink.emit(leaky(connectorInstalled));
      sink.emit(leaky(connectorUninstalled));

      expect(client.events.length).toBeGreaterThan(0);

      for (const captured of client.events) {
        for (const [key, value] of Object.entries(captured.properties)) {
          const str = String(value);

          // No file paths
          expect(str).not.toContain("/Users/");
          expect(str).not.toContain("/home/");
          expect(str).not.toContain("C:\\Users\\");

          // No email-like patterns (allow common props like os, arch, etc.)
          if (!COMMON_KEYS.has(key)) {
            expect(str).not.toMatch(/@.*\./);
          }

          // No API keys
          expect(str).not.toContain("sk-ant-");
          expect(str).not.toContain("Bearer ");

          // No long strings (potential PII dump)
          if (typeof value === "string") {
            expect(value.length).toBeLessThanOrEqual(200);
          }
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // 3. Connector Name Exclusion
  // -----------------------------------------------------------------------

  describe("connector name exclusion", () => {
    it("connector.installed does not contain connector name", () => {
      sink.emit(connectorInstalled);

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        expect(String(value)).not.toContain("@nimblebraininc/tasks");
      }
    });

    it("connector.installed does not contain connector path", () => {
      sink.emit(
        engineEvent("connector.installed", {
          ...connectorFields,
          connectorName: "/Users/john/secret-project/connector",
          version: "1.2.3",
          ui: null,
          placements: null,
        }),
      );

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        expect(String(value)).not.toContain("/Users/john/secret-project/connector");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Error Message Exclusion
  // -----------------------------------------------------------------------

  describe("error message exclusion", () => {
    it("run.error does not leak error message or paths", () => {
      sink.emit(runError("r1", "ENOENT: /Users/john/.nimblebrain/config"));

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        const str = String(value);
        expect(str).not.toContain("ENOENT: /Users/john");
        expect(str).not.toContain("/Users/john");
      }
    });

    it("run.error does not leak stack traces", () => {
      // A message carrying a stack with file paths.
      sink.emit(
        runError(
          "r2",
          `Error: Connection refused
    at connect (/Users/john/project/src/db.ts:42:5)
    at main (/home/user/app/index.ts:10:3)`,
        ),
      );

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        const str = String(value);
        expect(str).not.toContain("/Users/john");
        expect(str).not.toContain("/home/user");
        expect(str).not.toContain("Connection refused");
        expect(str).not.toContain(".ts:");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 5. Full Opt-Out Verification
  // -----------------------------------------------------------------------

  describe("full opt-out", () => {
    it("NB_TELEMETRY_DISABLED=1 prevents all captures and telemetry-id creation", () => {
      const optOutDir = mkdtempSync(join(tmpdir(), "nb-telemetry-optout-"));

      try {
        process.env.NB_TELEMETRY_DISABLED = "1";

        const optOutClient = new MockTelemetryClient();
        const optOutManager = TelemetryManager.create({
          workDir: optOutDir,
          clientFactory: () => optOutClient,
        });
        const optOutSink = new PostHogEventSink(optOutManager);

        // Emit every event type
        const allEvents: EngineEvent[] = [
          runStart("r1"),
          runDone("r1"),
          runError("r2", "fail"),
          connectorInstalled,
          connectorUninstalled,
        ];

        for (const evt of allEvents) optOutSink.emit(evt);

        // Zero captures
        expect(optOutClient.events).toHaveLength(0);

        // No telemetry-id file created
        expect(existsSync(join(optOutDir, ".telemetry-id"))).toBe(false);
      } finally {
        rmSync(optOutDir, { recursive: true, force: true });
      }
    });
  });
});
