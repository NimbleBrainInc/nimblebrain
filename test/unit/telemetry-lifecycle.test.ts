import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionState } from "../../src/connectors/runtime/connection.ts";
import { UserStore } from "../../src/identity/user.ts";
import { createTask } from "../../src/platform/tasks/domain.ts";
import { type Executor, Scheduler } from "../../src/platform/tasks/scheduler.ts";
import {
  captureAutomationCreated,
  captureAutomationRunEnded,
} from "../../src/platform/tasks/source.ts";
import { readRuns, saveTask } from "../../src/platform/tasks/store.ts";
import type { Task, TaskRun } from "../../src/platform/tasks/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { TelemetryClient } from "../../src/telemetry/manager.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { engineEvent } from "../helpers/engine-events.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

type Captured = Parameters<TelemetryClient["capture"]>[0];

function setup(identify: boolean): { events: Captured[]; manager: TelemetryManager } {
  const events: Captured[] = [];
  const manager = TelemetryManager.create({
    workDir: mkdtempSync(join(tmpdir(), "telemetry-lifecycle-")),
    enabled: true,
    identify,
    clientFactory: () => ({ capture: (e) => events.push(e), shutdown: async () => {} }),
    env: { NB_TENANT_ID: "tenant-a" },
  });
  return { events, manager };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("captureAbout", () => {
  it("names the person and workspace given, and sets their email once", () => {
    const { events, manager } = setup(true);
    manager.captureAbout(
      "user.signed_up",
      {},
      { userId: "usr_1", email: "a@example.com", name: "Ada" },
    );
    manager.captureAbout(
      "member.added",
      { role: "admin" },
      { userId: "usr_1", workspaceId: "ws_1" },
    );

    expect(events[0]?.distinctId).toBe("usr_1");
    expect(events[0]?.properties.$set).toEqual({ email: "a@example.com", name: "Ada" });
    expect(events[1]?.groups).toEqual({ tenant: "tenant-a", workspace: "ws_1" });
    expect(events[1]?.properties.$set).toBeUndefined();
  });

  it("sends nothing when the deployment does not identify", () => {
    const { events, manager } = setup(false);
    manager.captureAbout("user.signed_up", {}, { userId: "usr_1", email: "a@example.com" });
    expect(events).toHaveLength(0);
  });
});

describe("connector sign-in, from connection transitions", () => {
  function changed(serverName: string, state: ConnectionState) {
    return engineEvent("connection.state_changed", {
      wsId: "ws_1",
      serverName,
      connectorName: serverName,
      principalId: "_workspace",
      state,
      lastError: "token refused for a@example.com",
      authorizationUrl: "https://vendor.example/authorize?state=secret",
    });
  }

  it("reads started, completed, failed and lost, naming the catalog connector only", async () => {
    const { events, manager } = setup(true);
    const sink = new PostHogEventSink(manager);
    sink.setConnectorResolver(async (owner, name) => {
      if ("workspaceId" in owner) return name === "linear" ? "app.linear/linear" : undefined;
      return name === "gmail" ? "com.google/gmail" : undefined;
    });
    for (const [name, state] of [
      ["linear", "not_authenticated"],
      ["linear", "pending_auth"],
      ["linear", "running"],
      ["linear", "reauth_required"],
      ["acme-internal", "pending_auth"],
      ["acme-internal", "not_authenticated"],
    ] as const) {
      sink.emit(changed(name, state));
    }
    // A person's own plugin, signing in.
    for (const state of ["pending_auth", "running"] as const) {
      sink.emit(
        engineEvent("connection.state_changed", {
          userId: "usr_1",
          serverName: "gmail",
          connectorName: "gmail",
          principalId: "usr_1",
          state,
        }),
      );
    }
    await settle();

    expect(events.map((e) => [e.event, e.properties.connector])).toEqual([
      ["connector.auth_started", "app.linear/linear"],
      ["connector.auth_completed", "app.linear/linear"],
      ["connector.auth_lost", "app.linear/linear"],
      ["connector.auth_started", "custom"],
      ["connector.auth_failed", "custom"],
      ["connector.auth_started", "com.google/gmail"],
      ["connector.auth_completed", "com.google/gmail"],
    ]);
    const text = JSON.stringify(events);
    for (const secret of ["acme-internal", "a@example.com", "state=secret"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("store listeners", () => {
  it("tell of a user created, a workspace created, and each member added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telemetry-stores-"));
    const users = new UserStore(dir);
    const workspaces = new WorkspaceStore(dir);
    const seen: string[] = [];
    users.onCreated((u) => seen.push(`user:${u.email}`));
    workspaces.onCreated((ws) => seen.push(`workspace:${ws.name}`));
    workspaces.onMemberAdded((_ws, userId, role) => seen.push(`member:${userId}:${role}`));

    const user = await users.create({ email: "a@example.com", displayName: "Ada" });
    const ws = await workspaces.create("Ops", { members: [{ userId: user.id, role: "admin" }] });
    await workspaces.addMember(ws.id, "usr_2", "member");

    expect(seen).toEqual([
      "user:a@example.com",
      "workspace:Ops",
      `member:${user.id}:admin`,
      "member:usr_2:member",
    ]);
  });

  it("never fail the write when a listener throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telemetry-stores-"));
    const users = new UserStore(dir);
    const workspaces = new WorkspaceStore(dir);
    const boom = () => {
      throw new Error("listener down");
    };
    users.onCreated(boom);
    workspaces.onCreated(boom);
    workspaces.onMemberAdded(boom);

    const user = await users.create({ email: "a@example.com", displayName: "Ada" });
    const ws = await workspaces.create("Ops", { members: [{ userId: user.id, role: "admin" }] });
    await workspaces.addMember(ws.id, "usr_2", "member");

    expect((await users.getByEmail("a@example.com"))?.id).toBe(user.id);
    expect((await workspaces.get(ws.id))?.members.map((m) => m.userId)).toEqual([user.id, "usr_2"]);
  });
});

describe("tasks createTask", () => {
  it("tells onCreated of the saved task", () => {
    const created: Task[] = [];
    const defs = new Map<string, Task>();
    createTask(
      { name: "Daily digest", prompt: "Summarize", ownerId: "usr_1", workspaceId: "ws_1" },
      {
        definitions: () => defs,
        save: () => {},
        reloadScheduler: () => {},
        defaultTimezone: "UTC",
        onCreated: (t) => created.push(t),
      },
    );
    expect(created.map((t) => t.name)).toEqual(["Daily digest"]);
  });
});

const WS = "ws_00a1b2c3d4e5f607";
const OWNER = "usr_1";

/** The runtime surface the tasks source's telemetry captures read. */
const runtimeOf = (manager: TelemetryManager): Pick<Runtime, "getTelemetryManager"> => ({
  getTelemetryManager: () => manager,
});

function domainCtx(defs: Map<string, Task>, onCreated: (t: Task) => void) {
  return {
    definitions: () => defs,
    save: () => {},
    reloadScheduler: () => {},
    defaultTimezone: "UTC",
    onCreated,
  };
}

describe("automation.created", () => {
  const input = {
    name: "Acme board digest",
    prompt: "Summarize the acme board",
    ownerId: OWNER,
    workspaceId: WS,
  };

  it("reports how the task is triggered and who made it, about its owner", () => {
    const { events, manager } = setup(true);
    createTask(
      input,
      domainCtx(new Map(), (t) => captureAutomationCreated(runtimeOf(manager), t)),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("automation.created");
    expect(events[0]?.distinctId).toBe(OWNER);
    expect(events[0]?.groups).toEqual({ tenant: "tenant-a", workspace: WS });
    expect(events[0]?.properties).toMatchObject({ trigger: "manual", kind: "saved" });
    expect(JSON.stringify(events)).not.toContain("acme");
  });

  it("sends nothing when the deployment does not identify", () => {
    const { events, manager } = setup(false);
    createTask(
      input,
      domainCtx(new Map(), (t) => captureAutomationCreated(runtimeOf(manager), t)),
    );
    expect(events).toHaveLength(0);
  });

  it("keeps the saved task when the observer throws", () => {
    const defs = new Map<string, Task>();
    const result = createTask(
      input,
      domainCtx(defs, () => {
        throw new Error("telemetry down");
      }),
    );
    expect(defs.get(result.task.id)?.name).toBe("Acme board digest");
  });
});

describe("automation.run_completed", () => {
  function seeded(): { workDir: string; task: Task } {
    const workDir = mkdtempSync(join(tmpdir(), "telemetry-runs-"));
    seedWorkspaceRoot(workDir, WS);
    const now = new Date().toISOString();
    const task: Task = {
      id: "digest",
      ownerId: OWNER,
      workspaceId: WS,
      name: "Acme board digest",
      prompt: "Summarize the acme board",
      enabled: true,
      source: "user",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      consecutiveErrors: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
    };
    saveTask(workDir, WS, OWNER, task);
    return { workDir, task };
  }

  const executor: Executor = async (task, _signal, trigger, _input, _lease, runId) => {
    const run: TaskRun = {
      id: runId ?? "run_1",
      taskId: task.id,
      startedAt: new Date(Date.now() - 1500).toISOString(),
      completedAt: new Date().toISOString(),
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 3,
      iterations: 1,
      trigger,
      resultPreview: "acme board output",
    };
    return { run, result: null };
  };

  it("reports a recorded run's outcome about its owner and workspace, never its output", async () => {
    const { events, manager } = setup(true);
    const { workDir, task } = seeded();
    const scheduler = new Scheduler(executor, {
      workDir,
      onRunEnded: (wsId, ownerId, run) =>
        captureAutomationRunEnded(runtimeOf(manager), wsId, ownerId, run),
    });
    scheduler.start();
    await scheduler.runNow(WS, OWNER, task.id);
    scheduler.stop();

    const ended = events.filter((e) => e.event === "automation.run_completed");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.distinctId).toBe(OWNER);
    expect(ended[0]?.groups).toEqual({ tenant: "tenant-a", workspace: WS });
    expect(ended[0]?.properties).toMatchObject({
      status: "success",
      tool_calls: 3,
      in_batch: false,
    });
    expect(typeof ended[0]?.properties.duration_ms).toBe("number");
    expect(JSON.stringify(events)).not.toContain("acme");
  });

  it("keeps the recorded run when the observer throws", async () => {
    const { workDir, task } = seeded();
    const scheduler = new Scheduler(executor, {
      workDir,
      onRunEnded: () => {
        throw new Error("telemetry down");
      },
    });
    scheduler.start();
    const run = await scheduler.runNow(WS, OWNER, task.id);
    scheduler.stop();

    expect(run?.status).toBe("success");
    expect(readRuns(workDir, WS, OWNER, task.id).map((r) => r.id)).toEqual([run!.id]);
  });
});
