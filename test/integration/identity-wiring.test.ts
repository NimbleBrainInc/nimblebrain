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
import { Runtime } from "../../src/runtime/runtime.ts";
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

    // Verify it's functional — CRUD operations work
    const ws = await wsStore.create("Smoke Workspace");
    expect(ws.id).toBe("ws_smoke_workspace");

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
// `ChatRequest.workspaceId` field is gone. The conversation file still
// lives at top-level (`{workDir}/conversations/{convId}.jsonl`); the
// metadata's `workspaceId` is the session breadcrumb (personal workspace),
// not a path concern.

describe("Chat is identity-bound (Stage 2 / T006)", () => {
  it("conversation lives at top-level with ownerId; metadata records the personal workspace as the session breadcrumb", async () => {
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

    // Conversation lives at the top-level (Stage 1 Task 005); the
    // metadata workspaceId is the session (personal) workspace.
    const convFile = join(workDir, "conversations", `${result.conversationId}.jsonl`);
    expect(existsSync(convFile)).toBe(true);

    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);
    expect(metadataLine.ownerId).toBe("usr_alice");
    // Stamped from the auto-provisioned personal workspace.
    expect(typeof metadataLine.workspaceId).toBe("string");
    expect(metadataLine.workspaceId).toMatch(/^ws_user_usr_alice/);

    // Nothing was written under a workspace-scoped dir.
    const wsConvFile = join(
      workDir,
      "workspaces",
      metadataLine.workspaceId,
      "conversations",
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(wsConvFile)).toBe(false);

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

    // Conversation at top-level dir; identity-bound under DEV_IDENTITY's
    // personal workspace.
    const convFile = join(workDir, "conversations", `${result.conversationId}.jsonl`);
    expect(existsSync(convFile)).toBe(true);

    await runtime.shutdown();
  });
});
