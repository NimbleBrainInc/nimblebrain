import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureUserWorkspace } from "../../../src/workspace/provisioning.ts";
import {
  personalWorkspaceIdFor,
  WorkspaceStore,
} from "../../../src/workspace/workspace-store.ts";

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
  test("creates the canonical personal workspace and adds the user as admin", async () => {
    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(ws.id).toBe(personalWorkspaceIdFor("user_alice"));
    expect(ws.id).toBe("ws_user_user_alice");
    expect(ws.name).toBe("Alice's Workspace");
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");
  });

  test("falls back to generic name when displayName is missing", async () => {
    const ws = await ensureUserWorkspace(store, { id: "user_alice" });

    expect(ws.name).toBe("Workspace");
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");
  });

  test("preserves the user_ prefix in the workspace id (dumb concat, no strip)", async () => {
    // The personal-workspace helper is `ws_user_` + userId — full id preserved,
    // doubled-prefix on purpose. See `personalWorkspaceIdFor` docblock.
    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(ws.id).toBe("ws_user_user_alice");
  });

  test("works for ids that don't start with user_ (e.g. dev provider's usr_*)", async () => {
    const ws = await ensureUserWorkspace(store, { id: "usr_default" });

    expect(ws.id).toBe("ws_user_usr_default");
    expect(ws.ownerUserId).toBe("usr_default");
  });

  test("is a no-op when the user already has a personal workspace", async () => {
    const first = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });
    const second = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(second.id).toBe(first.id);
    expect((await store.list()).length).toBe(1);
  });

  test("concurrent calls for the same user produce exactly one personal workspace", async () => {
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
    expect(list[0]!.isPersonal).toBe(true);
  });

  test("different users get different personal workspaces", async () => {
    const a = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });
    const b = await ensureUserWorkspace(store, { id: "user_bob", displayName: "Bob" });

    expect(a.id).toBe("ws_user_user_alice");
    expect(b.id).toBe("ws_user_user_bob");
    expect(a.ownerUserId).toBe("user_alice");
    expect(b.ownerUserId).toBe("user_bob");
    expect((await store.list()).length).toBe(2);
  });

  test("creates the personal workspace even when the user is already in a shared one", async () => {
    // Stage 1 invariant: every user has a personal workspace, regardless of
    // shared memberships. Pre-Stage-1 behavior returned any membership and
    // skipped creation — now the personal workspace is created separately.
    const shared = await store.create("Shared");
    await store.addMember(shared.id, "user_alice", "member");

    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    expect(ws.id).toBe("ws_user_user_alice");
    expect(ws.id).not.toBe(shared.id);
    expect(ws.isPersonal).toBe(true);

    // Both workspaces exist; user is a member of both.
    const list = await store.list();
    expect(list.length).toBe(2);
    const sharedAfter = await store.get(shared.id);
    expect(sharedAfter?.members).toEqual([{ userId: "user_alice", role: "member" }]);
  });

  test("self-heals when the canonical workspace exists but the user is not a member", async () => {
    // Arrange: pre-create the personal workspace WITHOUT the user as a
    // member (simulates admin error or partial migration).
    const wsId = personalWorkspaceIdFor("user_alice");
    await store.create("Alice's Workspace", wsId.slice(3), {
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    // Pre-condition: workspace exists with zero members.
    const pre = await store.get(wsId);
    expect(pre?.members).toEqual([]);

    // Act: provisioning runs.
    const ws = await ensureUserWorkspace(store, { id: "user_alice", displayName: "Alice" });

    // The workspace is the same one; the user is now a member.
    expect(ws.id).toBe(wsId);
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("OIDC-style user IDs that share hex prefixes still produce different workspaces", async () => {
    // Regression guard preserved from the prior implementation. The full
    // user id is part of the canonical workspace id, so no prefix overlap
    // can collide.
    const a = await ensureUserWorkspace(store, {
      id: "usr_oidc_abcdef0011aa",
      displayName: "A",
    });
    const b = await ensureUserWorkspace(store, {
      id: "usr_oidc_abcdef0022bb",
      displayName: "B",
    });

    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe("ws_user_usr_oidc_abcdef0011aa");
    expect(b.id).toBe("ws_user_usr_oidc_abcdef0022bb");
    expect(a.members.map((m) => m.userId)).toEqual(["usr_oidc_abcdef0011aa"]);
    expect(b.members.map((m) => m.userId)).toEqual(["usr_oidc_abcdef0022bb"]);
  });
});
