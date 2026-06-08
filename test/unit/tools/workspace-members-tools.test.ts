import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { User } from "../../../src/identity/user.ts";
import { UserStore } from "../../../src/identity/user.ts";
import type { InProcessTool } from "../../../src/tools/in-process-app.ts";
import {
  createManageMembersTool,
  type ManageMembersContext,
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
let wsStore: WorkspaceStore;
let userStore: UserStore;
let tool: InProcessTool;
let currentIdentity: UserIdentity | null;

// Pre-created users for tests
let memberUser: User;
let anotherUser: User;

function makeCtx(): ManageMembersContext {
  return {
    getIdentity: () => currentIdentity,
    workspaceStore: wsStore,
    userStore,
  };
}

// Create a workspace with the current identity seated as a workspace admin
// member. STRICT authz (canWriteWorkspaceScoped) requires the requester to be
// a workspace admin member — org role grants no bypass — so the requester must
// be a member of any workspace it manages.
async function createWsAsAdmin(name: string) {
  const ws = await wsStore.create(name);
  if (currentIdentity) {
    await wsStore.addMember(ws.id, currentIdentity.id, "admin");
  }
  return ws;
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-members-test-"));
  wsStore = new WorkspaceStore(workDir);
  userStore = new UserStore(workDir);

  // Create test users
  memberUser = await userStore.create({
    email: "member@example.com",
    displayName: "Member User",
    orgRole: "member",
  });
  anotherUser = await userStore.create({
    email: "another@example.com",
    displayName: "Another User",
    orgRole: "member",
  });

  // Default identity: org admin
  currentIdentity = {
    id: "usr_admin000000001",
    email: "admin@example.com",
    displayName: "Admin",
    orgRole: "admin",
  };

  tool = createManageMembersTool(makeCtx());
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("nb__manage_members", () => {
  describe("add", () => {
    test("workspace admin adds a member", async () => {
      // Create workspace and add the requesting user as workspace admin
      const ws = await wsStore.create("Team Alpha");
      await wsStore.addMember(ws.id, "usr_wsadmin0000001", "admin");

      // Switch identity to workspace admin (not org admin)
      currentIdentity = {
        id: "usr_wsadmin0000001",
        email: "wsadmin@example.com",
        displayName: "WS Admin",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        added: { userId: string; role: string };
        workspace: { id: string; memberCount: number };
      };
      expect(parsed.added.userId).toBe(memberUser.id);
      expect(parsed.added.role).toBe("member");
      expect(parsed.workspace.memberCount).toBe(2); // wsadmin + member
    });

    test("org admin who is NOT a member is denied (no org-admin bypass)", async () => {
      // STRICT authz: org role grants no bypass. The default identity is an
      // org admin but not a member of this workspace, so member management is
      // denied even though they could create/manage workspaces org-wide.
      const ws = await wsStore.create("Team Beta");

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(extractText(result)).toContain("don't have permission");
    });

    test("add with explicit admin role", async () => {
      const ws = await createWsAsAdmin("Team Gamma");

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "admin",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        added: { userId: string; role: string };
      };
      expect(parsed.added.role).toBe("admin");
    });

    test("adding non-existent user returns 'User not found'", async () => {
      const ws = await createWsAsAdmin("Team Delta");

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
        userId: "usr_nonexistent0001",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toBe("User not found");
    });

    test("requires userId", async () => {
      const ws = await createWsAsAdmin("Team Epsilon");

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("userId is required");
    });
  });

  describe("remove", () => {
    test("workspace admin removes a member", async () => {
      const ws = await wsStore.create("Team Remove");
      await wsStore.addMember(ws.id, "usr_wsadmin0000001", "admin");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      // Act as workspace admin
      currentIdentity = {
        id: "usr_wsadmin0000001",
        email: "wsadmin@example.com",
        displayName: "WS Admin",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "remove",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        removed: { userId: string };
        workspace: { memberCount: number };
      };
      expect(parsed.removed.userId).toBe(memberUser.id);
      expect(parsed.workspace.memberCount).toBe(1);
    });

    test("cannot remove last workspace admin", async () => {
      // memberUser is the sole workspace admin and acts as the requester.
      const ws = await wsStore.create("Team LastAdmin");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "remove",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Cannot remove the last workspace admin");
    });

    test("can remove admin when another admin exists", async () => {
      // Requester (default identity) is seated as an admin; memberUser is a
      // second admin, so removing memberUser leaves an admin behind.
      const ws = await createWsAsAdmin("Team TwoAdmins");
      await wsStore.addMember(ws.id, memberUser.id, "admin");

      const result = await tool.handler({
        action: "remove",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(false);
    });

    test("cannot remove the last active admin when the other admin is deactivated", async () => {
      // memberUser is the only ACTIVE admin and acts as the requester.
      // anotherUser is an admin on paper but deactivated — they can't act, so
      // they don't count.
      const ws = await wsStore.create("Team DeactivatedCoAdmin");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "admin");
      await userStore.softDelete(anotherUser.id);
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "remove",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Cannot remove the last workspace admin");
    });

    test("can remove a deactivated admin even though it is an admin entry", async () => {
      // memberUser is the active admin requester; anotherUser is a deactivated
      // admin. Removing the deactivated admin is safe — the active admin remains.
      const ws = await wsStore.create("Team RemoveDeactivated");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "admin");
      await userStore.softDelete(anotherUser.id);
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "remove",
        workspaceId: ws.id,
        userId: anotherUser.id,
      });

      expect(result.isError).toBe(false);
    });

    test("removing non-member returns error", async () => {
      const ws = await createWsAsAdmin("Team NoMember");

      const result = await tool.handler({
        action: "remove",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("is not a member");
    });
  });

  describe("update", () => {
    test("updating role from member to admin works", async () => {
      const ws = await createWsAsAdmin("Team Update");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      const result = await tool.handler({
        action: "update",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "admin",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        updated: { userId: string; role: string };
      };
      expect(parsed.updated.role).toBe("admin");
    });

    test("cannot demote last workspace admin", async () => {
      // memberUser is the sole admin and acts as the requester.
      const ws = await wsStore.create("Team DemoteLast");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "update",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "member",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Cannot demote the last workspace admin");
    });

    test("cannot demote the last active admin when the other admin is deactivated", async () => {
      // memberUser is the only ACTIVE admin and acts as the requester.
      const ws = await wsStore.create("Team DemoteActiveLast");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "admin");
      await userStore.softDelete(anotherUser.id);
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "update",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "member",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Cannot demote the last workspace admin");
    });

    test("requires role", async () => {
      const ws = await createWsAsAdmin("Team NoRole");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      const result = await tool.handler({
        action: "update",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("role is required");
    });

    test("requires userId", async () => {
      const ws = await createWsAsAdmin("Team NoUser");

      const result = await tool.handler({
        action: "update",
        workspaceId: ws.id,
        role: "admin",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("userId is required");
    });
  });

  describe("list", () => {
    test("returns member list with roles", async () => {
      const ws = await wsStore.create("Team List");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "member");
      // Requester must be a workspace admin member; memberUser fills that role.
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "list",
        workspaceId: ws.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        workspaceId: string;
        members: Array<{ userId: string; role: string }>;
      };
      expect(parsed.workspaceId).toBe(ws.id);
      expect(parsed.members).toHaveLength(2);
      expect(parsed.members[0]).toMatchObject({ userId: memberUser.id, role: "admin" });
      expect(parsed.members[1]).toMatchObject({ userId: anotherUser.id, role: "member" });
    });

    test("surfaces deletedAt for deactivated members", async () => {
      const ws = await wsStore.create("Team ListDeactivated");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "member");
      await userStore.softDelete(anotherUser.id);
      // memberUser (active admin) acts as the requester.
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({ action: "list", workspaceId: ws.id });

      const parsed = parseResult(result) as {
        members: Array<{ userId: string; deletedAt?: string }>;
      };
      const active = parsed.members.find((m) => m.userId === memberUser.id);
      const deactivated = parsed.members.find((m) => m.userId === anotherUser.id);
      expect(active?.deletedAt).toBeUndefined();
      expect(deactivated?.deletedAt).toBeTruthy();
    });

    test("lists only the requesting admin in a workspace with one member", async () => {
      // Under strict authz a manager must be a workspace admin member, so the
      // smallest manageable workspace has exactly that one member.
      const ws = await createWsAsAdmin("Team Solo");

      const result = await tool.handler({
        action: "list",
        workspaceId: ws.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        members: Array<{ userId: string; role: string }>;
      };
      expect(parsed.members).toHaveLength(1);
      expect(parsed.members[0]).toMatchObject({
        userId: currentIdentity!.id,
        role: "admin",
      });
    });

    test("non-member is denied listing a non-existent workspace", async () => {
      // canManageMembers now gates on membership first: a missing workspace is
      // indistinguishable from one the requester can't manage — both deny.
      const result = await tool.handler({
        action: "list",
        workspaceId: "ws_nonexistent",
      });

      expect(extractText(result)).toContain("don't have permission");
    });
  });

  describe("role enforcement", () => {
    test("non-admin cannot manage members", async () => {
      const ws = await wsStore.create("Team Restricted");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      // Regular member (not workspace admin, not org admin)
      currentIdentity = {
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member",
        orgRole: "member",
      };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "list",
        workspaceId: ws.id,
      });

      expect(result.isError).toBe(false);
      expect(extractText(result)).toContain("don't have permission");
    });

    test("null identity gets permission denied", async () => {
      const ws = await wsStore.create("Team Null");
      currentIdentity = null;
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "list",
        workspaceId: ws.id,
      });

      expect(extractText(result)).toContain("don't have permission");
    });

    test("org owner who is NOT a member is denied (no org-owner bypass)", async () => {
      // Behavior change under STRICT authz: org owner no longer bypasses
      // workspace membership. An org owner who is not a workspace admin member
      // cannot manage that workspace's members.
      const ws = await wsStore.create("Team Owner");

      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(extractText(result)).toContain("don't have permission");
    });

    test("org owner who IS a workspace admin member can manage members", async () => {
      // The escape hatch: an org owner gains access by being added as a
      // workspace admin member, not via org role.
      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      const ws = await createWsAsAdmin("Team OwnerMember");
      tool = createManageMembersTool(makeCtx());

      const result = await tool.handler({
        action: "add",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(false);
    });
  });

  describe("unknown action", () => {
    test("returns error for unknown action", async () => {
      const ws = await createWsAsAdmin("Team Unknown");

      const result = await tool.handler({
        action: "invalid",
        workspaceId: ws.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("Unknown action: invalid");
    });
  });
});
