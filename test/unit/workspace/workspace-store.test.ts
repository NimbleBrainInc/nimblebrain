import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../../src/runtime/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import {
  MemberConflictError,
  WorkspaceConflictError,
  WorkspaceStore,
  slugify,
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
