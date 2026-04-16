import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StructuredLogSink } from "../../src/adapters/structured-log-sink.ts";
import { WorkspaceLogSink } from "../../src/adapters/workspace-log-sink.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { createPrivilegeHook, NoopConfirmationGate } from "../../src/config/privilege.ts";
import type { ConfirmationGate } from "../../src/config/privilege.ts";

function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-test-"));
}

function readLogRecords(dir: string, pattern?: RegExp): Record<string, unknown>[] {
  const files = readdirSync(dir).filter((f) =>
    pattern ? pattern.test(f) : f.endsWith(".jsonl"),
  );
  if (files.length === 0) return [];
  const content = readFileSync(join(dir, files[0]!), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// ── StructuredLogSink: identity context ──────────────────────────

describe("StructuredLogSink identity context", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeLogDir();
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("includes userId and workspaceId on records when set via constructor", () => {
    const sink = new StructuredLogSink({
      dir: logDir,
      userId: "user_abc",
      workspaceId: "ws_test",
    });
    sink.emit({ type: "run.start", data: { runId: "r1" } });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records[0]!.uid).toBe("user_abc");
    expect(records[0]!.wsId).toBe("ws_test");
  });

  it("omits uid and wsId when not set", () => {
    const sink = new StructuredLogSink({ dir: logDir });
    sink.emit({ type: "run.start", data: { runId: "r1" } });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records[0]!.uid).toBeUndefined();
    expect(records[0]!.wsId).toBeUndefined();
  });

  it("setUserId and setWorkspaceId update subsequent records", () => {
    const sink = new StructuredLogSink({ dir: logDir });
    sink.emit({ type: "run.start", data: { runId: "r1" } });
    sink.setUserId("user_xyz");
    sink.setWorkspaceId("ws_prod");
    sink.emit({ type: "run.done", data: { runId: "r1" } });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records[0]!.uid).toBeUndefined();
    expect(records[1]!.uid).toBe("user_xyz");
    expect(records[1]!.wsId).toBe("ws_prod");
  });
});

// ── StructuredLogSink: retention cleanup ─────────────────────────

describe("StructuredLogSink retention cleanup", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeLogDir();
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("deletes log files older than retentionDays", () => {
    // Seed old files
    writeFileSync(join(logDir, "nimblebrain-2025-01-01.jsonl"), '{"old":true}\n');
    writeFileSync(join(logDir, "nimblebrain-2025-01-15.jsonl"), '{"old":true}\n');
    // Seed a recent file (today)
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(logDir, `nimblebrain-${today}.jsonl`), '{"recent":true}\n');

    // Retention = 30 days — old files should be cleaned
    new StructuredLogSink({ dir: logDir, retentionDays: 30 });

    const remaining = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(`nimblebrain-${today}.jsonl`);
  });

  it("does not delete files when retentionDays is omitted", () => {
    writeFileSync(join(logDir, "nimblebrain-2020-01-01.jsonl"), '{"ancient":true}\n');

    new StructuredLogSink({ dir: logDir });

    const remaining = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining).toHaveLength(1);
  });

  it("ignores non-log files during cleanup", () => {
    writeFileSync(join(logDir, "nimblebrain-2020-01-01.jsonl"), '{"old":true}\n');
    writeFileSync(join(logDir, "README.md"), "keep me");

    new StructuredLogSink({ dir: logDir, retentionDays: 1 });

    const remaining = readdirSync(logDir);
    expect(remaining).toContain("README.md");
    expect(remaining).not.toContain("nimblebrain-2020-01-01.jsonl");
  });
});

// ── WorkspaceLogSink: audit events ───────────────────────────────

describe("WorkspaceLogSink audit events", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeLogDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists audit.auth_failure events", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit({
      type: "audit.auth_failure",
      data: { ip: "192.168.1.1", method: "POST", path: "/v1/chat" },
    });

    const records = readLogRecords(join(dir, "workspace"));
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("audit.auth_failure");
    expect(records[0]!.ip).toBe("192.168.1.1");
    expect(records[0]!.method).toBe("POST");
    expect(records[0]!.path).toBe("/v1/chat");
  });

  it("persists audit.permission_denied events", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit({
      type: "audit.permission_denied",
      data: { tool: "nb__manage_app", action: "install", target: "@test/foo" },
    });

    const records = readLogRecords(join(dir, "workspace"));
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("audit.permission_denied");
    expect(records[0]!.tool).toBe("nb__manage_app");
  });
});

// ── WorkspaceLogSink: retention cleanup ──────────────────────────

describe("WorkspaceLogSink retention cleanup", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeLogDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes workspace log files older than retentionDays", () => {
    const wsDir = join(dir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "2020-01-01.jsonl"), '{"old":true}\n');
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(wsDir, `${today}.jsonl`), '{"recent":true}\n');

    new WorkspaceLogSink({ dir, retentionDays: 30 });

    const remaining = readdirSync(wsDir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(`${today}.jsonl`);
  });
});

// ── Privilege hook: audit emission ───────────────────────────────

describe("createPrivilegeHook audit emission", () => {
  it("emits audit.permission_denied when gate denies a privileged tool", async () => {
    const events: EngineEvent[] = [];
    const captureSink: EventSink = { emit: (e) => events.push(e) };

    const denyGate: ConfirmationGate = {
      supportsInteraction: true,
      confirm: async () => false,
      promptConfigValue: async () => null,
    };

    const hook = createPrivilegeHook(denyGate, captureSink, { bundleManagement: true, skillManagement: true, delegation: true, toolDiscovery: true, bundleDiscovery: true, mcpServer: true, fileContext: true, userManagement: true, workspaceManagement: true });

    const result = await hook({
      id: "call_1",
      name: "nb__manage_app",
      input: { action: "install", name: "@test/foo" },
    });

    expect(result).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("audit.permission_denied");
    expect(events[0]!.data.tool).toBe("nb__manage_app");
    expect(events[0]!.data.action).toBe("install");
    expect(events[0]!.data.target).toBe("@test/foo");
  });

  it("does not emit audit event when gate approves", async () => {
    const events: EngineEvent[] = [];
    const captureSink: EventSink = { emit: (e) => events.push(e) };

    const hook = createPrivilegeHook(new NoopConfirmationGate(), captureSink);

    const result = await hook({
      id: "call_1",
      name: "nb__manage_app",
      input: { action: "install", name: "@test/foo" },
    });

    expect(result).not.toBeNull();
    expect(events).toHaveLength(0);
  });

  it("does not emit audit event for non-privileged tools", async () => {
    const events: EngineEvent[] = [];
    const captureSink: EventSink = { emit: (e) => events.push(e) };

    const denyGate: ConfirmationGate = {
      supportsInteraction: true,
      confirm: async () => false,
      promptConfigValue: async () => null,
    };

    const hook = createPrivilegeHook(denyGate, captureSink);

    const result = await hook({
      id: "call_1",
      name: "nb__status",
      input: {},
    });

    // Non-privileged tools pass through without hitting the gate
    expect(result).not.toBeNull();
    expect(events).toHaveLength(0);
  });
});
