import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { getWorkspaceCredentials } from "../../src/config/workspace-credentials.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { FileCredentialStore } from "../../src/tools/credential-store.ts";
import {
  createManageConnectorsTool,
  deriveConnectorStatus,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

/**
 * Coverage for the new actions on `manage_connectors` introduced with
 * static-auth (operator-configured OAuth apps):
 *
 *   - `setup_operator` — admin-only upsert of (clientId, clientSecret)
 *   - `remove_operator_setup` — admin-only teardown, install-aware
 *   - `list_directory` — `operatorConfigured` flag for static entries
 *   - `install` for static-auth — refuses when setup is missing, persists
 *     the credential ref in the workspace BundleRef on success
 *
 * The handlers only touch a small slice of `Runtime`: `getWorkspaceStore`,
 * `getWorkDir`, `getRegistryStore`, `getLifecycle`, `getRegistryForWorkspace`.
 * We build a thin stub around real WorkspaceStore / FileCredentialStore /
 * RegistryStore / BundleLifecycleManager / ToolRegistry instances —
 * sufficient to drive the production code without spinning up a full
 * `Runtime.start()` (which would pull in identity, model, transport, etc.).
 */

const ASANA_ID = "asana";
const ASANA_URL = "https://mcp.asana.com/v2/mcp";
const ASANA_SECRET_KEY = "asana.client_secret";

/**
 * Build a DirectoryEntry shaped like what CuratedRegistry would emit
 * for Asana — used by install tests since the install API takes the
 * full entry, not an id. Field set matches the real registry output;
 * tests can override pieces (operatorSetup, defaultScope) per case.
 */
function asanaEntry(over: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: ASANA_ID,
    registryId: "curated",
    registryType: "curated",
    name: "Asana",
    description: "Tasks, projects, and team workflows",
    defaultScope: "workspace",
    install: {
      kind: "remote-oauth",
      url: ASANA_URL,
      auth: "static",
      operatorSetup: {
        portalUrl: "https://app.asana.com/0/developer-console",
        hint: "Create a service account",
        clientSecretKey: ASANA_SECRET_KEY,
      },
    },
    ...over,
  };
}

/**
 * Build a DirectoryEntry for an mpak-bundle. The id and package name
 * default to what CuratedRegistry emits for echo (a STDIO_BUNDLES
 * entry); tests can override `id` / `package` to drive non-curated
 * scenarios (e.g. arbitrary scoped names).
 */
function mpakEntry(over: { id?: string; pkg?: string; name?: string } = {}): DirectoryEntry {
  const id = over.id ?? "echo";
  return {
    id,
    registryId: "curated",
    registryType: "curated",
    name: over.name ?? "Echo",
    description: "Reference MCP server for testing",
    defaultScope: "workspace",
    install: {
      kind: "mpak-bundle",
      package: over.pkg ?? "@nimblebraininc/echo",
    },
  };
}

const ADMIN_USER: UserIdentity = {
  id: "usr_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

const NON_ADMIN_USER: UserIdentity = {
  id: "usr_member",
  email: "member@example.test",
  displayName: "Member",
  orgRole: "member",
  preferences: {},
};

interface Harness {
  workDir: string;
  wsId: string;
  workspaceStore: WorkspaceStore;
  credStore: FileCredentialStore;
  registryStore: RegistryStore;
  lifecycle: BundleLifecycleManager;
  workspaceRegistry: ToolRegistry;
  runtime: Runtime;
}

/**
 * Build a stub Runtime exposing the methods the connector-tool handlers
 * actually call. Cast to `Runtime` at the boundary — the type widens to
 * what the production `ManageConnectorsContext` declares without forcing
 * us to satisfy 100+ unrelated methods.
 */
function buildHarness(opts: { adminId?: string } = {}): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-tools-"));
  const wsId = "ws_acme";
  const workspaceStore = new WorkspaceStore(workDir);
  const credStore = new FileCredentialStore(workDir);
  const registryStore = new RegistryStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getRegistryStore: () => registryStore,
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    // Minimal stubs for the runtime services list_installed touches
    // beyond the workspace store. Real instances aren't necessary —
    // the production-shaped behavior is exercised by integration
    // tests; here we just need the methods to exist with sane
    // return shapes so the handler doesn't blow up looking up
    // tangential metadata (user display names, user-scope bundles).
    getPermissionStore: () => ({
      deleteConnector: async (
        _owner: { scope: "workspace" | "user"; wsId?: string; userId?: string },
        _serverName: string,
      ): Promise<void> => {},
    }),
    getUserStore: () => ({
      get: async (_id: string) => null,
    }),
    getUserConnectorStore: () => ({
      get: async (_id: string) => null,
    }),
    getBundleInstancesForWorkspace: (_wsId: string) => lifecycle.getInstances(),
    getAllowInsecureRemotes: () => false,
  } as unknown as Runtime;

  return {
    workDir,
    wsId,
    workspaceStore,
    credStore,
    registryStore,
    lifecycle,
    workspaceRegistry,
    runtime,
  };
}

async function provisionWorkspace(
  h: Harness,
  members: Array<{ userId: string; role: "admin" | "member" }> = [
    { userId: ADMIN_USER.id, role: "admin" },
    { userId: NON_ADMIN_USER.id, role: "member" },
  ],
): Promise<void> {
  const slug = h.wsId.startsWith("ws_") ? h.wsId.slice(3) : h.wsId;
  await h.workspaceStore.create("Acme", slug);
  for (const m of members) {
    await h.workspaceStore.addMember(h.wsId, m.userId, m.role);
  }
}

function buildTool(
  h: Harness,
  identity: UserIdentity | null,
  wsIdOverride?: string | null,
) {
  const ctx: ManageConnectorsContext = {
    runtime: h.runtime,
    getIdentity: () => identity,
    getWorkspaceId: () => (wsIdOverride === undefined ? h.wsId : wsIdOverride),
  };
  return createManageConnectorsTool(ctx);
}

interface StructuredResult {
  ok?: boolean;
  error?: string;
  catalogId?: string;
  clientId?: string;
  serverName?: string;
  scope?: string;
  alreadyInstalled?: boolean;
  entries?: Array<{
    id: string;
    registryId: string;
    operatorConfigured?: boolean;
  }>;
  errors?: Array<{ registryId: string; message: string }>;
}

function structured(result: { structuredContent?: unknown }): StructuredResult {
  return (result.structuredContent ?? {}) as StructuredResult;
}

// ─────────────────────────────────────────────────────────────────────
// setup_operator
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.setup_operator", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-1",
      clientSecret: "sec-1",
    });

    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("on success persists clientId in workspace.json AND clientSecret in credential store", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-public",
      clientSecret: "sec-private",
    });

    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
    expect(structured(result).clientId).toBe("cid-public");

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[ASANA_ID]?.clientId).toBe("cid-public");
    expect(ws?.oauthOperatorApps?.[ASANA_ID]?.configuredBy).toBe(ADMIN_USER.id);

    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped?.reveal()).toBe("sec-private");
  });

  test("upsert: calling twice updates both clientId and clientSecret", async () => {
    const tool = buildTool(h, ADMIN_USER);

    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-v1",
      clientSecret: "sec-v1",
    });
    const second = await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-v2",
      clientSecret: "sec-v2",
    });

    expect(second.isError).toBe(false);
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[ASANA_ID]?.clientId).toBe("cid-v2");
    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped?.reveal()).toBe("sec-v2");
  });

  test("rejects missing wsId / catalogId / clientId / clientSecret", async () => {
    const noWs = buildTool(h, ADMIN_USER, null);
    expect(
      (
        await noWs.handler({
          action: "setup_operator",
          catalogId: ASANA_ID,
          clientId: "x",
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);

    const tool = buildTool(h, ADMIN_USER);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          clientId: "x",
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          catalogId: ASANA_ID,
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          catalogId: ASANA_ID,
          clientId: "x",
        })
      ).isError,
    ).toBe(true);
  });

  test("rejects unknown workspace and unknown catalog entry", async () => {
    const fakeWs = buildTool(h, ADMIN_USER, "ws_nonexistent");
    const r1 = await fakeWs.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "x",
      clientSecret: "y",
    });
    expect(r1.isError).toBe(true);

    const tool = buildTool(h, ADMIN_USER);
    const r2 = await tool.handler({
      action: "setup_operator",
      catalogId: "no-such-entry",
      clientId: "x",
      clientSecret: "y",
    });
    expect(r2.isError).toBe(true);
  });

  test("rejects DCR (non-static-auth) entries — operator setup is meaningless there", async () => {
    const tool = buildTool(h, ADMIN_USER);
    // notion-org is auth: "dcr" in the default catalog
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: "notion-org",
      clientId: "x",
      clientSecret: "y",
    });
    expect(result.isError).toBe(true);
  });

  test("rolls back the credential write when workspace.json update fails (no prior secret)", async () => {
    // Force the workspace update to fail after the credential write
    // has landed. The handler must delete the orphaned credential so
    // the two stores stay in lockstep.
    const original = h.workspaceStore.update.bind(h.workspaceStore);
    h.workspaceStore.update = async () => {
      throw new Error("simulated workspace.json failure");
    };
    const tool = buildTool(h, ADMIN_USER);
    await expect(
      tool.handler({
        action: "setup_operator",
        catalogId: ASANA_ID,
        clientId: "cid-orphan",
        clientSecret: "sec-orphan",
      }),
    ).rejects.toThrow("simulated workspace.json failure");
    h.workspaceStore.update = original;

    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped).toBeNull();
  });

  test("rotation: workspace.json failure does NOT clobber a pre-existing secret", async () => {
    // Seed a working setup, then simulate failure on the rotate call.
    // The rollback must be skipped — wiping a still-valid credential
    // because the rotate's metadata write hiccupped is worse UX than
    // leaving the prior secret in place.
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-v1",
      clientSecret: "sec-v1",
    });

    const original = h.workspaceStore.update.bind(h.workspaceStore);
    h.workspaceStore.update = async () => {
      throw new Error("simulated workspace.json failure on rotate");
    };
    await expect(
      tool.handler({
        action: "setup_operator",
        catalogId: ASANA_ID,
        clientId: "cid-v2",
        clientSecret: "sec-v2",
      }),
    ).rejects.toThrow("simulated workspace.json failure on rotate");
    h.workspaceStore.update = original;

    // Credential store now holds the new secret (the put already
    // landed before the failure) — but it's NOT been deleted, because
    // there was a prior valid secret under the same key.
    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped?.reveal()).toBe("sec-v2");
  });
});

// ─────────────────────────────────────────────────────────────────────
// remove_operator_setup
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.remove_operator_setup", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    // Seed setup as admin first so the gate is what fails (not "no setup").
    const adminTool = buildTool(h, ADMIN_USER);
    await adminTool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const memberTool = buildTool(h, NON_ADMIN_USER);
    const result = await memberTool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("errors when no setup exists for the catalog entry", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(true);
  });

  test("refuses while the connector is currently installed in workspace.bundles", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    // Simulate an installed connector by appending the BundleRef directly.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws).not.toBeNull();
    await h.workspaceStore.update(h.wsId, {
      bundles: [
        ...(ws?.bundles ?? []),
        { url: ASANA_URL, serverName: ASANA_ID } as BundleRef,
      ],
    });

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(true);
  });

  test("on success removes both clientId from workspace.json and the credential", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[ASANA_ID]).toBeUndefined();
    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped).toBeNull();
  });

  test("succeeds on a workspace where the bundle was never installed", async () => {
    // `bundles[]` empty + setup configured + no install ⇒ removable.
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles).toEqual([]);

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// list_directory — operatorConfigured flag for static entries
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.list_directory", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("aggregates entries across enabled registries (curated + mpak by default)", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "list_directory" });
    expect(result.isError).toBe(false);
    const entries = structured(result).entries ?? [];

    const fromCurated = entries.filter((e) => e.registryId === "curated");
    expect(fromCurated.length).toBeGreaterThan(0);
    // mpak registry currently returns no entries by design (real
    // mpak.dev fetch is pending). Either no entries, some entries
    // (when implemented), or a recorded error are all valid; test
    // just checks the aggregator runs without throwing.
  });

  test("static entry shows operatorConfigured: false before setup_operator runs", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "list_directory" });
    const asana = (structured(result).entries ?? []).find(
      (e) => e.registryId === "curated" && e.id === ASANA_ID,
    );
    expect(asana).toBeDefined();
    expect(asana?.operatorConfigured).toBe(false);
  });

  test("static entry shows operatorConfigured: true after setup_operator runs", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const result = await tool.handler({ action: "list_directory" });
    const asana = (structured(result).entries ?? []).find(
      (e) => e.registryId === "curated" && e.id === ASANA_ID,
    );
    expect(asana?.operatorConfigured).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// install — static-auth path
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.install (static-auth)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("errors with a setup pointer when oauthOperatorApps[id] is missing", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", entry: asanaEntry() });
    expect(result.isError).toBe(true);
    // The error message names the portal / Set up affordance.
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("set up");
  });

  test("errors when clientId is configured but the credential is missing", async () => {
    // Stamp the public clientId without a credential — simulates a corrupted
    // half-setup (e.g., the credentials directory was wiped).
    await h.workspaceStore.update(h.wsId, {
      oauthOperatorApps: {
        [ASANA_ID]: {
          clientId: "cid-only",
          configuredAt: new Date().toISOString(),
          configuredBy: ADMIN_USER.id,
        },
      },
    });

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", entry: asanaEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("client_secret");
  });

  test("on success the BundleRef in workspace.bundles carries oauthClient pointing at the credential", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-public",
      clientSecret: "sec-private",
    });

    const result = await tool.handler({ action: "install", entry: asanaEntry() });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
    expect(structured(result).serverName).toBe(ASANA_ID);

    const ws = await h.workspaceStore.get(h.wsId);
    const installed = ws?.bundles.find(
      (b): b is Extract<BundleRef, { url: string }> => "url" in b && b.url === ASANA_URL,
    );
    expect(installed).toBeDefined();
    expect(installed?.oauthClient?.clientId).toBe("cid-public");
    expect(installed?.oauthClient?.clientSecret).toEqual({
      ref: "credential",
      key: ASANA_SECRET_KEY,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// install — entry-based dispatch
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.install", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("rejects malformed entry — refuses without an install action", async () => {
    const tool = buildTool(h, ADMIN_USER);
    // Missing install field — invalid shape.
    const result = await tool.handler({
      action: "install",
      entry: { id: "garbage", name: "Garbage" },
    });
    expect(result.isError).toBe(true);
  });

  test("mpak-bundle entry reaches installBundleInWorkspace dispatch", async () => {
    // Real fetch+spawn isn't possible in a unit test (no network, no
    // subprocess). Reaching `installBundleInWorkspace` and getting a
    // 'Failed to install' from there is the contract — it proves the
    // dispatch ran the install action rather than rejecting up front.
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", entry: mpakEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("failed to install");
    expect(text).toContain("Echo");
  });

  test("any scoped package name installs (no curated-list lookup at install time)", async () => {
    // Forward-compat for real mpak.dev fetch: an entry whose package
    // isn't in our hardcoded STDIO_BUNDLES still reaches the install
    // path. The registry that produced the entry is the source of
    // truth; the install handler doesn't second-guess it.
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: mpakEntry({ id: "@some-vendor/some-bundle", pkg: "@some-vendor/some-bundle" }),
    });
    expect(result.isError).toBe(true);
    // Reaches install path; failure is the mpak fetch (no real registry).
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("failed to install");
  });

  test("connectorsAllowList blocks entries whose id isn't on the list", async () => {
    await h.workspaceStore.update(h.wsId, { connectorsAllowList: ["ipinfo"] });

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", entry: mpakEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("not visible in this workspace");
  });

  test("mpak install requires workspace context", async () => {
    const tool = buildTool(h, ADMIN_USER, null);
    const result = await tool.handler({ action: "install", entry: mpakEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("workspace context required");
  });
});

describe("manage_connectors.set_permissions", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("rejects unknown serverName — fail-fast on typos", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_permissions",
      serverName: "not-installed",
      scope: "workspace",
      tools: { read: "disallow" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("not installed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// set_user_config / clear_user_config
// ─────────────────────────────────────────────────────────────────────

const STUB_BUNDLE_SERVER_NAME = "ipinfo-stub";
const STUB_BUNDLE_NAME = "@nimblebraininc/ipinfo-stub";

/**
 * Write a minimal MCPB manifest into the mpak cache so
 * `mpak.bundleCache.getBundleManifest(bundleName)` returns it on read.
 * The cache layout is `<mpakHome>/cache/<safeName>/manifest.json`,
 * where `safeName` strips the leading `@` and replaces `/` with `-`.
 *
 * Mirrors what `MpakBundleCache.loadBundle` produces in production —
 * just the parts our handlers need (manifest with `user_config`).
 */
function seedManifestCache(
  workDir: string,
  bundleName: string,
  manifest: Record<string, unknown>,
): void {
  const safeName = bundleName.replace(/^@/, "").replace(/\//g, "-");
  const cacheDir = join(workDir, "apps", "cache", safeName);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest));
}

const STUB_MANIFEST = {
  manifest_version: "0.4",
  name: STUB_BUNDLE_NAME,
  version: "1.0.0",
  description: "Test stub for user_config flows",
  server: {
    type: "python",
    entry_point: "ipinfo_stub.server",
    mcp_config: { command: "python", args: ["-m", "ipinfo_stub.server"] },
  },
  user_config: {
    api_key: {
      type: "string",
      title: "API Key",
      description: "IPInfo API token",
      sensitive: true,
      required: true,
    },
    workspace_id: {
      type: "string",
      title: "Workspace",
      description: "Workspace identifier",
      required: false,
    },
  },
};

/**
 * Seed a stdio bundle instance into the lifecycle so handlers find it
 * via `getInstance(serverName, wsId)`. The credential-management
 * handlers don't need a registry-registered ToolSource — only
 * `list_installed` does — so we keep this lighter than the full source
 * setup the production lifecycle does.
 */
function seedStdioBundle(h: Harness): void {
  const ref: BundleRef = { name: STUB_BUNDLE_NAME };
  h.lifecycle.seedInstance(
    STUB_BUNDLE_SERVER_NAME,
    STUB_BUNDLE_NAME,
    ref,
    {
      manifestName: STUB_BUNDLE_NAME,
      version: "1.0.0",
      ui: null,
      type: "plain",
    },
    h.wsId,
  );
  seedManifestCache(h.workDir, STUB_BUNDLE_NAME, STUB_MANIFEST);
}

describe("manage_connectors.set_user_config", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    seedStdioBundle(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: { api_key: "k1" },
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("admin save persists values + returns populated reflecting new state", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: { api_key: "secret-1" },
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      ok: boolean;
      populated: Record<string, boolean>;
    };
    expect(sc.ok).toBe(true);
    expect(sc.populated.api_key).toBe(true);
    expect(sc.populated.workspace_id).toBe(false);

    const stored = await getWorkspaceCredentials(h.wsId, STUB_BUNDLE_NAME, h.workDir);
    expect(stored?.api_key).toBe("secret-1");
  });

  test("rejects unknown field names — default-deny", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: { api_key: "ok", bogus_field: "nope" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("bogus_field");
    // Whole batch rejected — api_key should NOT have been written.
    const stored = await getWorkspaceCredentials(h.wsId, STUB_BUNDLE_NAME, h.workDir);
    expect(stored).toBeNull();
  });

  test("empty string clears that single field", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: { api_key: "k1", workspace_id: "ws-2" },
    });
    const result = await tool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: { api_key: "" },
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { populated: Record<string, boolean> };
    expect(sc.populated.api_key).toBe(false);
    expect(sc.populated.workspace_id).toBe(true);
  });

  test("rejects when bundle is not installed in workspace", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_user_config",
      serverName: "not-installed",
      fields: { api_key: "k" },
    });
    expect(result.isError).toBe(true);
  });

  test("rejects when bundle declares no user_config in its manifest", async () => {
    // Replace the seeded manifest with one that has no user_config
    // block. The lifecycle still has the instance, so the handler
    // gets past the install check and lands on the schema check.
    const { user_config: _omit, ...without } = STUB_MANIFEST;
    seedManifestCache(h.workDir, STUB_BUNDLE_NAME, without);

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("user_config");
  });
});

describe("manage_connectors.get_installed", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns { installed: null } when the bundle isn't installed in any scope", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "get_installed",
      serverName: "no-such-bundle",
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { installed: unknown };
    expect(sc.installed).toBeNull();
  });

  test("rejects empty serverName up front (catches typo'd routes)", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "get_installed", serverName: "" });
    expect(result.isError).toBe(true);
  });
});

describe("manage_connectors.uninstall (stdio)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    seedStdioBundle(h);
    // Mirror what handleInstallStdio writes to workspace.json — the
    // named-bundle entry the regression covers.
    await h.workspaceStore.update(h.wsId, { bundles: [{ name: STUB_BUNDLE_NAME }] });
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("strips the named entry from workspace.json so it doesn't reseed at next boot", async () => {
    const wsBefore = await h.workspaceStore.get(h.wsId);
    expect(wsBefore?.bundles).toHaveLength(1);
    expect((wsBefore?.bundles[0] as { name: string }).name).toBe(STUB_BUNDLE_NAME);

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "uninstall",
      serverName: STUB_BUNDLE_SERVER_NAME,
      scope: "workspace",
    });
    expect(result.isError).toBe(false);

    const wsAfter = await h.workspaceStore.get(h.wsId);
    expect(wsAfter?.bundles ?? []).toHaveLength(0);
  });
});

describe("manage_connectors.clear_user_config", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    seedStdioBundle(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "clear_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("admin clear wipes the credential file and returns all-false populated", async () => {
    // Seed values first so we have something to clear.
    const adminTool = buildTool(h, ADMIN_USER);
    await adminTool.handler({
      action: "set_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
      fields: { api_key: "k1", workspace_id: "ws-2" },
    });

    const result = await adminTool.handler({
      action: "clear_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { populated: Record<string, boolean> };
    expect(sc.populated.api_key).toBe(false);
    expect(sc.populated.workspace_id).toBe(false);

    // File should be gone.
    const stored = await getWorkspaceCredentials(h.wsId, STUB_BUNDLE_NAME, h.workDir);
    expect(stored).toBeNull();
  });

  test("clearing when nothing was stored is idempotent (no error)", async () => {
    const adminTool = buildTool(h, ADMIN_USER);
    const result = await adminTool.handler({
      action: "clear_user_config",
      serverName: STUB_BUNDLE_SERVER_NAME,
    });
    expect(result.isError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// deriveConnectorStatus — pure-function status taxonomy
// ─────────────────────────────────────────────────────────────────────

describe("deriveConnectorStatus", () => {
  test("running + no probes outstanding → ready", () => {
    expect(deriveConnectorStatus({ state: "running" })).toEqual({ status: "ready" });
  });

  test("missingOperatorSetup wins over every other signal — admin acts first", () => {
    // Even with state=running and required user_config populated, an
    // unconfigured operator OAuth client should mark the connector as
    // needs_setup. Setup is the precondition.
    const result = deriveConnectorStatus({
      state: "running",
      missingOperatorSetup: true,
      userConfig: {
        schema: { api_key: { type: "string", required: true } },
        populated: { api_key: true },
      },
    });
    expect(result.status).toBe("needs_setup");
    expect(result.statusReason).toContain("OAuth app");
  });

  test("required user_config field unpopulated → needs_setup with field name in reason", () => {
    const result = deriveConnectorStatus({
      state: "running",
      userConfig: {
        schema: {
          api_key: { type: "string", title: "Hunter.io API Key", required: true },
          workspace_id: { type: "string", title: "Workspace", required: false },
        },
        populated: { api_key: false, workspace_id: false },
      },
    });
    expect(result.status).toBe("needs_setup");
    // Required field is named in the reason; optional one isn't.
    expect(result.statusReason).toContain("Hunter.io API Key");
    expect(result.statusReason).not.toContain("Workspace");
  });

  test("optional fields unpopulated → ready (only required fields gate)", () => {
    const result = deriveConnectorStatus({
      state: "running",
      userConfig: {
        schema: { workspace_id: { type: "string", required: false } },
        populated: { workspace_id: false },
      },
    });
    expect(result.status).toBe("ready");
  });

  test("reauth_required → needs_auth, prefers lastError over generic copy", () => {
    expect(deriveConnectorStatus({ state: "reauth_required" }).status).toBe("needs_auth");
    expect(
      deriveConnectorStatus({ state: "reauth_required", lastError: "refresh token revoked" })
        .statusReason,
    ).toBe("refresh token revoked");
  });

  test("not_authenticated → needs_auth", () => {
    expect(deriveConnectorStatus({ state: "not_authenticated" }).status).toBe("needs_auth");
  });

  test("pending_auth → connecting (no statusReason — wait state, no actionable copy)", () => {
    const result = deriveConnectorStatus({ state: "pending_auth" });
    expect(result.status).toBe("connecting");
    expect(result.statusReason).toBeUndefined();
  });

  test("starting → starting (own state, distinct from connecting)", () => {
    expect(deriveConnectorStatus({ state: "starting" }).status).toBe("starting");
  });

  test("crashed/dead/stopped → failed, lastError surfaces in reason when present", () => {
    expect(deriveConnectorStatus({ state: "crashed" }).status).toBe("failed");
    expect(deriveConnectorStatus({ state: "dead" }).status).toBe("failed");
    expect(deriveConnectorStatus({ state: "stopped" }).status).toBe("failed");

    const withErr = deriveConnectorStatus({ state: "crashed", lastError: "Out of memory" });
    expect(withErr.statusReason).toBe("Out of memory");
  });

  test("setup priority outranks failed — config gap is the actionable cause", () => {
    // A bundle in `crashed` because its required user_config wasn't set
    // should surface as needs_setup (fixable), never as failed (looks
    // unrecoverable).
    const result = deriveConnectorStatus({
      state: "crashed",
      lastError: "Missing api_key",
      userConfig: {
        schema: { api_key: { type: "string", required: true } },
        populated: { api_key: false },
      },
    });
    expect(result.status).toBe("needs_setup");
  });

  test("setup priority outranks needs_auth — same logic, finer level", () => {
    // A bundle in needs_auth state with missing operator setup should
    // still surface as needs_setup; the user can't auth against an
    // OAuth app that doesn't exist yet.
    const result = deriveConnectorStatus({
      state: "not_authenticated",
      missingOperatorSetup: true,
    });
    expect(result.status).toBe("needs_setup");
  });
});
