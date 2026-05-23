import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../../src/runtime/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import {
  MemberConflictError,
  personalWorkspaceIdFor,
  personalWorkspaceSlugFor,
  slugify,
  WorkspaceConflictError,
  WorkspaceStore,
} from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ws-test-"));
  store = new WorkspaceStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Slugification ──────────────────────────────────────────────────

describe("slugify", () => {
  test("converts spaces to underscores and lowercases", () => {
    expect(slugify("Engineering Team")).toBe("engineering_team");
  });

  test("converts hyphens to underscores", () => {
    expect(slugify("my-workspace")).toBe("my_workspace");
  });

  test("strips non-alphanumeric characters", () => {
    expect(slugify("Hello World! #1")).toBe("hello_world_1");
  });
});

// ── CRUD ───────────────────────────────────────────────────────────

describe("WorkspaceStore CRUD", () => {
  test("create writes workspace.json to correct directory", async () => {
    const ws = await store.create("Engineering Team");
    expect(ws.id).toBe("ws_engineering_team");
    expect(ws.name).toBe("Engineering Team");
    expect(ws.members).toEqual([]);
    expect(ws.bundles).toEqual([]);
    expect(ws.createdAt).toBeTruthy();
    expect(ws.updatedAt).toBeTruthy();

    const filePath = join(
      workDir,
      "workspaces",
      "ws_engineering_team",
      "workspace.json",
    );
    expect(existsSync(filePath)).toBe(true);
  });

  test("create with explicit slug", async () => {
    const ws = await store.create("My Workspace", "custom_slug");
    expect(ws.id).toBe("ws_custom_slug");
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

  test("duplicate slug on create throws conflict error", async () => {
    await store.create("Duplicate");
    await expect(store.create("Duplicate")).rejects.toThrow(
      WorkspaceConflictError,
    );
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
    await expect(store.addMember(ws.id, "usr_abc", "admin")).rejects.toThrow(
      MemberConflictError,
    );
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
    const ws1 = await store.create("Team A", "team_a");
    const ws2 = await store.create("Team B", "team_b");
    await store.create("Team C", "team_c");

    await store.addMember(ws1.id, "usr_target", "member");
    await store.addMember(ws2.id, "usr_target", "admin");
    await store.addMember(ws2.id, "usr_other", "member");

    const result = await store.getWorkspacesForUser("usr_target");
    expect(result).toHaveLength(2);
    const ids = result.map((w) => w.id);
    expect(ids).toContain("ws_team_a");
    expect(ids).toContain("ws_team_b");
  });

  test("getWorkspacesForUser returns empty for unknown user", async () => {
    await store.create("Team");
    const result = await store.getWorkspacesForUser("usr_nobody");
    expect(result).toEqual([]);
  });
});

// ── Extended Fields (agents, skillDirs, models) ───────────────────

describe("WorkspaceStore extended fields", () => {
  test("workspace with agents persists and loads correctly", async () => {
    const ws = await store.create("Agent Team");
    const agents: Record<string, AgentProfile> = {
      researcher: {
        description: "Deep research agent",
        systemPrompt: "You are a research agent.",
        tools: ["search__*"],
        maxIterations: 8,
        model: "claude-sonnet-4-5-20250929",
      },
    };

    const updated = await store.update(ws.id, { agents });
    expect(updated).not.toBeNull();
    expect(updated!.agents).toEqual(agents);

    // Re-read from disk to confirm persistence
    const loaded = await store.get(ws.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.agents).toEqual(agents);
    expect(loaded!.agents!.researcher.tools).toEqual(["search__*"]);
  });

  test("workspace with no agents omits the field", async () => {
    const ws = await store.create("Plain");
    const filePath = join(
      workDir,
      "workspaces",
      ws.id,
      "workspace.json",
    );
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    expect(raw.agents).toBeUndefined();
  });

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

// ── Personal workspace helper + co-required invariant ─────────────

describe("personalWorkspaceIdFor / personalWorkspaceSlugFor", () => {
  test("constructs ws_user_<userId> with the full user id preserved", () => {
    // The full user id (including the provider prefix) is concatenated
    // verbatim. This is the "dumb concat" rule — see the helper's
    // docblock for why we don't strip prefixes.
    expect(personalWorkspaceIdFor("user_abc123")).toBe("ws_user_user_abc123");
    expect(personalWorkspaceIdFor("usr_default")).toBe("ws_user_usr_default");
  });

  test("slug form is the id without the ws_ prefix — round-trips through create", async () => {
    const slug = personalWorkspaceSlugFor("user_alice");
    expect(slug).toBe("user_user_alice");

    const ws = await store.create("Alice", slug, {
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    expect(ws.id).toBe(personalWorkspaceIdFor("user_alice"));
  });

  test("rejects empty / non-string userId", () => {
    expect(() => personalWorkspaceIdFor("")).toThrow(/userId is required/);
    expect(() => personalWorkspaceIdFor(undefined as unknown as string)).toThrow(/userId is required/);
  });
});

describe("WorkspaceStore.create: isPersonal/ownerUserId invariants", () => {
  test("defaults isPersonal to false and ownerUserId to undefined", async () => {
    const ws = await store.create("Shared");
    expect(ws.isPersonal).toBe(false);
    expect(ws.ownerUserId).toBeUndefined();
    expect(ws.about).toBeNull();
  });

  test("persists isPersonal + ownerUserId when supplied together", async () => {
    const ws = await store.create("Alice", "user_user_alice", {
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");

    // Round-trip through disk.
    const readBack = await store.get(ws.id);
    expect(readBack?.isPersonal).toBe(true);
    expect(readBack?.ownerUserId).toBe("user_alice");
  });

  test("rejects isPersonal=true without ownerUserId", async () => {
    await expect(
      store.create("Bad", "user_user_x", { isPersonal: true }),
    ).rejects.toThrow(/isPersonal=true requires ownerUserId/);
  });

  test("rejects ownerUserId without isPersonal=true", async () => {
    await expect(
      store.create("Bad", "shared", { ownerUserId: "user_alice" }),
    ).rejects.toThrow(/ownerUserId is only valid with isPersonal=true/);
  });

  test("persists about when supplied; defaults to null otherwise", async () => {
    const a = await store.create("With About", "with_about", { about: "Hello" });
    const b = await store.create("Without About", "without_about");
    expect(a.about).toBe("Hello");
    expect(b.about).toBeNull();
  });
});

describe("WorkspaceStore.update", () => {
  test("allows patching about", async () => {
    const ws = await store.create("Patch", "patch");
    const updated = await store.update(ws.id, { about: "new description" });
    expect(updated?.about).toBe("new description");
  });

  test("throws PersonalWorkspaceInvariantError on attempted writes to isPersonal/ownerUserId (Stage 1.1)", async () => {
    const ws = await store.create("Alice", "user_user_alice", {
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    // Cast to bypass the Pick<> at the type level — runtime must throw
    // loudly instead of silently stripping the disallowed keys. The
    // silent-strip behavior is what produced multi-admin personal
    // workspaces in production; Stage 1.1 replaces it with a typed
    // error. Exhaustive invariant coverage lives in
    // `personal-workspace-invariants.test.ts`.
    await expect(
      store.update(ws.id, {
        isPersonal: false,
        ownerUserId: "user_evil",
      } as unknown as { name: string }),
    ).rejects.toThrow(/personal-workspace invariant/i);
  });
});
