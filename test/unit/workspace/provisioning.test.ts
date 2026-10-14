import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserStore } from "../../../src/identity/user.ts";
import {
  ensureUserWorkspace,
  provisionedWorkspaceName,
} from "../../../src/workspace/provisioning.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

const OPAQUE_ID = /^ws_[0-9a-f]{16}$/;

let workDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ws-provision-test-"));
  store = new WorkspaceStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("ensureUserWorkspace", () => {
  test("creates one ordinary workspace for a user with no membership", async () => {
    const [ws, ...rest] = await ensureUserWorkspace(store, {
      id: "user_alice",
      displayName: "Alice Smith",
    });

    expect(rest).toEqual([]);
    expect(ws?.id).toMatch(OPAQUE_ID);
    expect(ws?.name).toBe("Alice's workspace");
    expect(ws?.members).toEqual([{ userId: "user_alice", role: "admin" }]);
    expect(ws && "isPersonal" in ws).toBe(false);
    expect(ws && "ownerUserId" in ws).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });

  test("returns existing memberships and creates nothing", async () => {
    const team = await store.create("Team", {
      members: [{ userId: "user_alice", role: "member" }],
    });

    const memberships = await ensureUserWorkspace(store, {
      id: "user_alice",
      displayName: "Alice",
    });

    expect(memberships.map((w) => w.id)).toEqual([team.id]);
    expect(await store.list()).toHaveLength(1);
  });

  test("is idempotent across sequential calls", async () => {
    const first = await ensureUserWorkspace(store, { id: "user_alice" });
    const second = await ensureUserWorkspace(store, { id: "user_alice" });

    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id));
    expect(await store.list()).toHaveLength(1);
  });

  test("concurrent calls for one user create exactly one workspace", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureUserWorkspace(store, { id: "user_alice" })),
    );

    const ids = new Set(results.flat().map((w) => w.id));
    expect(ids.size).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  test("provisions again for a user removed from every workspace", async () => {
    const [first] = await ensureUserWorkspace(store, { id: "user_alice" });
    await store.removeMember(first!.id, "user_alice");

    const [second] = await ensureUserWorkspace(store, { id: "user_alice" });

    expect(second?.id).not.toBe(first?.id);
    expect(second?.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });
});

describe("provisionedWorkspaceName", () => {
  test.each([
    ["Mat Goldsborough", "Mat's workspace"],
    ["  Mat  ", "Mat's workspace"],
    ["mat@x.ai", "mat's workspace"],
    [undefined, "Workspace"],
    ["", "Workspace"],
    ["   ", "Workspace"],
  ])("%p → %p", (displayName, expected) => {
    expect(provisionedWorkspaceName(displayName)).toBe(expected);
  });
});
