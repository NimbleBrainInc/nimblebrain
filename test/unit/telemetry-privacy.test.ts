import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TelemetryClient } from "../../src/telemetry/manager.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import type { EngineEvent, EngineEventType } from "../../src/engine/types.ts";

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

  capture(params: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }) {
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

function emit(sink: PostHogEventSink, type: EngineEventType, data: Record<string, unknown> = {}) {
  sink.emit({ type, data } as EngineEvent);
}

function lastCaptured(client: MockTelemetryClient) {
  return client.events[client.events.length - 1];
}

function propertyKeys(client: MockTelemetryClient, index = -1): Set<string> {
  const idx = index < 0 ? client.events.length + index : index;
  return new Set(Object.keys(client.events[idx]?.properties ?? {}));
}

// ---------------------------------------------------------------------------
// Saved env state
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  savedEnv = {
    NB_TELEMETRY_DISABLED: process.env["NB_TELEMETRY_DISABLED"],
    DO_NOT_TRACK: process.env["DO_NOT_TRACK"],
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
    delete process.env["NB_TELEMETRY_DISABLED"];
    delete process.env["DO_NOT_TRACK"];
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
    const allowlists: Record<string, { telemetryEvent: string; allowed: Set<string>; emitData: Record<string, unknown>; engineType: EngineEventType }> = {
      "agent.chat_started": {
        telemetryEvent: "agent.chat_started",
        allowed: new Set(["has_skill", "tool_count", "is_resume", ...COMMON_KEYS]),
        engineType: "run.start",
        emitData: {
          runId: "r1",
          skill: "my-skill",
          toolNames: ["bash", "read"],
          isResume: true,
          conversationId: "conv-123",
          userMessage: "secret user input",
          model: "claude-sonnet-4-5-20250929",
        },
      },
      "agent.chat_completed": {
        telemetryEvent: "agent.chat_completed",
        allowed: new Set([
          "iterations", "tool_calls", "stop_reason", "llm_latency_ms",
          "tool_latency_ms", "total_ms", "input_tokens", "output_tokens",
          ...COMMON_KEYS,
        ]),
        engineType: "run.done",
        emitData: {
          runId: "r1",
          stopReason: "complete",
          inputTokens: 1000,
          outputTokens: 500,
          output: "This is the full LLM response with PII",
          conversationId: "conv-123",
        },
      },
      "agent.error": {
        telemetryEvent: "agent.error",
        allowed: new Set(["error_type", "error_code", ...COMMON_KEYS]),
        engineType: "run.error",
        emitData: {
          runId: "r1",
          error: Object.assign(new TypeError("ENOENT: /Users/john/.config"), { code: "ENOENT" }),
          stack: "Error at /Users/john/project/index.ts:42",
          conversationId: "conv-123",
        },
      },
      "bundle.installed": {
        telemetryEvent: "bundle.installed",
        allowed: new Set(["source", "has_ui", "trust_score", ...COMMON_KEYS]),
        engineType: "bundle.installed",
        emitData: {
          name: "@nimblebraininc/tasks",
          bundleName: "@nimblebraininc/tasks",
          path: "/Users/john/bundles/tasks",
          ui: { name: "Tasks", icon: "tasks" },
          trustScore: 85,
          version: "1.2.3",
          manifest: { name: "tasks" },
        },
      },
      "bundle.crashed": {
        telemetryEvent: "bundle.crashed",
        allowed: new Set(["source", "uptime_ms", "restart_count", ...COMMON_KEYS]),
        engineType: "bundle.crashed",
        emitData: {
          name: "@nimblebraininc/tasks",
          path: "/Users/john/bundles/tasks",
          uptimeMs: 5000,
          restartCount: 2,
          error: "Segmentation fault",
          stderr: "Error: cannot read /Users/john/.config/secret",
        },
      },
      "bundle.dead": {
        telemetryEvent: "bundle.dead",
        allowed: new Set(["source", "restart_count", ...COMMON_KEYS]),
        engineType: "bundle.dead",
        emitData: {
          name: "@nimblebraininc/tasks",
          path: "/Users/john/bundles/tasks",
          restartCount: 5,
          error: "Max restarts exceeded",
        },
      },
      "bundle.uninstalled": {
        telemetryEvent: "bundle.uninstalled",
        allowed: new Set(["source", ...COMMON_KEYS]),
        engineType: "bundle.uninstalled",
        emitData: {
          name: "@nimblebraininc/tasks",
          path: "/Users/john/bundles/tasks",
          version: "1.2.3",
        },
      },
      "bundle.recovered": {
        telemetryEvent: "bundle.recovered",
        allowed: new Set(["source", "downtime_ms", ...COMMON_KEYS]),
        engineType: "bundle.recovered",
        emitData: {
          name: "@nimblebraininc/tasks",
          path: "/Users/john/bundles/tasks",
          downtimeMs: 1200,
        },
      },
    };

    for (const [label, spec] of Object.entries(allowlists)) {
      it(`${label}: only allowlisted keys appear`, () => {
        // For run.done, first emit run.start so metrics exist
        if (spec.engineType === "run.done") {
          emit(sink, "run.start", { runId: "r1", toolNames: ["bash"] });
        }

        emit(sink, spec.engineType, spec.emitData);

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
      // Emit all event types with PII-laden data
      emit(sink, "run.start", {
        runId: "r1",
        skill: "my-skill",
        toolNames: ["bash"],
        userMessage: "email me at john@example.com",
        path: "/Users/john/secret-project",
        apiKey: "sk-ant-abc123",
      });

      emit(sink, "llm.done", {
        runId: "r1",
        llmMs: 100,
        cacheReadTokens: 50,
        inputTokens: 200,
        outputTokens: 100,
      });

      emit(sink, "tool.done", {
        runId: "r1",
        name: "bash",
        ms: 50,
        output: "Bearer eyJhbGciOiJIUzI1NiJ9",
      });

      emit(sink, "run.done", {
        runId: "r1",
        stopReason: "complete",
        inputTokens: 200,
        outputTokens: 100,
        output: "Response with /Users/john path and john@example.com",
      });

      emit(sink, "run.error", {
        runId: "r2",
        error: Object.assign(new Error("ENOENT: /home/user/.ssh/id_rsa"), { code: "ENOENT" }),
      });

      emit(sink, "bundle.installed", {
        name: "@nimblebraininc/tasks",
        path: "/Users/john/bundles",
        trustScore: 80,
      });

      emit(sink, "bundle.crashed", {
        name: "@nimblebraininc/tasks",
        uptimeMs: 1000,
        restartCount: 1,
        stderr: "C:\\Users\\john\\AppData\\error.log",
      });

      emit(sink, "bundle.dead", {
        name: "@nimblebraininc/tasks",
        restartCount: 5,
      });

      emit(sink, "bundle.recovered", {
        name: "@nimblebraininc/tasks",
        downtimeMs: 500,
      });

      emit(sink, "bundle.uninstalled", {
        name: "@nimblebraininc/tasks",
        path: "/Users/john/bundles",
      });

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
  // 3. Bundle Name Exclusion
  // -----------------------------------------------------------------------

  describe("bundle name exclusion", () => {
    it("bundle.installed does not contain bundle name", () => {
      emit(sink, "bundle.installed", {
        name: "@nimblebraininc/tasks",
        bundleName: "@nimblebraininc/tasks",
        trustScore: 90,
      });

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        expect(String(value)).not.toContain("@nimblebraininc/tasks");
      }
    });

    it("bundle.installed does not contain bundle path", () => {
      emit(sink, "bundle.installed", {
        name: "@nimblebraininc/tasks",
        path: "/Users/john/secret-project/bundle",
        trustScore: 75,
      });

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        expect(String(value)).not.toContain("/Users/john/secret-project/bundle");
      }
    });

    it("bundle.crashed does not contain bundle name", () => {
      emit(sink, "bundle.crashed", {
        name: "@nimblebraininc/tasks",
        uptimeMs: 3000,
        restartCount: 1,
      });

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        expect(String(value)).not.toContain("@nimblebraininc/tasks");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Error Message Exclusion
  // -----------------------------------------------------------------------

  describe("error message exclusion", () => {
    it("run.error does not leak error message or paths", () => {
      emit(sink, "run.error", {
        runId: "r1",
        error: Object.assign(
          new Error("ENOENT: /Users/john/.nimblebrain/config"),
          { code: "ENOENT" },
        ),
      });

      const captured = lastCaptured(client);
      expect(captured).toBeDefined();

      for (const value of Object.values(captured.properties)) {
        const str = String(value);
        expect(str).not.toContain("ENOENT: /Users/john");
        expect(str).not.toContain("/Users/john");
      }
    });

    it("run.error does not leak stack traces", () => {
      const err = new Error("Connection refused");
      // Manually set a stack with file paths
      err.stack = `Error: Connection refused
    at connect (/Users/john/project/src/db.ts:42:5)
    at main (/home/user/app/index.ts:10:3)`;

      emit(sink, "run.error", {
        runId: "r2",
        error: err,
      });

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
        process.env["NB_TELEMETRY_DISABLED"] = "1";

        const optOutClient = new MockTelemetryClient();
        const optOutManager = TelemetryManager.create({
          workDir: optOutDir,
          clientFactory: () => optOutClient,
        });
        const optOutSink = new PostHogEventSink(optOutManager);

        // Emit every event type
        const allEvents: Array<{ type: EngineEventType; data: Record<string, unknown> }> = [
          { type: "run.start", data: { runId: "r1", toolNames: ["bash"] } },
          { type: "run.done", data: { runId: "r1", stopReason: "complete", inputTokens: 100, outputTokens: 50 } },
          { type: "run.error", data: { runId: "r2", error: new Error("fail") } },
          { type: "bundle.installed", data: { name: "test", trustScore: 50 } },
          { type: "bundle.crashed", data: { name: "test", uptimeMs: 100, restartCount: 1 } },
          { type: "bundle.dead", data: { name: "test", restartCount: 3 } },
          { type: "bundle.recovered", data: { name: "test", downtimeMs: 200 } },
          { type: "bundle.uninstalled", data: { name: "test" } },
        ];

        for (const evt of allEvents) {
          optOutSink.emit(evt as EngineEvent);
        }

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
