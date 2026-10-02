import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNamespacedToolName } from "../../../src/tools/namespace.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import {
  GENERATED_WORKSPACE_ID_RE,
  WORKSPACE_ID_RE,
} from "../../../src/workspace/workspace-id-pattern.ts";
import {
  generateWorkspaceId,
  MemberConflictError,
  WorkspaceStore,
} from "../../../src/workspace/workspace-store.ts";
import { seedWorkspace } from "../../helpers/test-workspace.ts";

let workDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ws-test-"));
  store = new WorkspaceStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Opaque id generation ───────────────────────────────────────────

describe("generateWorkspaceId", () => {
  test("produces an opaque id matching WORKSPACE_ID_PATTERN", () => {
    const id = generateWorkspaceId();
    expect(WORKSPACE_ID_RE.test(id)).toBe(true);
    // ws_ prefix + 16 lowercase-hex chars (64 bits of entropy).
    expect(id).toMatch(/^ws_[0-9a-f]{16}$/);
  });

  test("never contains a hyphen — the namespace separator (ws_<id>-<tool>)", () => {
    // A hyphen in the id would break `parseNamespacedToolName`, which
    // splits on the first `-`. Assert the alphabet stays hyphen-free.
    for (let i = 0; i < 100; i++) {
      expect(generateWorkspaceId()).not.toContain("-");
    }
  });

  test("round-trips cleanly through namespacedToolName / parse", () => {
    const wsId = generateWorkspaceId();
    const parsed = parseNamespacedToolName(`${wsId}-crm-tool__search`);
    expect(parsed.scope).toEqual({ kind: "workspace", wsId });
    expect(parsed.toolName).toBe("crm-tool__search");
  });

  test("is name-independent — successive calls differ", () => {
    const a = generateWorkspaceId();
    const b = generateWorkspaceId();
    expect(a).not.toBe(b);
  });
});

// ── Id patterns ────────────────────────────────────────────────────

describe("GENERATED_WORKSPACE_ID_RE", () => {
  test("accepts exactly ws_ and 16 lowercase hex chars", () => {
    expect(GENERATED_WORKSPACE_ID_RE.test("ws_3f9a1c7e0b2d4856")).toBe(true);
    for (const id of [
      "ws_3F9A1C7E0B2D4856", // case-sensitive
      "ws_3f9a1c7e0b2d485", // 15 chars
      "ws_3f9a1c7e0b2d48567", // 17 chars
      "ws_3f9a1c7e0b2d485g", // not hex
      "ws_acme_corp",
      "ws_user_usr_alice",
    ]) {
      expect(GENERATED_WORKSPACE_ID_RE.test(id)).toBe(false);
    }
  });

  test("every generated id also satisfies the loading pattern", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateWorkspaceId();
      expect(GENERATED_WORKSPACE_ID_RE.test(id)).toBe(true);
      expect(WORKSPACE_ID_RE.test(id)).toBe(true);
    }
  });

  test("the loading pattern still accepts the legacy forms", () => {
    expect(WORKSPACE_ID_RE.test("ws_acme_corp")).toBe(true);
    expect(WORKSPACE_ID_RE.test("ws_user_usr_alice")).toBe(true);
  });
});

// ── CRUD ───────────────────────────────────────────────────────────

describe("WorkspaceStore CRUD", () => {
  test("create assigns an opaque, name-independent id and writes workspace.json under it", async () => {
    const ws = await store.create("Engineering Team");
    // The id is opaque — NOT derived from the name.
    expect(ws.id).toMatch(/^ws_[0-9a-f]{16}$/);
    expect(ws.id).not.toBe("ws_engineering_team");
    expect(ws.name).toBe("Engineering Team");
    expect(ws.members).toEqual([]);
    expect(ws.connectors).toEqual([]);
    expect(ws.createdAt).toBeTruthy();
    expect(ws.updatedAt).toBeTruthy();

    // workspace.json lives under the opaque id, not a name slug.
    const filePath = join(workDir, "workspaces", ws.id, "workspace.json");
    expect(existsSync(filePath)).toBe(true);
  });

  test("two workspaces with the same name get distinct opaque ids (no slug collision)", async () => {
    const a = await store.create("Engineering");
    const b = await store.create("Engineering");
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe(b.name);
  });

  test("every created id matches the generated pattern", async () => {
    for (let i = 0; i < 20; i++) {
      const ws = await store.create(`Workspace ${i}`);
      expect(ws.id).toMatch(GENERATED_WORKSPACE_ID_RE);
    }
  });

  test("a stray slug argument cannot choose the id", async () => {
    // `create` takes no id. A caller still passing one (a stale call site, an
    // untyped script) lands it in the options slot, where it names nothing.
    const createUntyped = store.create.bind(store) as (...args: unknown[]) => Promise<Workspace>;
    const ws = await createUntyped("My Workspace", "custom_slug");
    expect(ws.id).toMatch(GENERATED_WORKSPACE_ID_RE);
    expect(existsSync(join(workDir, "workspaces", "ws_custom_slug"))).toBe(false);
  });

  test("create refuses an id the generator mints off the generated pattern", async () => {
    // Stands in for a future generator change that drifts from `ws_<16-hex>`.
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(
      "ABCDEF01-2345-6789-ABCD-EF0123456789",
    );
    try {
      await expect(store.create("Drifted")).rejects.toThrow(/does not match/);
    } finally {
      uuid.mockRestore();
    }
    expect(await store.list()).toEqual([]);
  });

  test("a workspace already on disk with a legacy id still loads", async () => {
    // Existing workspaces carry `ws_<slug>` and `ws_user_<id>` ids. `create`
    // never mints them, but `get` and `list` must keep reading them.
    await seedWorkspace(store, "ws_acme_corp", { name: "Acme" });
    await seedWorkspace(store, "ws_user_usr_alice", {
      name: "Alice",
      members: [{ userId: "usr_alice", role: "admin" }],
    });
    expect((await store.get("ws_acme_corp"))?.name).toBe("Acme");
    expect((await store.get("ws_user_usr_alice"))?.members).toEqual([
      { userId: "usr_alice", role: "admin" },
    ]);
    expect((await store.list()).map((w) => w.id).sort()).toEqual([
      "ws_acme_corp",
      "ws_user_usr_alice",
    ]);
    expect((await store.getWorkspacesForUser("usr_alice")).map((w) => w.id)).toEqual([
      "ws_user_usr_alice",
    ]);
  });

  test("get returns workspace by ID", async () => {
    const created = await store.create("Test WS");
    const fetched = await store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("Test WS");
  });

  test("get returns null for non-existent workspace", async () => {
    const result = await store.get("ws_nonexistent");
    expect(result).toBeNull();
  });

  test("list returns all workspaces", async () => {
    await store.create("Alpha");
    await store.create("Beta");
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  test("list orders workspaces sharing a createdAt by id, not by readdir order", async () => {
    // `createdAt` is millisecond-precision, so a same-millisecond group is
    // reachable in production. Stamp the tie rather than race for it.
    const created = [];
    for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]) {
      created.push(await store.create(name));
    }
    const tied = "2026-01-01T00:00:00.000Z";
    for (const ws of created) {
      const path = join(workDir, "workspaces", ws.id, "workspace.json");
      const raw = JSON.parse(await readFile(path, "utf8")) as Workspace;
      await writeFile(path, JSON.stringify({ ...raw, createdAt: tied }, null, 2));
    }

    const ids = (await store.list()).map((w) => w.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("update patches workspace fields", async () => {
    const ws = await store.create("Original");
    // Small delay so updatedAt differs
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(ws.id, { name: "Renamed" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.updatedAt >= ws.updatedAt).toBe(true);
  });

  test("update returns null for non-existent workspace", async () => {
    const result = await store.update("ws_nope", { name: "X" });
    expect(result).toBeNull();
  });

  test("delete removes the directory", async () => {
    const ws = await store.create("ToDelete");
    const dirPath = join(workDir, "workspaces", ws.id);
    expect(existsSync(dirPath)).toBe(true);

    const deleted = await store.delete(ws.id);
    expect(deleted).toBe(true);
    expect(existsSync(dirPath)).toBe(false);
  });

  test("delete returns false for non-existent workspace", async () => {
    const result = await store.delete("ws_ghost");
    expect(result).toBe(false);
  });

  test("create retries past an id that is already taken", async () => {
    // Force the first candidate onto an existing workspace's id; the second
    // candidate is fresh, so create lands there instead of conflicting.
    const taken = await store.create("First");
    const takenHex = taken.id.slice(3);
    const fresh = "0123456789abcdef";
    const uuids = [
      `${takenHex}-0000-0000-0000-000000000000`,
      `${fresh}-0000-0000-0000-000000000000`,
    ];
    const uuid = spyOn(crypto, "randomUUID").mockImplementation(
      () => uuids.shift() as ReturnType<typeof crypto.randomUUID>,
    );
    try {
      const second = await store.create("Second");
      expect(second.id).toBe(`ws_${fresh}`);
    } finally {
      uuid.mockRestore();
    }
  });
});

// ── Member Management ──────────────────────────────────────────────

describe("WorkspaceStore member management", () => {
  test("addMember adds user to workspace members", async () => {
    const ws = await store.create("Team");
    const updated = await store.addMember(ws.id, "usr_abc", "member");
    expect(updated.members).toHaveLength(1);
    expect(updated.members[0]).toEqual({ userId: "usr_abc", role: "member" });
  });

  test("addMember throws on duplicate user", async () => {
    const ws = await store.create("Team");
    await store.addMember(ws.id, "usr_abc", "member");
    await expect(store.addMember(ws.id, "usr_abc", "admin")).rejects.toThrow(MemberConflictError);
  });

  test("removeMember removes user from workspace members", async () => {
    const ws = await store.create("Team");
    await store.addMember(ws.id, "usr_abc", "member");
    await store.addMember(ws.id, "usr_def", "admin");
    const updated = await store.removeMember(ws.id, "usr_abc");
    expect(updated.members).toHaveLength(1);
    expect(updated.members[0].userId).toBe("usr_def");
  });

  test("updateMemberRole changes a member's role", async () => {
    const ws = await store.create("Team");
    await store.addMember(ws.id, "usr_abc", "member");
    const updated = await store.updateMemberRole(ws.id, "usr_abc", "admin");
    expect(updated.members[0]).toEqual({ userId: "usr_abc", role: "admin" });
  });

  test("getWorkspacesForUser returns only workspaces containing that user", async () => {
    const ws1 = await store.create("Team A");
    const ws2 = await store.create("Team B");
    await store.create("Team C");

    await store.addMember(ws1.id, "usr_target", "member");
    await store.addMember(ws2.id, "usr_target", "admin");
    await store.addMember(ws2.id, "usr_other", "member");

    const result = await store.getWorkspacesForUser("usr_target");
    expect(result).toHaveLength(2);
    const ids = result.map((w) => w.id);
    expect(ids).toContain(ws1.id);
    expect(ids).toContain(ws2.id);
  });

  test("getWorkspacesForUser returns empty for unknown user", async () => {
    await store.create("Team");
    const result = await store.getWorkspacesForUser("usr_nobody");
    expect(result).toEqual([]);
  });
});

// ── Extended Fields (skillDirs, models) ───────────────────

describe("WorkspaceStore extended fields", () => {
  test("workspace models override saved and loaded correctly", async () => {
    const ws = await store.create("Model Team");
    const models = { default: "claude-sonnet-4-5-20250929", fast: "claude-haiku-3" };

    const updated = await store.update(ws.id, { models });
    expect(updated).not.toBeNull();
    expect(updated!.models).toEqual(models);

    const loaded = await store.get(ws.id);
    expect(loaded!.models).toEqual(models);
  });

  test("workspace skillDirs saved and loaded correctly", async () => {
    const ws = await store.create("Skill Team");
    const skillDirs = ["/home/user/skills", "./project-skills"];

    const updated = await store.update(ws.id, { skillDirs });
    expect(updated).not.toBeNull();
    expect(updated!.skillDirs).toEqual(skillDirs);

    const loaded = await store.get(ws.id);
    expect(loaded!.skillDirs).toEqual(skillDirs);
  });
});

// ── File permissions ──────────────────────────────────────────────

describe("WorkspaceStore file permissions", () => {
  test("create produces a workspace directory with mode 0o700", async () => {
    const ws = await store.create("Secure Team");
    const wsDir = join(workDir, "workspaces", ws.id);
    const mode = statSync(wsDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("atomicWrite produces a workspace.json file with mode 0o600", async () => {
    const ws = await store.create("Secure File");
    const filePath = join(workDir, "workspaces", ws.id, "workspace.json");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("update rewrites workspace.json preserving 0o600", async () => {
    const ws = await store.create("Rewrite");
    await store.update(ws.id, { name: "Rewrite 2" });
    const filePath = join(workDir, "workspaces", ws.id, "workspace.json");
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ── create ─────────────────────────────────────────────────────────

describe("WorkspaceStore.create", () => {
  test("writes no legacy personal fields", async () => {
    const ws = await store.create("Shared");
    const raw = JSON.parse(
      await readFile(join(workDir, "workspaces", ws.id, "workspace.json"), "utf-8"),
    );
    expect("isPersonal" in raw).toBe(false);
    expect("ownerUserId" in raw).toBe(false);
    expect(ws.about).toBeNull();
  });

  test("persists about when supplied; defaults to null otherwise", async () => {
    const a = await store.create("With About", { about: "Hello" });
    const b = await store.create("Without About");
    expect(a.about).toBe("Hello");
    expect(b.about).toBeNull();
  });
});

describe("WorkspaceStore.update", () => {
  test("renaming a workspace keeps its opaque id and on-disk dir stable", async () => {
    // The core guarantee of opaque ids: the name is freely editable and
    // does NOT move the id, the directory, or (downstream) the URL.
    const ws = await store.create("Original Name");
    const originalId = ws.id;
    const dirPath = join(workDir, "workspaces", originalId);
    expect(existsSync(dirPath)).toBe(true);

    const renamed = await store.update(originalId, { name: "Completely Different Name" });
    expect(renamed?.id).toBe(originalId);
    expect(renamed?.name).toBe("Completely Different Name");

    // The dir under the original opaque id is untouched; no new dir
    // derived from the new name appeared.
    expect(existsSync(dirPath)).toBe(true);
    expect(existsSync(join(workDir, "workspaces", "ws_completely_different_name"))).toBe(false);

    // The renamed workspace is still reachable by its original id.
    const reread = await store.get(originalId);
    expect(reread?.name).toBe("Completely Different Name");
  });

  test("allows patching about", async () => {
    const ws = await store.create("Patch");
    const updated = await store.update(ws.id, { about: "new description" });
    expect(updated?.about).toBe("new description");
  });

  test("drops legacy isPersonal/ownerUserId from the record it writes", async () => {
    const ws = await store.create("Mat's workspace", {
      members: [{ userId: "user_alice", role: "admin" }],
    });
    const file = join(workDir, "workspaces", ws.id, "workspace.json");
    const legacy = {
      ...JSON.parse(await readFile(file, "utf-8")),
      isPersonal: true,
      ownerUserId: "user_alice",
    };
    await writeFile(file, JSON.stringify(legacy));

    const updated = await store.update(ws.id, { about: "hi" });
    expect(updated?.about).toBe("hi");
    const raw = JSON.parse(await readFile(file, "utf-8"));
    expect("isPersonal" in raw).toBe(false);
    expect("ownerUserId" in raw).toBe(false);
    expect(raw.id).toBe(ws.id);
    expect(raw.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("ignores a members patch (membership changes go through the member operations)", async () => {
    const ws = await store.create("Team", {
      members: [{ userId: "user_alice", role: "admin" }],
    });
    // Cast past the Pick<> — the runtime must strip it too.
    const updated = await store.update(ws.id, {
      name: "Team 2",
      members: [{ userId: "user_evil", role: "admin" }],
    } as unknown as { name: string });
    expect(updated?.name).toBe("Team 2");
    expect(updated?.members).toEqual([{ userId: "user_alice", role: "admin" }]);
    expect((await store.get(ws.id))?.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });
});

describe("member operations apply to every workspace", () => {
  test("a workspace created for one user can gain, re-role, and lose members", async () => {
    const ws = await store.create("Mat's workspace", {
      members: [{ userId: "user_mat", role: "admin" }],
    });

    await store.addMember(ws.id, "user_bob", "member");
    await store.updateMemberRole(ws.id, "user_bob", "admin");
    await store.updateMemberRole(ws.id, "user_mat", "member");
    expect((await store.get(ws.id))?.members).toEqual([
      { userId: "user_mat", role: "member" },
      { userId: "user_bob", role: "admin" },
    ]);

    await store.removeMember(ws.id, "user_mat");
    expect((await store.get(ws.id))?.members).toEqual([{ userId: "user_bob", role: "admin" }]);
  });
});

// ── Membership-change subscription ─────────────────────────────────

describe("onMembershipChanged", () => {
  test("fires on create for every initial member", async () => {
    const seen: string[] = [];
    store.onMembershipChanged((userId) => seen.push(userId));

    await store.create("Team", {
      members: [
        { userId: "usr_alice", role: "admin" },
        { userId: "usr_bob", role: "member" },
      ],
    });

    expect(seen).toEqual(["usr_alice", "usr_bob"]);
  });

  test("fires on addMember with the added userId", async () => {
    const ws = await store.create("Team");
    const seen: string[] = [];
    store.onMembershipChanged((userId) => seen.push(userId));

    await store.addMember(ws.id, "usr_charlie", "admin");

    expect(seen).toEqual(["usr_charlie"]);
  });

  test("does not fire on addMember conflict (already a member)", async () => {
    const ws = await store.create("Team", {
      members: [{ userId: "usr_alice", role: "admin" }],
    });
    const seen: string[] = [];
    store.onMembershipChanged((userId) => seen.push(userId));

    await expect(store.addMember(ws.id, "usr_alice", "member")).rejects.toThrow(
      MemberConflictError,
    );
    expect(seen).toEqual([]);
  });

  test("fires on removeMember only when the user was actually a member", async () => {
    const ws = await store.create("Team", {
      members: [{ userId: "usr_alice", role: "admin" }],
    });
    const seen: string[] = [];
    store.onMembershipChanged((userId) => seen.push(userId));

    // Real removal — fires.
    await store.removeMember(ws.id, "usr_alice");
    expect(seen).toEqual(["usr_alice"]);

    // No-op removal of a non-member — does not fire. Spurious
    // invalidations would churn every connected client's membership
    // cache on the SSE side.
    await store.removeMember(ws.id, "usr_ghost");
    expect(seen).toEqual(["usr_alice"]);
  });

  test("fires on delete for every former member", async () => {
    const ws = await store.create("Team", {
      members: [
        { userId: "usr_alice", role: "admin" },
        { userId: "usr_bob", role: "member" },
      ],
    });
    const seen: string[] = [];
    store.onMembershipChanged((userId) => seen.push(userId));

    const ok = await store.delete(ws.id);
    expect(ok).toBe(true);
    expect(seen.sort()).toEqual(["usr_alice", "usr_bob"]);
  });

  test("does not fire on updateMemberRole (role changes don't affect set membership)", async () => {
    const ws = await store.create("Team", {
      members: [{ userId: "usr_alice", role: "member" }],
    });
    const seen: string[] = [];
    store.onMembershipChanged((userId) => seen.push(userId));

    await store.updateMemberRole(ws.id, "usr_alice", "admin");

    expect(seen).toEqual([]);
  });

  test("unsubscribe stops further notifications", async () => {
    const ws = await store.create("Team");
    const seen: string[] = [];
    const unsub = store.onMembershipChanged((userId) => seen.push(userId));

    await store.addMember(ws.id, "usr_a", "admin");
    unsub();
    await store.addMember(ws.id, "usr_b", "admin");

    expect(seen).toEqual(["usr_a"]);
  });

  test("a throwing handler doesn't break the mutation or other handlers", async () => {
    const ws = await store.create("Team");
    const seen: string[] = [];
    store.onMembershipChanged(() => {
      throw new Error("boom");
    });
    store.onMembershipChanged((userId) => seen.push(userId));

    // Mutation succeeds despite the throwing handler.
    const updated = await store.addMember(ws.id, "usr_alice", "admin");
    expect(updated.members.some((m) => m.userId === "usr_alice")).toBe(true);
    // Non-throwing handler still ran.
    expect(seen).toEqual(["usr_alice"]);
  });
});
