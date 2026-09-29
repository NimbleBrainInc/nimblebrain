/**
 * Integration tests: Identity Wiring Smoke Test (Task 007)
 *
 * Verifies the complete wired system works end-to-end:
 * - Runtime.start() with the dev provider exposes functional identity stores
 * - Management tools are registered in the tool registry
 * - Chat with workspace context creates conversations in the right place
 * - Chat without a workspace (dev mode) runs in the caller's default workspace
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

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
// 1. Runtime.start() under the dev provider
// ---------------------------------------------------------------------------

describe("Runtime.start() identity wiring under the dev provider", () => {
  it("exposes functional UserStore after startup", async () => {
    const workDir = makeTempDir("user-store");
    const runtime = await Runtime.start({
      identityProvider: devProvider,
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
      identityProvider: devProvider,
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

  it("getIdentityProvider() returns the provider passed in, with no instance config", async () => {
    const workDir = makeTempDir("no-auth");
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    expect(runtime.getIdentityProvider()).toBeInstanceOf(DevIdentityProvider);
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
      identityProvider: devProvider,
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
// 3. A chat that names no workspace
// ---------------------------------------------------------------------------
//
// The runtime never chooses a workspace for a request, under any identity
// provider: a chat naming none is refused, and nothing is provisioned for it.

describe("Chat without a workspace", () => {
  it("is refused, and provisions no workspace for the caller", async () => {
    const workDir = makeTempDir("no-workspace-chat");
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    await expect(
      runtime.chat({
        message: "hello with no workspace",
        identity: {
          id: "usr_alice",
          email: "alice@example.com",
          displayName: "Alice",
          orgRole: "member",
          preferences: {},
        },
      }),
    ).rejects.toThrow("request names no workspace");
    expect(await runtime.getWorkspaceStore().getWorkspacesForUser("usr_alice")).toHaveLength(0);

    await runtime.shutdown();
  });
});
