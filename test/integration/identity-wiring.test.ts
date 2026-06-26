/**
 * Integration tests: Identity Wiring Smoke Test (Task 007)
 *
 * Verifies the complete wired system works end-to-end:
 * - Runtime.start() in dev mode exposes functional identity stores
 * - Management tools are registered in the tool registry
 * - Chat with workspace context creates conversations in the right place
 * - Chat without workspace (backward compat) uses global conversations dir
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomConversationsDir } from "../../src/conversation/paths.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = join(tmpdir(), `nb-id-wiring-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of testDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Runtime.start() in dev mode
// ---------------------------------------------------------------------------

describe("Runtime.start() dev mode identity wiring", () => {
  it("exposes functional UserStore after startup", async () => {
    const workDir = makeTempDir("user-store");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    const userStore = runtime.getUserStore();
    expect(userStore).toBeDefined();

    // Verify it's functional — CRUD operations work
    const user = await userStore.create({
      email: "smoke@example.com",
      displayName: "Smoke Test",
    });
    expect(user.id).toMatch(/^usr_/);

    const fetched = await userStore.get(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.email).toBe("smoke@example.com");

    await runtime.shutdown();
  });

  it("exposes functional WorkspaceStore after startup", async () => {
    const workDir = makeTempDir("ws-store");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    const wsStore = runtime.getWorkspaceStore();
    expect(wsStore).toBeDefined();

    // Verify it's functional — CRUD operations work. The id is opaque
    // and name-independent, so assert its shape, not a name-derived value.
    const ws = await wsStore.create("Smoke Workspace");
    expect(ws.id).toMatch(/^ws_[0-9a-f]{16}$/);

    const fetched = await wsStore.get(ws.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Smoke Workspace");

    await runtime.shutdown();
  });

  it("getIdentityProvider() returns null in dev mode (no instance.json)", async () => {
    const workDir = makeTempDir("no-auth");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    expect(runtime.getIdentityProvider()).toBeNull();
    expect(runtime.getInstanceConfig()).toBeNull();

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 2. Management tools registered
// ---------------------------------------------------------------------------

describe("Management tools in registry", () => {
  it("tool registry contains workspace and conversation management tools", async () => {
    const workDir = makeTempDir("mgmt-tools");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    await provisionTestWorkspace(runtime);
    const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
    const allTools = await registry.availableTools();
    const toolNames = allTools.map((t) => t.name);

    // Workspace management tool should be present (members + conversations merged in)
    expect(toolNames).toContain("nb__manage_workspaces");
    expect(toolNames).not.toContain("nb__manage_members");
    expect(toolNames).not.toContain("nb__manage_conversation");

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 3. Chat is identity-bound (Stage 2 / T006)
// ---------------------------------------------------------------------------
//
// Pre-Stage-2 this section pinned "chat creates the conversation in the
// requested workspace's directory" and "chat without workspaceId throws."
// Both contracts were deleted by T006: chat is now identity-bound, the
// session workspace is the identity's personal workspace, and the
// `ChatRequest.workspaceId` field is gone. The conversation file lives in
// the caller's personal room
// (`{workDir}/workspaces/ws_user_<id>/conversations/<id>/{convId}.jsonl`);
// the metadata's `workspaceId` is that same personal-room binding (also the
// session breadcrumb for legacy single-workspace reads).

describe("Chat is identity-bound (Stage 2 / T006)", () => {
  it("conversation lives in the personal room with ownerId; metadata records the personal workspace as the session breadcrumb", async () => {
    const workDir = makeTempDir("identity-bound-chat");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    // No explicit `workspaceId` — T006 removed it. Just an identity.
    const result = await runtime.chat({
      message: "hello from identity-bound chat",
      identity: {
        id: "usr_alice",
        email: "alice@example.com",
        displayName: "Alice",
        orgRole: "member",
        preferences: {},
      },
    });

    expect(result.conversationId).toMatch(/^conv_/);

    // Conversation lives in the personal room's owner partition; the
    // metadata workspaceId is that same session (personal) workspace.
    const convFile = join(
      roomConversationsDir(workDir, personalWorkspaceIdFor("usr_alice"), "usr_alice"),
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(convFile)).toBe(true);

    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);
    expect(metadataLine.ownerId).toBe("usr_alice");
    // Stamped from the auto-provisioned personal workspace.
    expect(typeof metadataLine.workspaceId).toBe("string");
    expect(metadataLine.workspaceId).toMatch(/^ws_user_usr_alice/);

    // Nothing was written at the old flat top-level path.
    expect(existsSync(join(workDir, "conversations", `${result.conversationId}.jsonl`))).toBe(
      false,
    );

    await runtime.shutdown();
  });

  it("chat in dev mode (no identity, no workspaceId) succeeds via DEV_IDENTITY fallback", async () => {
    const workDir = makeTempDir("dev-mode-chat");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    const result = await runtime.chat({ message: "ping" });

    expect(result.response).toBeTruthy();
    expect(result.conversationId).toMatch(/^conv_/);

    // Identity-bound under DEV_IDENTITY (`usr_default`); the conversation
    // lives in that identity's personal room.
    const convFile = join(
      roomConversationsDir(workDir, personalWorkspaceIdFor("usr_default"), "usr_default"),
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(convFile)).toBe(true);

    await runtime.shutdown();
  });
});
