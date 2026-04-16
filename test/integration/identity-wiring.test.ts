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
// 3. Chat with workspace context
// ---------------------------------------------------------------------------

describe("Chat with workspace context", () => {
  it("creates conversation in workspace directory with ownerId", async () => {
    const workDir = makeTempDir("ws-chat");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    // Create a workspace via the store
    const wsStore = runtime.getWorkspaceStore();
    const ws = await wsStore.create("Engineering");

    // Ensure workspace registry exists (workspace created after startup)
    await runtime.ensureWorkspaceRegistry(ws.id);

    // Chat with workspace and identity context
    const result = await runtime.chat({
      message: "hello from workspace chat",
      workspaceId: ws.id,
      identity: { id: "usr_alice", email: "alice@example.com" },
    });

    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.workspaceId).toBe(ws.id);

    // Verify conversation file is in the workspace directory
    const wsConvDir = join(workDir, "workspaces", ws.id, "conversations");
    const convFile = join(wsConvDir, `${result.conversationId}.jsonl`);
    expect(existsSync(convFile)).toBe(true);

    // Verify conversation metadata has ownerId
    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);
    expect(metadataLine.ownerId).toBe("usr_alice");
    expect(metadataLine.workspaceId).toBe(ws.id);

    // Should NOT be in global conversations dir
    const globalConvFile = join(
      workDir,
      "conversations",
      `${result.conversationId}.jsonl`,
    );
    expect(existsSync(globalConvFile)).toBe(false);

    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 4. Chat without workspace (backward compat)
// ---------------------------------------------------------------------------

describe("Chat without workspace (workspaceId is now required)", () => {
  it("throws when no workspaceId is provided", async () => {
    const workDir = makeTempDir("no-ws-chat");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      await expect(
        runtime.chat({ message: "hello global" }),
      ).rejects.toThrow("workspaceId is required");
    } finally {
      await runtime.shutdown();
    }
  });

  it("chat works with explicit workspaceId", async () => {
    const workDir = makeTempDir("explicit-ws");
    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    await provisionTestWorkspace(runtime);

    const result = await runtime.chat({
      message: "ping",
      workspaceId: TEST_WORKSPACE_ID,
    });

    expect(result.response).toBeTruthy();
    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.workspaceId).toBe(TEST_WORKSPACE_ID);

    // Conversation file should be in the workspace conversations dir
    const wsConvDir = join(workDir, "workspaces", TEST_WORKSPACE_ID, "conversations");
    const convFile = join(wsConvDir, `${result.conversationId}.jsonl`);
    expect(existsSync(convFile)).toBe(true);

    await runtime.shutdown();
  });
});
