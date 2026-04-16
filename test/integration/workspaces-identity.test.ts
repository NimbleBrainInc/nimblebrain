/**
 * Integration tests: Workspaces and Identity
 *
 * End-to-end tests that validate the complete workspaces and identity flow.
 * Each test creates its own temp directory. Real filesystem IO, no mocks.
 *
 * Covers use cases UC-W1, UC-W2, UC-W4, UC-W5, UC-W6 from spec section 13,
 * plus auth flow and dev mode backward compatibility.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { UserStore } from "../../src/identity/user.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { saveInstanceConfig } from "../../src/identity/instance.ts";
import type { IdentityProvider, CreateUserResult } from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import {
  resolveWorkspace,
  WorkspaceResolutionError,
  authenticateRequest,
  resolveAuthMode,
} from "../../src/api/auth-middleware.ts";
import {
  buildProcessInventory,
} from "../../src/runtime/workspace-runtime.ts";
import type { Workspace } from "../../src/workspace/types.ts";
import type { ConversationAccessContext } from "../../src/conversation/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nb-integ-"));
}

// ---------------------------------------------------------------------------
// UC-W1: Private work with shared tools
// ---------------------------------------------------------------------------

describe("UC-W1: Private work with shared tools", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("private conversation is visible only to its owner", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    // Create two users
    const mat = await userStore.create({ email: "mat@test.io", displayName: "Mat" });
    const kai = await userStore.create({ email: "kai@test.io", displayName: "Kai" });

    // Create workspace and add both
    const eng = await wsStore.create("Engineering", "engineering");
    await wsStore.addMember(eng.id, mat.id, "admin");
    await wsStore.addMember(eng.id, kai.id, "member");

    // Mat creates a private conversation in Engineering
    const convDir = join(workDir, "workspaces", eng.id, "conversations");
    const store = new JsonlConversationStore(convDir);

    const matConv = await store.create({
      workspaceId: eng.id,
      ownerId: mat.id,
      visibility: "private",
    });

    // Kai lists conversations -> Mat's private convo NOT visible
    const kaiAccess: ConversationAccessContext = { userId: kai.id, workspaceRole: "member" };
    const kaiList = await store.list(undefined, kaiAccess);
    const kaiIds = kaiList.conversations.map((c) => c.id);
    expect(kaiIds).not.toContain(matConv.id);

    // Mat lists conversations -> his private convo IS visible
    const matAccess: ConversationAccessContext = { userId: mat.id, workspaceRole: "admin" };
    const matList = await store.list(undefined, matAccess);
    const matIds = matList.conversations.map((c) => c.id);
    expect(matIds).toContain(matConv.id);
  });
});

// ---------------------------------------------------------------------------
// UC-W2: Collaborative conversation
// ---------------------------------------------------------------------------

describe("UC-W2: Collaborative conversation", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("shared conversation is accessible by both participants with userId on messages", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    const mat = await userStore.create({ email: "mat@test.io", displayName: "Mat" });
    const kai = await userStore.create({ email: "kai@test.io", displayName: "Kai" });

    const eng = await wsStore.create("Engineering", "engineering");
    await wsStore.addMember(eng.id, mat.id, "admin");
    await wsStore.addMember(eng.id, kai.id, "member");

    const convDir = join(workDir, "workspaces", eng.id, "conversations");
    const store = new JsonlConversationStore(convDir);

    // Mat starts a shared conversation
    const conv = await store.create({
      workspaceId: eng.id,
      ownerId: mat.id,
      visibility: "shared",
      participants: [mat.id],
    });

    // Add Kai as participant
    await store.addParticipant(conv.id, kai.id);

    // Both can load the conversation
    const matAccess: ConversationAccessContext = { userId: mat.id };
    const kaiAccess: ConversationAccessContext = { userId: kai.id };
    const matLoaded = await store.load(conv.id, matAccess);
    const kaiLoaded = await store.load(conv.id, kaiAccess);
    expect(matLoaded).not.toBeNull();
    expect(kaiLoaded).not.toBeNull();

    // Messages from each include userId
    const now = new Date().toISOString();
    await store.append(matLoaded!, {
      role: "user",
      content: [{ type: "text", text: "Hello from Mat" }],
      timestamp: now,
      userId: mat.id,
    });
    await store.append(matLoaded!, {
      role: "user",
      content: [{ type: "text", text: "Hello from Kai" }],
      timestamp: now,
      userId: kai.id,
    });

    const history = await store.history(matLoaded!);
    expect(history).toHaveLength(2);
    expect(history[0]!.userId).toBe(mat.id);
    expect(history[1]!.userId).toBe(kai.id);
  });
});

// ---------------------------------------------------------------------------
// UC-W4: Same app, different workspaces
// ---------------------------------------------------------------------------

describe("UC-W4: Same app, different workspaces", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("same bundle in two workspaces produces separate inventory entries", () => {
    workDir = makeTmpDir();

    const crmBundle = { name: "@nimblebraininc/crm" };

    const engineering: Workspace = {
      id: "ws_engineering",
      name: "Engineering",
      members: [],
      bundles: [crmBundle],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const marketing: Workspace = {
      id: "ws_marketing",
      name: "Marketing",
      members: [],
      bundles: [crmBundle],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const inventory = buildProcessInventory([engineering, marketing], workDir);

    // 2 separate entries
    expect(inventory).toHaveLength(2);

    // Different data dirs
    const dataDirs = inventory.map((e) => e.dataDir);
    expect(dataDirs[0]).not.toBe(dataDirs[1]);

    // Correct server names and workspace IDs
    const entries = inventory.map((e) => ({ serverName: e.serverName, wsId: e.wsId }));
    expect(entries).toContainEqual({ serverName: "crm", wsId: "ws_engineering" });
    expect(entries).toContainEqual({ serverName: "crm", wsId: "ws_marketing" });

    // Data dirs are workspace-scoped
    expect(dataDirs[0]).toContain("ws_engineering");
    expect(dataDirs[1]).toContain("ws_marketing");
  });
});

// ---------------------------------------------------------------------------
// UC-W5: New user onboarding
// ---------------------------------------------------------------------------

describe("UC-W5: New user onboarding", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("admin creates user, adds to workspaces, user can access both", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    // Create user Sara directly via UserStore
    const sara = await userStore.create({ email: "sara@test.io", displayName: "Sara", orgRole: "member" });
    expect(sara.email).toBe("sara@test.io");
    expect(sara.orgRole).toBe("member");

    // Create two workspaces
    const eng = await wsStore.create("Engineering", "engineering");
    const mkt = await wsStore.create("Marketing", "marketing");

    // Add Sara to both
    await wsStore.addMember(eng.id, sara.id, "member");
    await wsStore.addMember(mkt.id, sara.id, "member");

    // Sara's getWorkspacesForUser returns both
    const workspaces = await wsStore.getWorkspacesForUser(sara.id);
    expect(workspaces).toHaveLength(2);
    const wsIds = workspaces.map((ws) => ws.id);
    expect(wsIds).toContain(eng.id);
    expect(wsIds).toContain(mkt.id);
  });
});

// ---------------------------------------------------------------------------
// UC-W6: Workspace admin manages bundles
// ---------------------------------------------------------------------------

describe("UC-W6: Workspace admin manages bundles", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("admin adds bundles to workspace, buildProcessInventory reflects them", async () => {
    workDir = makeTmpDir();

    const wsStore = new WorkspaceStore(workDir);

    // Admin creates workspace with no bundles
    const eng = await wsStore.create("Engineering", "engineering");
    expect(eng.bundles).toHaveLength(0);

    // Initial inventory is empty
    let inventory = buildProcessInventory([eng], workDir);
    expect(inventory).toHaveLength(0);

    // Admin adds bundles via update
    const updated = await wsStore.update(eng.id, {
      bundles: [{ name: "@nimblebraininc/crm" }],
    });
    expect(updated).not.toBeNull();
    expect(updated!.bundles).toHaveLength(1);

    // Inventory now reflects the new bundle
    inventory = buildProcessInventory([updated!], workDir);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.serverName).toBe("crm");
    expect(inventory[0]!.wsId).toBe(eng.id);

    // Other workspace is unaffected
    const mkt = await wsStore.create("Marketing", "marketing");
    const allWorkspaces = await wsStore.list();
    inventory = buildProcessInventory(allWorkspaces, workDir);
    // Only 1 entry (eng has crm, mkt has none)
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.wsId).toBe(eng.id);
  });
});

// ---------------------------------------------------------------------------
// Auth flow: adapter mode rejects unauthenticated requests
// ---------------------------------------------------------------------------

describe("Auth flow", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("unauthenticated request to configured instance returns 401", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);

    // Create a simple mock provider for the adapter mode test
    const mockProvider: IdentityProvider = {
      capabilities: { authCodeFlow: false, tokenRefresh: false, managedUsers: false },
      async verifyRequest(): Promise<null> { return null; },
      async listUsers(): Promise<User[]> { return []; },
      async createUser(data): Promise<CreateUserResult> {
        const user = await userStore.create({ email: data.email, displayName: data.displayName, orgRole: data.orgRole });
        return { user };
      },
      async deleteUser(userId: string): Promise<boolean> { return userStore.delete(userId); },
    };

    // Save instance config so this is not dev mode
    await saveInstanceConfig(workDir, {
      auth: { adapter: "oidc", issuer: "https://auth.example.com", clientId: "test", allowedDomains: ["example.com"] },
    });

    const mode = resolveAuthMode(mockProvider);
    expect(mode.type).toBe("adapter");

    // Request with no auth header
    const req = new Request("http://localhost/v1/chat");
    const { NoopEventSink } = await import("../../src/adapters/noop-events.ts");
    const result = await authenticateRequest(req, {
      mode,
      internalToken: "internal-test-token-12345",
      eventSink: new NoopEventSink(),
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Dev mode: no instance.json -> everything works as single user
// ---------------------------------------------------------------------------

describe("Dev mode", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("DevIdentityProvider creates default user on first request", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    // Suppress console.warn from DevIdentityProvider
    const originalWarn = console.warn;
    console.warn = () => {};

    const adapter = new DevIdentityProvider(workDir, userStore);

    // verifyRequest returns default identity
    const req = new Request("http://localhost/v1/chat");
    const identity = await adapter.verifyRequest(req);

    console.warn = originalWarn;

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("usr_default");
    expect(identity!.email).toBe("dev@localhost");
    expect(identity!.orgRole).toBe("owner");

    // Default user profile was auto-created
    const user = await userStore.get("usr_default");
    expect(user).not.toBeNull();
    expect(user!.displayName).toBe("Developer");

    // DevIdentityProvider no longer creates workspaces — the runtime does.
    // Verify we can create a workspace and add the dev user to it.
    const ws = await wsStore.create("Test Workspace", "test");
    await wsStore.addMember(ws.id, "usr_default", "owner");

    const workspaces = await wsStore.list();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    const defaultWs = workspaces[0]!;
    expect(defaultWs.members.some((m) => m.userId === "usr_default")).toBe(true);
  });

  test("dev mode auth mode resolves to dev when no adapter and no api key", () => {
    const mode = resolveAuthMode(null);
    expect(mode.type).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

describe("Workspace resolution", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("resolves single workspace automatically", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    const user = await userStore.create({ email: "dev@test.io", displayName: "Dev" });
    const ws = await wsStore.create("Default", "default");
    await wsStore.addMember(ws.id, user.id, "member");

    const req = new Request("http://localhost/v1/chat");
    const identity = { id: user.id, email: user.email, displayName: user.displayName, orgRole: user.orgRole };

    const wsId = await resolveWorkspace(req, identity, wsStore);
    expect(wsId).toBe(ws.id);
  });

  test("throws when user belongs to multiple workspaces without header", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    const user = await userStore.create({ email: "dev@test.io", displayName: "Dev" });
    const eng = await wsStore.create("Engineering", "engineering");
    const mkt = await wsStore.create("Marketing", "marketing");
    await wsStore.addMember(eng.id, user.id, "member");
    await wsStore.addMember(mkt.id, user.id, "member");

    const req = new Request("http://localhost/v1/chat");
    const identity = { id: user.id, email: user.email, displayName: user.displayName, orgRole: user.orgRole };

    expect(resolveWorkspace(req, identity, wsStore)).rejects.toThrow(WorkspaceResolutionError);
  });

  test("X-Workspace-Id header selects workspace explicitly", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    const user = await userStore.create({ email: "dev@test.io", displayName: "Dev" });
    const eng = await wsStore.create("Engineering", "engineering");
    const mkt = await wsStore.create("Marketing", "marketing");
    await wsStore.addMember(eng.id, user.id, "member");
    await wsStore.addMember(mkt.id, user.id, "member");

    const req = new Request("http://localhost/v1/chat", {
      headers: { "X-Workspace-Id": mkt.id },
    });
    const identity = { id: user.id, email: user.email, displayName: user.displayName, orgRole: user.orgRole };

    const wsId = await resolveWorkspace(req, identity, wsStore);
    expect(wsId).toBe(mkt.id);
  });

  test("rejects non-member accessing workspace", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    const user = await userStore.create({ email: "dev@test.io", displayName: "Dev" });
    const ws = await wsStore.create("Secret", "secret");
    // Do NOT add user as member

    const req = new Request("http://localhost/v1/chat", {
      headers: { "X-Workspace-Id": ws.id },
    });
    const identity = { id: user.id, email: user.email, displayName: user.displayName, orgRole: user.orgRole };

    expect(resolveWorkspace(req, identity, wsStore)).rejects.toThrow(WorkspaceResolutionError);
  });
});
