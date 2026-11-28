/**
 * The installed-plugin record store under concurrent writers: records for one
 * owner live in the same file as that owner's connectors, so every write to
 * that file holds the owner's record chain and none is lost.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import { IdentityConnectorStore } from "../../../src/identity/connector-store.ts";
import {
  createPluginRecordStore,
  type InstalledPluginRecord,
  type PluginOwner,
} from "../../../src/plugins/installed/record.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-plugin-record-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function record(address: string): InstalledPluginRecord {
  return {
    address,
    digest: `sha256:${"0".repeat(64)}`,
    type: "application/agent-plugins+zip",
    installedAt: "2026-01-01T00:00:00.000Z",
    connectors: [],
    skills: [],
    starters: [],
  };
}

const ref = (serverName: string): ConnectorRef => ({
  url: `https://${serverName}.test/mcp`,
  serverName,
});

async function owners(): Promise<{ workspaces: WorkspaceStore; owners: PluginOwner[] }> {
  const workspaces = new WorkspaceStore(workDir);
  const ws = await workspaces.create("Records");
  return {
    workspaces,
    owners: [
      { kind: "workspace", wsId: ws.id },
      { kind: "person", userId: "usr_records" },
    ],
  };
}

describe("installed-plugin records", () => {
  test("concurrent puts and removes for one owner keep every record", async () => {
    const { workspaces, owners: all } = await owners();
    const store = createPluginRecordStore({ workspaces, workDir });
    for (const owner of all) {
      await Promise.all(["a@test", "b@test", "c@test"].map((a) => store.put(owner, record(a))));
      expect((await store.list(owner)).map((r) => r.address).sort()).toEqual([
        "a@test",
        "b@test",
        "c@test",
      ]);
      await Promise.all([store.remove(owner, "a@test"), store.put(owner, record("d@test"))]);
      expect((await store.list(owner)).map((r) => r.address).sort()).toEqual([
        "b@test",
        "c@test",
        "d@test",
      ]);
    }
  });

  test("a record write and a connector write to one file keep each other", async () => {
    const { workspaces, owners: all } = await owners();
    const store = createPluginRecordStore({ workspaces, workDir });
    const [workspace, person] = all as [
      Extract<PluginOwner, { kind: "workspace" }>,
      Extract<PluginOwner, { kind: "person" }>,
    ];

    await Promise.all([
      store.put(workspace, record("a@test")),
      workspaces.update(workspace.wsId, { connectors: [ref("one")] }),
    ]);
    const ws = await workspaces.get(workspace.wsId);
    expect(ws?.plugins?.map((r) => r.address)).toEqual(["a@test"]);
    expect(ws?.connectors.map((c) => c.serverName)).toEqual(["one"]);

    const identity = new IdentityConnectorStore({ workDir });
    await Promise.all([
      store.put(person, record("a@test")),
      identity.add(person.userId, ref("one")),
      identity.add(person.userId, ref("two")),
    ]);
    expect((await identity.list(person.userId)).map((c) => c.serverName).sort()).toEqual([
      "one",
      "two",
    ]);
    expect((await identity.listPlugins(person.userId)).map((r) => r.address)).toEqual(["a@test"]);
  });
});
