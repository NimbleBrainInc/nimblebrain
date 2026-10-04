import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateAgentTargetKeys,
  readNotificationsConfig,
  type WorkspaceNotificationsConfig,
} from "../../../src/notifications/config.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let store: WorkspaceStore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-agent-target-"));
  store = new WorkspaceStore(workDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A route block as a workspace written before the rename stored it. */
function legacyBlock(): WorkspaceNotificationsConfig {
  return {
    routes: [
      {
        id: "r1",
        createdBy: "usr_a",
        match: { source: "crm" },
        deliver: [
          { kind: "agent", automation: "triage" },
          { kind: "tool", name: "slack__post" },
        ],
      },
    ],
  } as unknown as WorkspaceNotificationsConfig;
}

describe("migrateAgentTargetKeys", () => {
  test("rewrites an agent target's old key to task, once, leaving everything else", async () => {
    const ws = await store.create("Ops");
    await store.update(ws.id, { notifications: legacyBlock() });

    expect(await migrateAgentTargetKeys(store)).toBe(1);

    const stored = JSON.parse(
      readFileSync(join(store.getWorkspacesDir(), ws.id, "workspace.json"), "utf-8"),
    );
    expect(stored.notifications.routes[0].deliver).toEqual([
      { kind: "agent", task: "triage" },
      { kind: "tool", name: "slack__post" },
    ]);
    expect(stored.notifications.routes[0].match).toEqual({ source: "crm" });
    expect(readNotificationsConfig(await store.get(ws.id)).routes?.[0]?.deliver[0]).toEqual({
      kind: "agent",
      task: "triage",
    });

    expect(await migrateAgentTargetKeys(store)).toBe(0);
  });

  test("leaves a workspace with no agent targets untouched", async () => {
    const ws = await store.create("Quiet");
    const before = (await store.get(ws.id))?.updatedAt;

    expect(await migrateAgentTargetKeys(store)).toBe(0);
    expect((await store.get(ws.id))?.updatedAt).toBe(before);
  });
});
