import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLogSink } from "../../src/adapters/workspace-log-sink.ts";
import { resolveFeatures } from "../../src/config/features.ts";
import type { ConfirmationGate } from "../../src/config/privilege.ts";
import { createPrivilegeHook, NoopConfirmationGate } from "../../src/config/privilege.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { firstPayloadOf } from "../helpers/engine-events.ts";

function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-test-"));
}

function readLogRecords(dir: string, pattern?: RegExp): Record<string, unknown>[] {
  const files = readdirSync(dir).filter((f) => (pattern ? pattern.test(f) : f.endsWith(".jsonl")));
  if (files.length === 0) return [];
  const content = readFileSync(join(dir, files[0]!), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

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
      data: {
        ip: "192.168.1.1",
        method: "POST",
        path: "/v1/workspaces/ws_00079598e311c160/chat/start",
      },
    });

    const records = readLogRecords(join(dir, "workspace"));
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("audit.auth_failure");
    expect(records[0]!.ip).toBe("192.168.1.1");
    expect(records[0]!.method).toBe("POST");
    expect(records[0]!.path).toBe("/v1/workspaces/ws_00079598e311c160/chat/start");
  });

  it("persists audit.permission_denied events", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit({
      type: "audit.permission_denied",
      data: { tool: "skills__create", action: "create", target: "my-skill" },
    });

    const records = readLogRecords(join(dir, "workspace"));
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("audit.permission_denied");
    expect(records[0]!.tool).toBe("skills__create");
  });

  // An unattended dispatch writes no conversation and no run result, so this
  // line is its only trace — and the security page points operators at this log
  // to find it. A type missing from `WORKSPACE_EVENTS` is dropped silently,
  // which would leave that page describing a file with nothing in it.
  it("persists audit.unattended_dispatch events", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit({
      type: "audit.unattended_dispatch",
      data: {
        principalId: "usr_route_author",
        workspaceId: "ws_003eba8844413cd9",
        tool: "slack__send_message",
        reason: "route:rt_outbound_slack",
        outcome: "denied",
        classification: "tool_permission_denied",
        ms: 4,
      },
    });

    const records = readLogRecords(join(dir, "workspace"));
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("audit.unattended_dispatch");
    expect(records[0]!.principalId).toBe("usr_route_author");
    expect(records[0]!.reason).toBe("route:rt_outbound_slack");
    expect(records[0]!.outcome).toBe("denied");
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
    };

    const hook = createPrivilegeHook(denyGate, captureSink, resolveFeatures());

    const result = await hook({
      id: "call_1",
      name: "skills__create",
      input: { scope: "workspace", name: "my-skill" },
    });

    expect(result).toBeNull();
    expect(events).toHaveLength(1);
    const denied = firstPayloadOf(events, "audit.permission_denied");
    expect(denied?.tool).toBe("skills__create");
    expect(denied?.action).toBe("create");
    expect(denied?.target).toBe("my-skill");
  });

  it("does not emit audit event when gate approves", async () => {
    const events: EngineEvent[] = [];
    const captureSink: EventSink = { emit: (e) => events.push(e) };

    const hook = createPrivilegeHook(new NoopConfirmationGate(), captureSink);

    const result = await hook({
      id: "call_1",
      name: "skills__create",
      input: { scope: "workspace", name: "my-skill" },
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
