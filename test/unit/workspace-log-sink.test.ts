import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceLogSink } from "../../src/adapters/workspace-log-sink.ts";
import type { EngineEvent } from "../../src/engine/types.ts";

function makeEvent(type: string, data: Record<string, unknown> = {}): EngineEvent {
  return { type: type as EngineEvent["type"], data };
}

describe("WorkspaceLogSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-log-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes bundle.installed event to workspace log", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit(makeEvent("bundle.installed", { name: "@test/foo" }));

    const files = readdirSync(join(dir, "workspace"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = readFileSync(join(dir, "workspace", files[0]), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("bundle.installed");
    expect(record.name).toBe("@test/foo");
    expect(record.ts).toBeDefined();
  });

  it("silently ignores non-workspace events", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit(makeEvent("run.start", { conversationId: "c1" }));
    sink.emit(makeEvent("llm.done", { model: "test" }));
    sink.emit(makeEvent("text.delta", { delta: "hi" }));
    sink.emit(makeEvent("tool.start", { toolName: "foo" }));
    sink.emit(makeEvent("run.done", {}));
    sink.emit(makeEvent("run.error", { error: "boom" }));

    const files = readdirSync(join(dir, "workspace"));
    expect(files).toHaveLength(0);
  });

  it("writes multiple events on the same day to the same file", () => {
    const sink = new WorkspaceLogSink({ dir });
    sink.emit(makeEvent("bundle.installed", { name: "@test/a" }));
    sink.emit(makeEvent("bundle.uninstalled", { name: "@test/b" }));
    sink.emit(makeEvent("data.changed", { source: "crm" }));
    sink.emit(makeEvent("config.changed", { key: "model" }));
    sink.emit(makeEvent("skill.created", { name: "greet" }));

    const files = readdirSync(join(dir, "workspace"));
    expect(files).toHaveLength(1);

    const lines = readFileSync(join(dir, "workspace", files[0]), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);

    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual([
      "bundle.installed",
      "bundle.uninstalled",
      "data.changed",
      "config.changed",
      "skill.created",
    ]);
  });

  it("creates workspace/ subdirectory automatically", () => {
    const freshDir = join(dir, "nested", "logs");
    const sink = new WorkspaceLogSink({ dir: freshDir });
    sink.emit(makeEvent("file.created", { path: "/a.txt" }));

    const files = readdirSync(join(freshDir, "workspace"));
    expect(files).toHaveLength(1);
  });

  it("writes all workspace event types", () => {
    const sink = new WorkspaceLogSink({ dir });
    const workspaceTypes = [
      "bundle.installed",
      "bundle.uninstalled",
      "bundle.crashed",
      "bundle.recovered",
      "bundle.dead",
      "bundle.start_failed",
      "data.changed",
      "config.changed",
      "skill.created",
      "skill.updated",
      "skill.deleted",
      "file.created",
      "file.deleted",
      "bridge.tool.done",
      "http.error",
      "audit.auth_failure",
      "audit.permission_denied",
    ];

    for (const type of workspaceTypes) {
      sink.emit(makeEvent(type, { type }));
    }

    const files = readdirSync(join(dir, "workspace"));
    const lines = readFileSync(join(dir, "workspace", files[0]), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(workspaceTypes.length);
  });

  it("close() is a no-op", () => {
    const sink = new WorkspaceLogSink({ dir });
    expect(() => sink.close()).not.toThrow();
  });
});
