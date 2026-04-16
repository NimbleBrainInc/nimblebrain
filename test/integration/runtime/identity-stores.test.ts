import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(suffix: string): string {
  const dir = join(tmpdir(), `nb-identity-stores-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    if (existsSync(d)) rmSync(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Runtime identity stores wiring", () => {
  it("dev mode: no instance.json → getIdentityProvider() returns null, stores exist", async () => {
    const workDir = makeTempDir("dev");
    dirs.push(workDir);

    const rt = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    expect(rt.getIdentityProvider()).toBeNull();
    expect(rt.getInstanceConfig()).toBeNull();

    // Verify stores are not just defined but are functional objects with expected methods
    const userStore = rt.getUserStore();
    expect(typeof userStore.create).toBe("function");
    expect(typeof userStore.get).toBe("function");

    const wsStore = rt.getWorkspaceStore();
    expect(typeof wsStore.create).toBe("function");
    expect(typeof wsStore.get).toBe("function");

    await provisionTestWorkspace(rt);

    const convStore = rt.getConversationStore(TEST_WORKSPACE_ID);
    expect(typeof convStore.create).toBe("function");
  });

  it("with oidc auth instance.json → getIdentityProvider() returns non-null", async () => {
    const workDir = makeTempDir("oidc-auth");
    dirs.push(workDir);

    // Write a valid instance.json with oidc auth
    const instanceConfig = {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "test",
        allowedDomains: ["example.com"],
      },
    };
    writeFileSync(join(workDir, "instance.json"), JSON.stringify(instanceConfig, null, 2));

    const rt = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    expect(rt.getIdentityProvider()).not.toBeNull();
    expect(rt.getInstanceConfig()).toEqual(instanceConfig);
  });

  it("getUserStore() returns a functional UserStore", async () => {
    const workDir = makeTempDir("user-store");
    dirs.push(workDir);

    const rt = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    const userStore = rt.getUserStore();

    // Create a user
    const user = await userStore.create({
      email: "test@example.com",
      displayName: "Test User",
    });
    expect(user.id).toMatch(/^usr_/);
    expect(user.email).toBe("test@example.com");

    // Get the user back
    const fetched = await userStore.get(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.email).toBe("test@example.com");
  });

  it("getWorkspaceStore() returns a functional WorkspaceStore", async () => {
    const workDir = makeTempDir("workspace-store");
    dirs.push(workDir);

    const rt = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    const workspaceStore = rt.getWorkspaceStore();

    // Create a workspace
    const ws = await workspaceStore.create("Test Workspace");
    expect(ws.id).toBe("ws_test_workspace");
    expect(ws.name).toBe("Test Workspace");

    // Get it back
    const fetched = await workspaceStore.get(ws.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Test Workspace");
  });

  it("getConversationStore() is an alias for getStore()", async () => {
    const workDir = makeTempDir("conv-alias");
    dirs.push(workDir);

    const rt = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    await provisionTestWorkspace(rt);

    // Both return workspace-scoped stores for the same workspace (new instances each call)
    const convStore = rt.getConversationStore(TEST_WORKSPACE_ID);
    const store = rt.getStore(TEST_WORKSPACE_ID);
    // They are separate instances but point to the same directory
    expect(typeof convStore.create).toBe("function");
    expect(typeof store.create).toBe("function");
    // Verify they can both create conversations in the same workspace
    const conv = await convStore.create({ workspaceId: TEST_WORKSPACE_ID });
    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(conv.id);
  });
});
