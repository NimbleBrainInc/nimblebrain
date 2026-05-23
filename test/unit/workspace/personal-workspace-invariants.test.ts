/**
 * Personal-workspace invariants enforced by `WorkspaceStore` (Stage 1.1).
 *
 * The store is the source of truth for four rules:
 *   1. Personal workspaces' members are locked to
 *      `[{ userId: ownerUserId, role: "admin" }]`.
 *   2. `isPersonal` is frozen post-create (both directions).
 *   3. `ownerUserId` is frozen on personal workspaces.
 *   4. `ownerUserId` MUST NOT be set on non-personal workspaces.
 *
 * Each rule is exercised positively (it throws) and the topology
 * adversarial cases (`bundles`, `name` updates on a personal workspace)
 * confirm we didn't over-lock — those still succeed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PersonalWorkspaceInvariantError } from "../../../src/workspace/errors.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ws-invariants-"));
  store = new WorkspaceStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function createPersonal(userId = "user_alice"): Promise<{ wsId: string }> {
  const ws = await store.create("Alice", `user_${userId}`, {
    isPersonal: true,
    ownerUserId: userId,
  });
  return { wsId: ws.id };
}

async function createShared(slug = "team"): Promise<{ wsId: string }> {
  const ws = await store.create("Team", slug);
  return { wsId: ws.id };
}

// ── Invariant 1: members locked on personal workspaces ───────────────

describe("members locked on personal workspaces", () => {
  test("addMember on personal workspace throws members_mutation", async () => {
    const { wsId } = await createPersonal();
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.addMember(wsId, "user_bob", "admin");
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured).not.toBeNull();
    expect(captured?.reason).toBe("members_mutation");
    expect(captured?.workspaceId).toBe(wsId);
  });

  test("removeMember on personal workspace (removing the owner) throws", async () => {
    const { wsId } = await createPersonal();
    await expect(store.removeMember(wsId, "user_alice")).rejects.toBeInstanceOf(
      PersonalWorkspaceInvariantError,
    );
  });

  test("updateMemberRole on personal workspace throws", async () => {
    const { wsId } = await createPersonal();
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.updateMemberRole(wsId, "user_alice", "member");
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured?.reason).toBe("members_mutation");
  });

  test("update() with a members patch that adds a non-owner throws", async () => {
    const { wsId } = await createPersonal();
    await expect(
      // Cast through the type system: `members` is not in `update`'s
      // Pick — runtime must still reject.
      store.update(wsId, {
        members: [
          { userId: "user_alice", role: "admin" },
          { userId: "user_bob", role: "admin" },
        ],
      } as unknown as { name: string }),
    ).rejects.toBeInstanceOf(PersonalWorkspaceInvariantError);
  });

  test("update() that removes the owner from members throws", async () => {
    const { wsId } = await createPersonal();
    await expect(
      store.update(wsId, { members: [] } as unknown as { name: string }),
    ).rejects.toBeInstanceOf(PersonalWorkspaceInvariantError);
  });

  test("update() that demotes the owner from admin to member throws", async () => {
    const { wsId } = await createPersonal();
    await expect(
      store.update(wsId, {
        members: [{ userId: "user_alice", role: "member" }],
      } as unknown as { name: string }),
    ).rejects.toBeInstanceOf(PersonalWorkspaceInvariantError);
  });
});

// ── Invariant 2: isPersonal frozen post-create ───────────────────────

describe("isPersonal frozen post-create", () => {
  test("flipping isPersonal: true → false throws is_personal_frozen", async () => {
    const { wsId } = await createPersonal();
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.update(wsId, { isPersonal: false } as unknown as { name: string });
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured?.reason).toBe("is_personal_frozen");
  });

  test("flipping isPersonal: false → true throws is_personal_frozen", async () => {
    const { wsId } = await createShared();
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.update(wsId, { isPersonal: true } as unknown as { name: string });
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured?.reason).toBe("is_personal_frozen");
  });
});

// ── Invariant 3: ownerUserId frozen on personal workspaces ───────────

describe("ownerUserId frozen on personal workspaces", () => {
  test("changing ownerUserId on a personal workspace throws", async () => {
    const { wsId } = await createPersonal("user_alice");
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.update(wsId, { ownerUserId: "user_evil" } as unknown as { name: string });
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured?.reason).toBe("owner_user_id_frozen");
  });

  test("setting the same ownerUserId on a personal workspace is a no-op (idempotent)", async () => {
    // Passing the existing value through `update` is allowed because
    // it's not a mutation — important so callers that round-trip the
    // full workspace shape don't trip the invariant.
    const { wsId } = await createPersonal("user_alice");
    const updated = await store.update(wsId, {
      ownerUserId: "user_alice",
    } as unknown as { name: string });
    expect(updated?.ownerUserId).toBe("user_alice");
  });
});

// ── Invariant 4: ownerUserId forbidden on non-personal workspaces ────

describe("ownerUserId forbidden on non-personal workspaces", () => {
  test("setting ownerUserId on a non-personal workspace throws owner_user_id_on_non_personal", async () => {
    const { wsId } = await createShared();
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.update(wsId, { ownerUserId: "user_bob" } as unknown as { name: string });
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured?.reason).toBe("owner_user_id_on_non_personal");
  });
});

// ── Topology adversarial: mutable fields still work ──────────────────

describe("topology — non-identity fields stay freely mutable on personal workspaces", () => {
  test("update() of bundles on a personal workspace succeeds", async () => {
    const { wsId } = await createPersonal();
    const updated = await store.update(wsId, { bundles: [{ name: "echo" }] });
    expect(updated?.bundles).toEqual([{ name: "echo" }]);
    // Identity fields stay intact.
    expect(updated?.isPersonal).toBe(true);
    expect(updated?.ownerUserId).toBe("user_alice");
    expect(updated?.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("update() of name on a personal workspace succeeds", async () => {
    const { wsId } = await createPersonal();
    const updated = await store.update(wsId, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.isPersonal).toBe(true);
  });

  test("update() of about on a personal workspace succeeds", async () => {
    const { wsId } = await createPersonal();
    const updated = await store.update(wsId, { about: "my space" });
    expect(updated?.about).toBe("my space");
  });
});

// ── Create-time invariants ───────────────────────────────────────────

describe("create() enforces the personal-workspace shape", () => {
  test("personal workspace gets the owner as the sole admin by default", async () => {
    const ws = await store.create("Alice", "user_user_alice", {
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("create() rejects a personal workspace with extra members", async () => {
    let captured: PersonalWorkspaceInvariantError | null = null;
    try {
      await store.create("Alice", "user_user_alice", {
        isPersonal: true,
        ownerUserId: "user_alice",
        members: [
          { userId: "user_alice", role: "admin" },
          { userId: "user_bob", role: "admin" },
        ],
      });
    } catch (err) {
      if (err instanceof PersonalWorkspaceInvariantError) captured = err;
      else throw err;
    }
    expect(captured?.reason).toBe("members_mutation");
  });

  test("create() rejects a personal workspace whose initial member's userId doesn't match ownerUserId", async () => {
    await expect(
      store.create("Alice", "user_user_alice", {
        isPersonal: true,
        ownerUserId: "user_alice",
        members: [{ userId: "user_bob", role: "admin" }],
      }),
    ).rejects.toBeInstanceOf(PersonalWorkspaceInvariantError);
  });

  test("create() rejects a personal workspace whose initial member's role isn't admin", async () => {
    await expect(
      store.create("Alice", "user_user_alice", {
        isPersonal: true,
        ownerUserId: "user_alice",
        members: [{ userId: "user_alice", role: "member" }],
      }),
    ).rejects.toBeInstanceOf(PersonalWorkspaceInvariantError);
  });

  test("create() accepts an explicit owner-admin members array (idempotent shape)", async () => {
    // A caller that provides the canonical shape explicitly should
    // succeed — that's normal for round-trip workflows.
    const ws = await store.create("Alice", "user_user_alice", {
      isPersonal: true,
      ownerUserId: "user_alice",
      members: [{ userId: "user_alice", role: "admin" }],
    });
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });
});
