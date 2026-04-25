import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryConversationStore } from "../../../src/conversation/memory-store.ts";
import type { ConversationStore } from "../../../src/conversation/types.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import type { ManageConversationContext } from "../../../src/tools/conversation-tools.ts";
import { createManageConversationTool } from "../../../src/tools/conversation-tools.ts";
import type { InProcessTool } from "../../../src/tools/in-process-app.ts";

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
let conversationStore: ConversationStore;
let workspaceStore: WorkspaceStore;
let tool: InProcessTool;
let currentIdentity: UserIdentity | null;

const ownerIdentity: UserIdentity = {
  id: "usr_owner001",
  email: "owner@example.com",
  displayName: "Owner",
  orgRole: "member",
};

const memberIdentity: UserIdentity = {
  id: "usr_member001",
  email: "member@example.com",
  displayName: "Member",
  orgRole: "member",
};

const adminIdentity: UserIdentity = {
  id: "usr_admin001",
  email: "admin@example.com",
  displayName: "Admin",
  orgRole: "member",
};

const outsiderIdentity: UserIdentity = {
  id: "usr_outsider001",
  email: "outsider@example.com",
  displayName: "Outsider",
  orgRole: "member",
};

function makeCtx(): ManageConversationContext {
  return {
    getIdentity: () => currentIdentity,
    conversationStore,
    workspaceStore,
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-conv-tools-test-"));
  conversationStore = new InMemoryConversationStore();
  workspaceStore = new WorkspaceStore(workDir);
  currentIdentity = ownerIdentity;
  tool = createManageConversationTool(makeCtx());
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("nb__manage_conversation", () => {
  describe("share", () => {
    test("owner shares conversation → visibility becomes shared", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "private",
      });

      const result = await tool.handler({
        action: "share",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { visibility: string; participants: string[] };
      expect(parsed.visibility).toBe("shared");
      expect(parsed.participants).toContain(ownerIdentity.id);
    });

    test("non-owner cannot share → permission error", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "private",
      });

      currentIdentity = outsiderIdentity;
      tool = createManageConversationTool(makeCtx());

      const result = await tool.handler({
        action: "share",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(false);
      expect(extractText(result)).toContain("Permission denied");
    });

    test("workspace admin can share any conversation in their workspace", async () => {
      // Create workspace and add admin + owner as members
      const ws = await workspaceStore.create("Test Workspace");
      await workspaceStore.addMember(ws.id, adminIdentity.id, "admin");
      await workspaceStore.addMember(ws.id, ownerIdentity.id, "member");

      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        workspaceId: ws.id,
        visibility: "private",
      });

      // Switch to admin identity
      currentIdentity = adminIdentity;
      tool = createManageConversationTool(makeCtx());

      const result = await tool.handler({
        action: "share",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { visibility: string };
      expect(parsed.visibility).toBe("shared");
    });
  });

  describe("unshare", () => {
    test("unsharing removes all participants except owner", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "shared",
        participants: [ownerIdentity.id, memberIdentity.id],
      });

      const result = await tool.handler({
        action: "unshare",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { visibility: string; participants: string[] };
      expect(parsed.visibility).toBe("private");
      expect(parsed.participants).toEqual([ownerIdentity.id]);
    });
  });

  describe("add_participant", () => {
    test("owner adds participant → participant appears in list", async () => {
      // Create workspace with both users
      const ws = await workspaceStore.create("Test Workspace");
      await workspaceStore.addMember(ws.id, ownerIdentity.id, "member");
      await workspaceStore.addMember(ws.id, memberIdentity.id, "member");

      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        workspaceId: ws.id,
        visibility: "shared",
      });

      const result = await tool.handler({
        action: "add_participant",
        conversationId: conv.id,
        userId: memberIdentity.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { participants: string[] };
      expect(parsed.participants).toContain(memberIdentity.id);
    });

    test("adding non-workspace-member → error message", async () => {
      // Create workspace with only the owner
      const ws = await workspaceStore.create("Test Workspace");
      await workspaceStore.addMember(ws.id, ownerIdentity.id, "member");

      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        workspaceId: ws.id,
        visibility: "shared",
      });

      const result = await tool.handler({
        action: "add_participant",
        conversationId: conv.id,
        userId: outsiderIdentity.id,
      });

      expect(result.isError).toBe(false);
      expect(extractText(result)).toBe("User is not a member of this workspace.");
    });

    test("userId is required for add_participant", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "shared",
      });

      const result = await tool.handler({
        action: "add_participant",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("userId is required");
    });
  });

  describe("remove_participant", () => {
    test("owner removes participant → participant no longer in list", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "shared",
        participants: [ownerIdentity.id, memberIdentity.id],
      });

      const result = await tool.handler({
        action: "remove_participant",
        conversationId: conv.id,
        userId: memberIdentity.id,
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { participants: string[] };
      expect(parsed.participants).not.toContain(memberIdentity.id);
    });

    test("cannot remove the conversation owner", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "shared",
        participants: [ownerIdentity.id, memberIdentity.id],
      });

      const result = await tool.handler({
        action: "remove_participant",
        conversationId: conv.id,
        userId: ownerIdentity.id,
      });

      expect(result.isError).toBe(false);
      expect(extractText(result)).toBe("Cannot remove the conversation owner.");
    });

    test("userId is required for remove_participant", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "shared",
      });

      const result = await tool.handler({
        action: "remove_participant",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("userId is required");
    });
  });

  describe("authentication", () => {
    test("unauthenticated user gets error", async () => {
      const conv = await conversationStore.create({
        ownerId: ownerIdentity.id,
        visibility: "private",
      });

      currentIdentity = null;
      tool = createManageConversationTool(makeCtx());

      const result = await tool.handler({
        action: "share",
        conversationId: conv.id,
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toBe("Authentication required.");
    });
  });

  describe("conversation not found", () => {
    test("returns error for nonexistent conversation", async () => {
      const result = await tool.handler({
        action: "share",
        conversationId: "nonexistent_conv",
      });

      expect(result.isError).toBe(false);
      expect(extractText(result)).toContain("Conversation not found");
    });
  });
});
