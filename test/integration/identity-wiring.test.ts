/**
 * Integration tests: Identity Wiring Smoke Test (Task 007)
 *
 * Verifies the complete wired system works end-to-end:
 * - Runtime.start() in dev mode exposes functional identity stores
 * - Management tools are registered in the tool registry
 * - Chat with workspace context creates conversations in the right place
 * - Chat without a workspace (dev mode) runs in the caller's default workspace
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
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
// 3. Chat without a workspace (dev mode)
// ---------------------------------------------------------------------------
//
// A chat that names no workspace runs, in dev mode, in the caller's default
// workspace — provisioned for them if they belong to none. The conversation file
// lives in that workspace's owner partition, and its metadata records the
// workspace.

describe("Chat without a workspace (dev mode)", () => {
  it("conversation lives in the provisioned workspace with ownerId; metadata records that workspace", async () => {
    const workDir = makeTempDir("identity-bound-chat");
    const runtime = await Runtime.start({
      workDir,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    // No `workspaceId` — dev mode stands in the caller's default workspace.
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

    // One workspace was provisioned for Alice; the conversation lives in its
    // owner partition and its metadata names it.
    const aliceWorkspaces = await runtime.getWorkspaceStore().getWorkspacesForUser("usr_alice");
    expect(aliceWorkspaces).toHaveLength(1);
    const aliceWsId = aliceWorkspaces[0]!.id;
    const convFile = join(
      workspaceConversationsDir(workDir, aliceWsId, "usr_alice"),
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(convFile)).toBe(true);

    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);
    expect(metadataLine.ownerId).toBe("usr_alice");
    expect(metadataLine.workspaceId).toBe(aliceWsId);
    expect(aliceWsId).toMatch(/^ws_[0-9a-f]{16}$/);

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
      model: { provider: "custom", adapter: createEchoModel() },
    });

    const result = await runtime.chat({ message: "ping" });

    expect(result.response).toBeTruthy();
    expect(result.conversationId).toMatch(/^conv_/);

    // Identity-bound under DEV_IDENTITY (`usr_default`); the conversation
    // lives in the workspace provisioned for that identity.
    const [devWs] = await runtime.getWorkspaceStore().getWorkspacesForUser("usr_default");
    const convFile = join(
      workspaceConversationsDir(workDir, devWs!.id, "usr_default"),
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(convFile)).toBe(true);

    await runtime.shutdown();
  });
});
