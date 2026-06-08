import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { User } from "../../../src/identity/user.ts";
import { UserStore } from "../../../src/identity/user.ts";
import type { InProcessTool } from "../../../src/tools/in-process-app.ts";
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
let userStore: UserStore;
let tool: InProcessTool;
let currentIdentity: UserIdentity | null;

function makeCtx(): ManageWorkspacesContext {
  return {
    getIdentity: () => currentIdentity,
    workspaceStore: store,
    userStore,
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-ws-mgmt-test-"));
  store = new WorkspaceStore(workDir);
  userStore = new UserStore(workDir);
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
      // The id is opaque and name-independent — NOT derived from the name.
      expect(parsed.workspace.id).toMatch(/^ws_[0-9a-f]{16}$/);
      expect(parsed.workspace.name).toBe("My Workspace");
      expect(parsed.workspace.createdAt).toBeTruthy();

      // Verify directory was scaffolded under the opaque id.
      const wsDir = join(workDir, "workspaces", parsed.workspace.id);
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

    test("returns error for duplicate explicit slug", async () => {
      // Opaque ids never collide on name, so two same-name creates now
      // succeed with distinct ids. The conflict path is exercised via an
      // explicit slug that targets an already-taken id.
      await tool.handler({ action: "create", name: "Dupe", slug: "dupe_slug" });
      const result = await tool.handler({ action: "create", name: "Dupe Two", slug: "dupe_slug" });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("already exists");
    });
  });

  describe("creator seating (deadlock fix)", () => {
    test("creating a shared workspace seats the creator as an admin member", async () => {
      const createResult = await tool.handler({
        action: "create",
        name: "Seated Workspace",
      });

      expect(createResult.isError).toBe(false);
      const created = parseResult(createResult) as {
        workspace: { id: string; memberCount: number };
      };
      // The success response reflects the seated member.
      expect(created.workspace.memberCount).toBe(1);

      // The persisted workspace has the creator seated as an admin member.
      const ws = await store.get(created.workspace.id);
      expect(ws?.members).toEqual([{ userId: currentIdentity!.id, role: "admin" }]);
    });

    test("creator can immediately manage members of the new workspace via the strict workspace-admin path", async () => {
      // The creator is an org admin at create time (create requires it), and a
      // user record so they could be added/removed.
      const creator: User = await userStore.create({
        email: "creator@example.com",
        displayName: "Creator",
        orgRole: "admin",
      });
      const newMember: User = await userStore.create({
        email: "newmember@example.com",
        displayName: "New Member",
        orgRole: "member",
      });

      currentIdentity = {
        id: creator.id,
        email: creator.email,
        displayName: creator.displayName,
        orgRole: "admin",
      };
      tool = createManageWorkspacesTool(makeCtx());

      const createResult = await tool.handler({
        action: "create",
        name: "Creator Managed",
      });
      const created = parseResult(createResult) as { workspace: { id: string } };

      // Drop the org-admin role entirely — the creator now relies SOLELY on
      // their seated workspace-admin membership. This is the strict-policy
      // world where the org-admin bypass is gone. Without seating, this path
      // would deadlock (canManageMembers would return false).
      currentIdentity = { ...currentIdentity, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      const addResult = await tool.handler({
        action: "add_member",
        workspaceId: created.workspace.id,
        userId: newMember.id,
      });

      expect(addResult.isError).toBe(false);
      const added = parseResult(addResult) as {
        added: { userId: string; role: string };
        workspace: { memberCount: number };
      };
      expect(added.added.userId).toBe(newMember.id);
      // creator (admin, seated on create) + newMember.
      expect(added.workspace.memberCount).toBe(2);
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
      const sorted = [...parsed.workspaces].sort((a, b) => a.name.localeCompare(b.name));
      expect(sorted[0].name).toBe("Alpha");
      // The creator is auto-seated as an admin member on create, so each
      // freshly created shared workspace starts with exactly one member.
      expect(sorted[0].memberCount).toBe(1);
      expect(sorted[0].bundles).toEqual([]);
      expect(sorted[1].name).toBe("Beta");
    });

    test("returns empty array when no workspaces exist", async () => {
      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as { workspaces: unknown[] };
      expect(parsed.workspaces).toHaveLength(0);
    });
  });

  describe("claim_admin (stranded-workspace recovery)", () => {
    test("org admin claims admin on a membered shared workspace that has no admin", async () => {
      // A shared workspace populated only with default-role members under the
      // old org-admin bypass — no admin member. This is the stranded state.
      const ws = await store.create("Stranded");
      await store.addMember(ws.id, "usr_member00000001", "member");

      const result = await tool.handler({ action: "claim_admin", workspaceId: ws.id });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        workspace: { memberCount: number };
        claimedAdmin: { userId: string };
      };
      expect(parsed.claimedAdmin.userId).toBe(currentIdentity!.id);
      expect(parsed.workspace.memberCount).toBe(2);

      const persisted = await store.get(ws.id);
      expect(persisted?.members.find((m) => m.userId === currentIdentity!.id)?.role).toBe("admin");
    });

    test("recovery restores manageability: after claim_admin the operator can manage members with org role dropped", async () => {
      const member: User = await userStore.create({
        email: "m@example.com",
        displayName: "M",
        orgRole: "member",
      });
      const ws = await store.create("Stranded");
      // Seat the future operator as a plain member to exercise the promote path.
      await store.addMember(ws.id, currentIdentity!.id, "member");

      const claim = await tool.handler({ action: "claim_admin", workspaceId: ws.id });
      expect(claim.isError).toBe(false);
      // Promotion in place — no duplicate member row.
      expect((parseResult(claim) as { workspace: { memberCount: number } }).workspace.memberCount).toBe(1);

      // Drop org-admin entirely; the operator now relies solely on the seated
      // workspace-admin membership the recovery granted.
      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      const add = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
        userId: member.id,
      });
      expect(add.isError).toBe(false);
      expect((parseResult(add) as { workspace: { memberCount: number } }).workspace.memberCount).toBe(2);
    });

    test("claim_admin seats the operator as first admin of a memberless shared workspace", async () => {
      const ws = await store.create("Empty");

      const result = await tool.handler({ action: "claim_admin", workspaceId: ws.id });

      expect(result.isError).toBe(false);
      expect((parseResult(result) as { workspace: { memberCount: number } }).workspace.memberCount).toBe(1);
    });

    test("refuses when the workspace already has an admin (not a backdoor into healthy workspaces)", async () => {
      const ws = await store.create("Healthy");
      await store.addMember(ws.id, "usr_other00000001", "admin");

      const result = await tool.handler({ action: "claim_admin", workspaceId: ws.id });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("already has an admin");
      // The operator was NOT seated.
      const persisted = await store.get(ws.id);
      expect(persisted?.members.some((m) => m.userId === currentIdentity!.id)).toBe(false);
    });

    test("refuses on a personal workspace", async () => {
      const ws = await store.create("Personal", "personal_usr_owner0001", {
        isPersonal: true,
        ownerUserId: "usr_owner0001",
      });

      const result = await tool.handler({ action: "claim_admin", workspaceId: ws.id });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Personal workspaces");
    });

    test("non-org-admin cannot claim_admin", async () => {
      const ws = await store.create("Stranded");
      await store.addMember(ws.id, "usr_member00000001", "member");

      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({ action: "claim_admin", workspaceId: ws.id });

      expect(extractText(result)).toContain("don't have permission");
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
