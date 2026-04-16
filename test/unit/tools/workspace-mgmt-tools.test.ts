import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { InlineToolDef } from "../../../src/tools/inline-source.ts";
import {
  createManageWorkspacesTool,
  type ManageWorkspacesContext,
} from "../../../src/tools/workspace-mgmt-tools.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

// ── Helpers ───────────────────────────────────────────────────────

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

function parseResult(result: { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }): unknown {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(extractText(result));
}

// ── Setup ─────────────────────────────────────────────────────────

let workDir: string;
let store: WorkspaceStore;
let tool: InlineToolDef;
let currentIdentity: UserIdentity | null;

function makeCtx(): ManageWorkspacesContext {
  return {
    getIdentity: () => currentIdentity,
    workspaceStore: store,
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-ws-mgmt-test-"));
  store = new WorkspaceStore(workDir);
  currentIdentity = {
    id: "usr_admin000000001",
    email: "admin@example.com",
    displayName: "Admin",
    orgRole: "admin",
  };
  tool = createManageWorkspacesTool(makeCtx());
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("nb__manage_workspaces", () => {
  describe("role enforcement", () => {
    test("admin can create a workspace", async () => {
      const result = await tool.handler({
        action: "create",
        name: "Test Workspace",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { workspace: { id: string; name: string } };
      expect(parsed.workspace.name).toBe("Test Workspace");
    });

    test("owner can create a workspace", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "create",
        name: "Owner Workspace",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { workspace: { name: string } };
      expect(parsed.workspace.name).toBe("Owner Workspace");
    });

    test("member gets permission denied", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "create",
        name: "Forbidden",
      });

      expect(result.isError).toBe(false);
      expect(extractText(result)).toContain("You don't have permission to manage workspaces");
    });

    test("null identity gets permission denied", async () => {
      currentIdentity = null;
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({ action: "list" });

      expect(extractText(result)).toContain("You don't have permission to manage workspaces");
    });
  });

  describe("create", () => {
    test("creates workspace with scaffolded directory", async () => {
      const result = await tool.handler({
        action: "create",
        name: "My Workspace",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        workspace: { id: string; name: string; createdAt: string };
      };
      expect(parsed.workspace.id).toBe("ws_my_workspace");
      expect(parsed.workspace.name).toBe("My Workspace");
      expect(parsed.workspace.createdAt).toBeTruthy();

      // Verify directory was scaffolded
      const wsDir = join(workDir, "workspaces", "ws_my_workspace");
      expect(existsSync(join(wsDir, "data", ".gitkeep"))).toBe(true);
      expect(existsSync(join(wsDir, "skills", ".gitkeep"))).toBe(true);
    });

    test("creates workspace with custom slug", async () => {
      const result = await tool.handler({
        action: "create",
        name: "My Workspace",
        slug: "custom_slug",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { workspace: { id: string } };
      expect(parsed.workspace.id).toBe("ws_custom_slug");
    });

    test("creates workspace with bundles", async () => {
      const result = await tool.handler({
        action: "create",
        name: "Bundle Workspace",
        bundles: [{ name: "@nimblebraininc/echo" }],
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        workspace: { bundles: Array<{ name: string }> };
      };
      expect(parsed.workspace.bundles).toHaveLength(1);
      expect(parsed.workspace.bundles[0].name).toBe("@nimblebraininc/echo");
    });

    test("requires name", async () => {
      const result = await tool.handler({ action: "create" });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("name is required");
    });

    test("returns error for duplicate slug", async () => {
      await tool.handler({ action: "create", name: "Dupe" });
      const result = await tool.handler({ action: "create", name: "Dupe" });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("already exists");
    });
  });

  describe("update", () => {
    test("updates workspace name", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Original",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const updateResult = await tool.handler({
        action: "update",
        workspaceId: created.workspace.id,
        name: "Updated",
      });

      expect(updateResult.isError).toBe(false);
      const updated = parseResult(updateResult) as {
        workspace: { name: string; updatedAt: string };
      };
      expect(updated.workspace.name).toBe("Updated");
    });

    test("updates workspace bundles", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Bundle Update",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const updateResult = await tool.handler({
        action: "update",
        workspaceId: created.workspace.id,
        bundles: [
          { name: "@nimblebraininc/echo" },
          { name: "@nimblebraininc/bash" },
        ],
      });

      expect(updateResult.isError).toBe(false);
      const updated = parseResult(updateResult) as {
        workspace: { bundles: Array<{ name: string }> };
      };
      expect(updated.workspace.bundles).toHaveLength(2);
    });

    test("requires workspaceId", async () => {
      const result = await tool.handler({
        action: "update",
        name: "No ID",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("workspaceId is required");
    });

    test("returns error for non-existent workspace", async () => {
      const result = await tool.handler({
        action: "update",
        workspaceId: "ws_nonexistent",
        name: "Ghost",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Workspace not found");
    });

    test("requires at least one field to update", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Unchanged",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const result = await tool.handler({
        action: "update",
        workspaceId: created.workspace.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("No fields to update");
    });
  });

  describe("delete", () => {
    test("deletes workspace and removes directory", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Deletable",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      const wsDir = join(workDir, "workspaces", created.workspace.id);
      expect(existsSync(wsDir)).toBe(true);

      const deleteResult = await tool.handler({
        action: "delete",
        workspaceId: created.workspace.id,
      });

      expect(deleteResult.isError).toBe(false);
      const parsed = parseResult(deleteResult) as { deleted: boolean; workspaceId: string };
      expect(parsed.deleted).toBe(true);

      // Verify directory is gone
      expect(existsSync(wsDir)).toBe(false);
    });

    test("requires workspaceId", async () => {
      const result = await tool.handler({ action: "delete" });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("workspaceId is required");
    });

    test("returns error for non-existent workspace", async () => {
      const result = await tool.handler({
        action: "delete",
        workspaceId: "ws_nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Workspace not found");
    });
  });

  describe("list", () => {
    test("returns all workspaces with member counts and bundles", async () => {
      await tool.handler({ action: "create", name: "Alpha" });
      await tool.handler({ action: "create", name: "Beta" });

      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as {
        workspaces: Array<{
          id: string;
          name: string;
          memberCount: number;
          bundles: unknown[];
          createdAt: string;
        }>;
      };
      expect(parsed.workspaces).toHaveLength(2);
      expect(parsed.workspaces[0].name).toBe("Alpha");
      expect(parsed.workspaces[0].memberCount).toBe(0);
      expect(parsed.workspaces[0].bundles).toEqual([]);
      expect(parsed.workspaces[1].name).toBe("Beta");
    });

    test("returns empty array when no workspaces exist", async () => {
      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as { workspaces: unknown[] };
      expect(parsed.workspaces).toHaveLength(0);
    });
  });

  describe("unknown action", () => {
    test("returns error for unknown action", async () => {
      const result = await tool.handler({ action: "invalid" });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Unknown action: invalid");
    });
  });
});
