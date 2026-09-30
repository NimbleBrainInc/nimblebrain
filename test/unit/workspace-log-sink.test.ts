import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLogSink } from "../../src/adapters/workspace-log-sink.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { log } from "../../src/observability/log.ts";
import { engineEvent, llmDonePayload, runStartPayload } from "../helpers/engine-events.ts";

const connectorFields = {
  wsId: "ws_test",
  serverName: "foo",
  connectorName: "@test/foo",
};
const installed = engineEvent("connector.installed", {
  ...connectorFields,
  version: "1.0.0",
  ui: null,
  placements: null,
});
const uninstalled = engineEvent("connector.uninstalled", connectorFields);
const configChanged = engineEvent("config.changed", { fields: ["model"] });
const skill = { id: "/skills/greet.md", name: "greet", scope: "workspace" } as const;

/** One complete event of every type the workspace log records. */
const WORKSPACE_EVENTS: EngineEvent[] = [
  installed,
  uninstalled,
  configChanged,
  engineEvent("skill.created", skill),
  engineEvent("skill.updated", skill),
  engineEvent("skill.deleted", skill),
  engineEvent("bridge.tool.done", {
    name: "t",
    id: "c1",
    ok: true,
    ms: 1,
    userId: null,
    workspaceId: "ws_test",
  }),
  engineEvent("http.error", {
    ts: "2026-01-01T00:00:00.000Z",
    event: "http.error",
    status: 500,
    method: "GET",
    path: "/v1/x",
    error: "internal_error",
    message: "boom",
    userId: null,
    workspaceId: null,
  }),
  engineEvent("audit.auth_failure", { ip: "127.0.0.1", method: "GET", path: "/v1/x" }),
  engineEvent("audit.permission_denied", {
    tool: "skills__create",
    action: "create",
    target: null,
  }),
  engineEvent("audit.credential_read", {
    scope: "workspace",
    key: "k",
    caller: "c",
    purpose: "p",
    workspaceId: "ws_test",
  }),
];

describe("WorkspaceLogSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-log-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes connector.installed event to workspace log", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit(installed);

    const files = readdirSync(join(dir, "workspace"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = readFileSync(join(dir, "workspace", files[0]), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("connector.installed");
    expect(record.connectorName).toBe("@test/foo");
    expect(record.ts).toBeDefined();
  });

  it("silently ignores non-workspace events", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit(engineEvent("run.start", runStartPayload()));
    sink.emit(engineEvent("llm.done", llmDonePayload()));
    sink.emit(engineEvent("text.delta", { runId: "run_1", text: "hi" }));
    sink.emit(
      engineEvent("tool.start", {
        runId: "run_1",
        name: "foo",
        id: "c1",
        resourceUri: undefined,
        input: {},
      }),
    );
    sink.emit(
      engineEvent("run.done", {
        runId: "run_1",
        stopReason: "complete",
        iterations: 1,
        totalMs: 0,
      }),
    );
    sink.emit(engineEvent("run.error", { runId: "run_1", error: "boom", type: "Error" }));

    const files = readdirSync(join(dir, "workspace"));
    expect(files).toHaveLength(0);
  });

  it("writes multiple events on the same day to the same file", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit(installed);
    sink.emit(uninstalled);
    sink.emit(configChanged);
    sink.emit(engineEvent("skill.created", skill));

    const files = readdirSync(join(dir, "workspace"));
    expect(files).toHaveLength(1);

    const lines = readFileSync(join(dir, "workspace", files[0]), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(4);

    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual([
      "connector.installed",
      "connector.uninstalled",
      "config.changed",
      "skill.created",
    ]);
  });

  it("creates workspace/ subdirectory automatically", () => {
    const freshDir = join(dir, "nested", "logs");
    const sink = new WorkspaceLogSink({ dir: freshDir });
    sink.emit(configChanged);

    const files = readdirSync(join(freshDir, "workspace"));
    expect(files).toHaveLength(1);
  });

  it("writes all workspace event types", () => {
    const sink = new WorkspaceLogSink({ dir });
    for (const event of WORKSPACE_EVENTS) sink.emit(event);

    const files = readdirSync(join(dir, "workspace"));
    const lines = readFileSync(join(dir, "workspace", files[0]), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(WORKSPACE_EVENTS.length);
  });

  it("close() is a no-op", () => {
    const sink = new WorkspaceLogSink({ dir });
    expect(() => sink.close()).not.toThrow();
  });

  it("never throws into emit on a write failure, and warns once per episode", () => {
    // A detached turn outlives its HTTP request, so an unhandled throw in the
    // sink crashes the turn. Block the write by parking a directory at the
    // log-file path (appendFileSync → EISDIR).
    const sink = new WorkspaceLogSink({ dir });
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(dir, "workspace", `${today}.jsonl`);
    mkdirSync(logFile);
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(() => sink.emit(installed)).not.toThrow();
      expect(() => sink.emit(uninstalled)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1); // suppressed after the first

      // A successful write re-arms the warning for the next failure episode.
      rmSync(logFile, { recursive: true });
      sink.emit(installed); // writes → reset
      rmSync(logFile);
      mkdirSync(logFile); // block again
      sink.emit(configChanged);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
