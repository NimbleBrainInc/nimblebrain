import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureUserWorkspace } from "../../../src/workspace/provisioning.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

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
  test("creates a workspace and adds the user as admin when none exist", async () => {
    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(ws.id).toBe("ws_alice");
    expect(ws.name).toBe("Alice's Workspace");
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("falls back to generic name when displayName is missing", async () => {
    const ws = await ensureUserWorkspace(store, { id: "user_alice" });

    expect(ws.name).toBe("Workspace");
  });

  test("strips user_ prefix from workspace slug", async () => {
    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(ws.id).toBe("ws_alice");
  });

  test("is a no-op when the user already belongs to a workspace", async () => {
    const first = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });
    const second = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(second.id).toBe(first.id);
    expect((await store.list()).length).toBe(1);
  });

  test("concurrent calls for the same user produce exactly one workspace", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" }),
      ),
    );

    // All callers observe the same workspace.
    const ids = new Set(results.map((ws) => ws.id));
    expect(ids.size).toBe(1);

    // Store contains exactly one workspace.
    const list = await store.list();
    expect(list.length).toBe(1);
    expect(list[0]!.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("different users get different workspaces", async () => {
    const a = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });
    const b = await ensureUserWorkspace(store, { id: "user_bob", displayName: "Bob" });

    expect(a.id).toBe("ws_alice");
    expect(b.id).toBe("ws_bob");
    expect((await store.list()).length).toBe(2);
  });

  test("returns the existing workspace if the user is already a member", async () => {
    const created = await store.create("Shared");
    await store.addMember(created.id, "user_alice", "member");

    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(ws.id).toBe(created.id);
    // Membership unchanged — did not downgrade/upgrade role.
    expect(ws.members).toEqual([{ userId: "user_alice", role: "member" }]);
  });

  test("different OIDC-style user IDs whose SHA-256 prefixes share hex produce different workspaces", async () => {
    // Regression guard for the slug-truncation collision: before the fix,
    // deriveSlug truncated to 16 chars, leaving only ~7 hex of entropy for
    // usr_oidc_<12-hex> IDs. Two users whose hex prefixes shared the first
    // 7 chars ended up sharing the same workspace. The fix drops truncation
    // so the full ID disambiguates.
    const a = await ensureUserWorkspace(store, {
      id: "usr_oidc_abcdef0011aa",
      displayName: "A",
    });
    const b = await ensureUserWorkspace(store, {
      id: "usr_oidc_abcdef0022bb",
      displayName: "B",
    });

    expect(a.id).not.toBe(b.id);
    expect(a.members.map((m) => m.userId)).toEqual(["usr_oidc_abcdef0011aa"]);
    expect(b.members.map((m) => m.userId)).toEqual(["usr_oidc_abcdef0022bb"]);
  });
});
