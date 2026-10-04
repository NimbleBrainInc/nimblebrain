import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { User } from "../../../src/identity/user.ts";
import { UserStore } from "../../../src/identity/user.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import type { InProcessTool } from "../../../src/tools/in-process-app.ts";
import {
  createManageWorkspacesTool,
  type ManageWorkspacesContext,
} from "../../../src/tools/workspace-mgmt-tools.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import { makeIdentity } from "../../helpers/identity.ts";
import { parseResult, resultText } from "../../helpers/tool-result.ts";

// ── Helpers ───────────────────────────────────────────────────────

// ── Setup ─────────────────────────────────────────────────────────

let workDir: string;
let wsStore: WorkspaceStore;
let userStore: UserStore;
let tool: InProcessTool;
let currentIdentity: UserIdentity | null;

// Pre-created users for tests
let memberUser: User;
let anotherUser: User;

function makeCtx(): ManageWorkspacesContext {
  return {
    getIdentity: () => currentIdentity,
    workspaceStore: wsStore,
    // Member management never reaches the runtime — only `delete` does, and
    // that is `manage_workspaces`' own test. A stub that would throw if a
    // member handler ever grew a runtime read is the point.
    runtime: {} as Runtime,
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
  currentIdentity = makeIdentity({
    id: "usr_admin000000001",
    email: "admin@example.com",
    displayName: "Admin",
    orgRole: "admin",
  });

  tool = createManageWorkspacesTool(makeCtx());
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("nb__manage_workspaces member actions", () => {
  describe("add", () => {
    test("workspace admin adds a member", async () => {
      // Create workspace and add the requesting user as workspace admin
      const ws = await wsStore.create("Team Alpha");
      await wsStore.addMember(ws.id, "usr_wsadmin0000001", "admin");

      // Switch identity to workspace admin (not org admin)
      currentIdentity = makeIdentity({
        id: "usr_wsadmin0000001",
        email: "wsadmin@example.com",
        displayName: "WS Admin",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "add_member",
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

    test("org admin who is NOT a member can add a member", async () => {
      // Membership is governed at org scope: the default identity is an org
      // admin with no seat in this workspace, and may still manage its roster.
      const ws = await wsStore.create("Team Beta");

      const result = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { added: { userId: string; role: string } };
      expect(parsed.added).toEqual({ userId: memberUser.id, role: "member" });
      // Managing the roster does not seat the org admin.
      const after = await wsStore.get(ws.id);
      expect(after!.members.map((m) => m.userId)).toEqual([memberUser.id]);
    });

    test("add with explicit admin role", async () => {
      const ws = await createWsAsAdmin("Team Gamma");

      const result = await tool.handler({
        action: "add_member",
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
        action: "add_member",
        workspaceId: ws.id,
        userId: "usr_nonexistent0001",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("User not found");
    });

    test("requires userId or email", async () => {
      const ws = await createWsAsAdmin("Team Epsilon");

      const result = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("userId or email is required");
    });

    test("a workspace admin who cannot list users adds someone by email, in any case", async () => {
      const ws = await wsStore.create("Team Email");
      await wsStore.addMember(ws.id, "usr_wsadmin0000001", "admin");
      currentIdentity = makeIdentity({
        id: "usr_wsadmin0000001",
        email: "wsadmin@example.com",
        displayName: "WS Admin",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
        email: "  Member@Example.com ",
        role: "admin",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { added: { userId: string; role: string } };
      expect(parsed.added).toEqual({ userId: memberUser.id, role: "admin" });
    });

    test("an email no active person in the org has is refused, and seats no one", async () => {
      const ws = await createWsAsAdmin("Team Unknown");
      await userStore.softDelete(anotherUser.id);

      for (const email of ["nobody@example.com", "another@example.com"]) {
        const result = await tool.handler({ action: "add_member", workspaceId: ws.id, email });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain("No one in this organization has the email");
      }
      const after = await wsStore.get(ws.id);
      expect(after!.members.map((m) => m.userId)).toEqual([currentIdentity!.id]);
    });
  });

  describe("remove", () => {
    test("workspace admin removes a member", async () => {
      const ws = await wsStore.create("Team Remove");
      await wsStore.addMember(ws.id, "usr_wsadmin0000001", "admin");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      // Act as workspace admin
      currentIdentity = makeIdentity({
        id: "usr_wsadmin0000001",
        email: "wsadmin@example.com",
        displayName: "WS Admin",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "remove_member",
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
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "remove_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Cannot remove the last workspace admin");
    });

    test("can remove admin when another admin exists", async () => {
      // Requester (default identity) is seated as an admin; memberUser is a
      // second admin, so removing memberUser leaves an admin behind.
      const ws = await createWsAsAdmin("Team TwoAdmins");
      await wsStore.addMember(ws.id, memberUser.id, "admin");

      const result = await tool.handler({
        action: "remove_member",
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
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "remove_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Cannot remove the last workspace admin");
    });

    test("can remove a deactivated admin even though it is an admin entry", async () => {
      // memberUser is the active admin requester; anotherUser is a deactivated
      // admin. Removing the deactivated admin is safe — the active admin remains.
      const ws = await wsStore.create("Team RemoveDeactivated");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "admin");
      await userStore.softDelete(anotherUser.id);
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "remove_member",
        workspaceId: ws.id,
        userId: anotherUser.id,
      });

      expect(result.isError).toBe(false);
    });

    test("removing non-member returns error", async () => {
      const ws = await createWsAsAdmin("Team NoMember");

      const result = await tool.handler({
        action: "remove_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("is not a member");
    });
  });

  describe("update", () => {
    test("updating role from member to admin works", async () => {
      const ws = await createWsAsAdmin("Team Update");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      const result = await tool.handler({
        action: "update_member",
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
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "member",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Cannot demote the last workspace admin");
    });

    test("cannot demote the last active admin when the other admin is deactivated", async () => {
      // memberUser is the only ACTIVE admin and acts as the requester.
      const ws = await wsStore.create("Team DemoteActiveLast");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "admin");
      await userStore.softDelete(anotherUser.id);
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "member",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Cannot demote the last workspace admin");
    });

    test("requires role", async () => {
      const ws = await createWsAsAdmin("Team NoRole");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      const result = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("role is required");
    });

    test("requires userId", async () => {
      const ws = await createWsAsAdmin("Team NoUser");

      const result = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        role: "admin",
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("userId is required");
    });
  });

  describe("list", () => {
    test("returns member list with roles", async () => {
      const ws = await wsStore.create("Team List");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "member");
      // Requester must be a workspace admin member; memberUser fills that role.
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "list_members",
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
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member User",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({ action: "list_members", workspaceId: ws.id });

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
        action: "list_members",
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
      // memberActionAllowed gates on membership first: a missing workspace is
      // indistinguishable from one the requester can't manage — both deny.
      const result = await tool.handler({
        action: "list_members",
        workspaceId: "ws_004f1f715b791487",
      });

      expect(resultText(result)).toContain("don't have permission");
    });
  });

  describe("role enforcement", () => {
    test("a plain member can list the roster but not change it", async () => {
      const ws = await wsStore.create("Team Restricted");
      await wsStore.addMember(ws.id, memberUser.id, "member");

      // Regular member (not workspace admin, not org admin)
      currentIdentity = makeIdentity({
        id: memberUser.id,
        email: "member@example.com",
        displayName: "Member",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const listed = await tool.handler({ action: "list_members", workspaceId: ws.id });
      expect(listed.isError).toBe(false);
      const parsed = parseResult(listed) as {
        members: Array<{ userId: string; displayName: string }>;
      };
      expect(parsed.members).toEqual([
        expect.objectContaining({ userId: memberUser.id, displayName: "Member User" }),
      ]);

      const added = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
        userId: anotherUser.id,
      });
      expect(resultText(added)).toContain("don't have permission");
      expect((await wsStore.get(ws.id))!.members).toHaveLength(1);
    });

    test("someone outside the workspace cannot list its roster", async () => {
      const ws = await wsStore.create("Team Closed");
      await wsStore.addMember(ws.id, memberUser.id, "member");
      currentIdentity = makeIdentity({
        id: anotherUser.id,
        email: "another@example.com",
        displayName: "Another",
        orgRole: "member",
      });
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({ action: "list_members", workspaceId: ws.id });
      expect(resultText(result)).toContain("don't have permission");
    });

    test("null identity gets permission denied", async () => {
      const ws = await wsStore.create("Team Null");
      currentIdentity = null;
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "list_members",
        workspaceId: ws.id,
      });

      expect(resultText(result)).toContain("don't have permission");
    });

    test("org owner who is NOT a member can manage members", async () => {
      const ws = await wsStore.create("Team Owner");

      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "add_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });

      expect(result.isError).toBe(false);
    });

    test("org admin who is NOT a member can list, promote, and remove members", async () => {
      const ws = await wsStore.create("Team Governed");
      await wsStore.addMember(ws.id, memberUser.id, "admin");
      await wsStore.addMember(ws.id, anotherUser.id, "member");

      const listed = await tool.handler({ action: "list_members", workspaceId: ws.id });
      expect(listed.isError).toBe(false);
      const parsed = parseResult(listed) as { members: Array<{ userId: string }> };
      expect(parsed.members.map((m) => m.userId).sort()).toEqual(
        [memberUser.id, anotherUser.id].sort(),
      );

      const promoted = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: anotherUser.id,
        role: "admin",
      });
      expect(promoted.isError).toBe(false);

      const removed = await tool.handler({
        action: "remove_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });
      expect(removed.isError).toBe(false);
      const after = await wsStore.get(ws.id);
      expect(after!.members).toEqual([
        expect.objectContaining({ userId: anotherUser.id, role: "admin" }),
      ]);
    });

    test("org admin cannot remove or demote a workspace's last admin", async () => {
      // The last-active-admin guards bind an org admin like anyone else.
      const ws = await wsStore.create("Team LastAdmin");
      await wsStore.addMember(ws.id, memberUser.id, "admin");

      const removed = await tool.handler({
        action: "remove_member",
        workspaceId: ws.id,
        userId: memberUser.id,
      });
      expect(resultText(removed)).toContain("Cannot remove the last workspace admin");

      const demoted = await tool.handler({
        action: "update_member",
        workspaceId: ws.id,
        userId: memberUser.id,
        role: "member",
      });
      expect(resultText(demoted)).toContain("Cannot demote the last workspace admin");
    });

    test("org owner who IS a workspace admin member can manage members", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      const ws = await createWsAsAdmin("Team OwnerMember");
      tool = createManageWorkspacesTool(makeCtx());

      const result = await tool.handler({
        action: "add_member",
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
      expect(resultText(result)).toContain("Unknown action: invalid");
    });
  });
});
