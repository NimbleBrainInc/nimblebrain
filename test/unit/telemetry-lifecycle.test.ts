import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionState } from "../../src/connectors/runtime/connection.ts";
import { UserStore } from "../../src/identity/user.ts";
import type { TelemetryClient } from "../../src/telemetry/manager.ts";
import { TelemetryManager } from "../../src/telemetry/manager.ts";
import { PostHogEventSink } from "../../src/telemetry/posthog-sink.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { engineEvent } from "../helpers/engine-events.ts";

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

  it("looks up a person the event names without their email, once, and sets it", async () => {
    const { events, manager } = setup(true);
    const asked: string[] = [];
    manager.setPersonSource(async (userId) => {
      asked.push(userId);
      return userId === "usr_1" ? { email: "a@example.com", name: "Ada" } : undefined;
    });
    // A scheduled run acts as its owner's id alone.
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1", workspaceId: "ws_1" });
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1", workspaceId: "ws_1" });
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_gone" });
    await settle();

    expect(asked).toEqual(["usr_1", "usr_gone"]);
    expect(events.filter((e) => e.event === "$set")).toEqual([
      {
        distinctId: "usr_1",
        event: "$set",
        properties: { $set: { email: "a@example.com", name: "Ada" } },
      },
    ]);
  });

  it("names a workspace once, the first time an event is grouped under it", async () => {
    const { events, manager } = setup(true);
    const asked: string[] = [];
    manager.setWorkspaceSource(async (wsId) => {
      asked.push(wsId);
      return wsId === "ws_1" ? "Acme ops" : undefined;
    });
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1", workspaceId: "ws_1" });
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1", workspaceId: "ws_1" });
    manager.captureAbout(
      "automation.run_completed",
      {},
      { userId: "usr_1", workspaceId: "ws_gone" },
    );
    await settle();

    expect(asked).toEqual(["ws_1", "ws_gone"]);
    expect(events.filter((e) => e.event === "$groupidentify")).toEqual([
      {
        distinctId: "$workspace_ws_1",
        event: "$groupidentify",
        properties: {
          $group_type: "workspace",
          $group_key: "ws_1",
          $group_set: { name: "Acme ops" },
        },
      },
    ]);
  });

  it("names the workspace of the request an event comes from", async () => {
    const { events, manager } = setup(true);
    manager.setSubjectSource(() => ({ userId: "usr_1", workspaceId: "ws_1" }));
    manager.setWorkspaceSource(async () => "Acme ops");
    manager.capture("agent.chat_started", {});
    await settle();
    expect(events.filter((e) => e.event === "$groupidentify")).toEqual([
      {
        distinctId: "$workspace_ws_1",
        event: "$groupidentify",
        properties: {
          $group_type: "workspace",
          $group_key: "ws_1",
          $group_set: { name: "Acme ops" },
        },
      },
    ]);
  });

  it("keeps the event when the workspace lookup fails", async () => {
    const { events, manager } = setup(true);
    manager.setWorkspaceSource(async () => {
      throw new Error("store down");
    });
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1", workspaceId: "ws_1" });
    await settle();
    expect(events.map((e) => e.event)).toEqual(["automation.run_completed"]);
  });

  it("names no workspace when the deployment does not identify", async () => {
    const { events, manager } = setup(false);
    const asked: string[] = [];
    manager.setSubjectSource(() => ({ userId: "usr_1", workspaceId: "ws_1" }));
    manager.setWorkspaceSource(async (wsId) => {
      asked.push(wsId);
      return "Acme ops";
    });
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1", workspaceId: "ws_1" });
    manager.capture("agent.chat_started", {});
    await settle();
    expect(asked).toEqual([]);
    expect(events.filter((e) => e.event === "$groupidentify")).toEqual([]);
  });

  it("still sets the email from a later event after one that lacked it", () => {
    const { events, manager } = setup(true);
    manager.captureAbout("automation.run_completed", {}, { userId: "usr_1" });
    manager.captureAbout("member.added", {}, { userId: "usr_1", email: "a@example.com" });
    expect(events[1]?.properties.$set).toEqual({ email: "a@example.com" });
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
