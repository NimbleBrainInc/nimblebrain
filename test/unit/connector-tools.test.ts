import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import { buildManagedConnectorRegistry } from "../../src/connectors/providers/registry.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import {
  _resetInstanceOperatorAppsForTest,
  bindInstanceOperatorApps,
} from "../../src/connectors/runtime/operator-apps.ts";
import type { ConnectorRef, OAuthClientConfig } from "../../src/connectors/runtime/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { UserStore } from "../../src/identity/user.ts";
import type { LifecycleNotifyDeps } from "../../src/lifecycle/notify.ts";
import type { PermissionStore } from "../../src/permissions/permission-store.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  deriveConnectorStatus,
  type ManageConnectorsContext,
  rotateInstalledOAuthClients,
} from "../../src/tools/connector-tools.ts";
import type { CredentialStore } from "../../src/tools/credential-store.ts";
import { McpOAuthRecords } from "../../src/tools/mcp-oauth-records.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { installTestCredentialStore } from "../helpers/credential-store.ts";
import { stub } from "../helpers/stub.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

/** Read metadata every store read now carries; the audit trail is asserted in credential-store.test.ts. */
const TEST_READ = { caller: "test", purpose: "assert the store holds what the handler wrote" };

/**
 * Coverage for the new actions on `manage_connectors` introduced with
 * static-auth (operator-configured OAuth apps):
 *
 *   - `setup_operator` — admin-only upsert of (clientId, clientSecret)
 *   - `remove_operator_setup` — admin-only teardown, install-aware
 *   - `list_directory` — `operatorConfigured` flag for static entries
 *   - `install` for static-auth — refuses when setup is missing, persists
 *     the credential ref in the workspace ConnectorRef on success
 *
 * The handlers only touch a small slice of `Runtime`: `getWorkspaceStore`,
 * `getWorkDir`, `getConnectorCatalog`, `getLifecycle`, `getRegistryForWorkspace`.
 * We build a thin stub around real WorkspaceStore / CredentialStore /
 * ConnectorLifecycleManager / ToolRegistry instances —
 * sufficient to drive the production code without spinning up a full
 * `Runtime.start()` (which would pull in identity, model, transport, etc.).
 */

// Reverse-DNS form per upstream MCP registry's ServerDetail spec — matches
// the `name` field of the Dropbox entry in the connector test fixture
// (test/fixtures/connectors/). Dropbox is the canonical `auth: static`
// (bring-your-own OAuth) connector, so static-auth setup_operator/install
// tests resolve against it.
const DROPBOX_ID = "com.dropbox/mcp";
const DROPBOX_URL = "https://mcp.dropbox.com/mcp";
const DROPBOX_SECRET_KEY = "dropbox.client_secret";
// DCR entry from the bundled static catalog — used to verify operator
// setup is rejected for non-static-auth connectors.
const NOTION_ID = "com.notion/mcp";

/**
 * Build a CatalogListing shaped like what the catalog read projects for
 * Dropbox — used by install tests since the install API takes the full
 * entry, not an id. Field set matches the real source output; tests
 * can override pieces (operatorSetup, install) per case.
 */
function dropboxEntry(over: Partial<CatalogListing> = {}): CatalogListing {
  return {
    id: DROPBOX_ID,
    name: "Dropbox",
    description: "Files, folders, and shared links",
    install: {
      kind: "remote-oauth",
      url: DROPBOX_URL,
      transportType: "streamable-http",
      auth: "static",
      operatorSetup: {
        portalUrl: "https://www.dropbox.com/developers/apps",
        hint: "Create a service account",
        clientSecretKey: DROPBOX_SECRET_KEY,
      },
    },
    ...over,
  };
}

/**
 * Build a CatalogListing for the not-yet-supported `direct-url` kind. Used to
 * drive the admission checks that run BEFORE the per-kind install dispatch
 * (workspace resolution, membership, admin role, allow-list, the
 * personal-workspace connectors-only rule): every one of those rejects before
 * the kind is reached, and a call that gets past them lands on the
 * `direct-url` errResult rather than touching a real endpoint.
 */
function unsupportedEntry(over: { id?: string; name?: string } = {}): CatalogListing {
  return {
    id: over.id ?? "com.example/echo",
    name: over.name ?? "Echo",
    description: "Reference MCP server for testing",
    install: { kind: "direct-url", url: "https://echo.example.com/mcp" },
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
  credStore: CredentialStore;
  lifecycle: ConnectorLifecycleManager;
  workspaceRegistry: ToolRegistry;
  runtime: Runtime;
  /** Tool-policy writes the stub permission store received, newest last. */
  permissionWrites: PermissionWrite[];
}

interface PermissionWrite {
  owner: { scope: "workspace" | "user"; wsId?: string; userId?: string };
  serverName: string;
  tools: Record<string, "allow" | "disallow">;
}

/**
 * Build a stub Runtime exposing the methods the connector-tool handlers
 * actually call.
 */
function buildHarness(): Harness {
  const permissionWrites: PermissionWrite[] = [];
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-tools-"));
  const wsId = "ws_000f7ed6658f9d30";
  const workspaceStore = new WorkspaceStore(workDir);
  // Installed process-wide as well as handed to the stub runtime: the OAuth
  // records the install path seeds Connection state from reach the store
  // through `requireCredentialStore()`, exactly as they do in production.
  const credStore = installTestCredentialStore(workDir);
  const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  const workspaceRegistry = new ToolRegistry();

  const runtime = stub<Runtime>({
    getWorkDir: () => workDir,
    getCredentialStore: () => credStore,
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getConnectorCatalog: () => new ConnectorCatalog(CONNECTOR_FIXTURE_DIR),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    // Minimal stubs for the runtime services list_installed touches
    // beyond the workspace store. Real instances aren't necessary —
    // the production-shaped behavior is exercised by integration
    // tests; here we just need the methods to exist with sane
    // return shapes so the handler doesn't blow up looking up
    // tangential metadata (user display names, user-scope connectors).
    getPermissionStore: () =>
      stub<PermissionStore>({
        deleteConnector: async (
          _owner: { scope: "workspace" | "user"; wsId?: string; userId?: string },
          _serverName: string,
        ): Promise<void> => {},
        // Records the write so an admin-path test can assert the handler got
        // past its gate and actually persisted, rather than only that it
        // returned ok.
        setConnector: async (
          owner: { scope: "workspace" | "user"; wsId?: string; userId?: string },
          serverName: string,
          tools: Record<string, "allow" | "disallow">,
        ): Promise<void> => {
          permissionWrites.push({ owner, serverName, tools });
        },
      }),
    getUserStore: () =>
      stub<UserStore>({
        get: async (_id: string) => null,
      }),
    getConnectorInstancesForWorkspace: (_wsId: string) => lifecycle.getInstances(),
    getAllowInsecureRemotes: () => false,
    // No broker is configured here; the personal-catalog filter asks.
    getManagedConnectorRegistry: () => buildManagedConnectorRegistry(),
    // The lifecycle notification the install and uninstall handlers make. No
    // connector here declares one, so both calls are no-ops — but the getter
    // has to exist: `handleUninstall` reads it before any teardown, and a stub
    // missing it fails the uninstall rather than skipping the notification.
    getLifecycleNotifyDeps: () =>
      stub<LifecycleNotifyDeps>({
        declarationFor: async () => undefined,
        portFor: () => undefined,
      }),
  });

  return {
    workDir,
    wsId,
    workspaceStore,
    credStore,
    lifecycle,
    workspaceRegistry,
    runtime,
    permissionWrites,
  };
}

async function provisionWorkspace(
  h: Harness,
  members: Array<{ userId: string; role: "admin" | "member" }> = [
    { userId: ADMIN_USER.id, role: "admin" },
    { userId: NON_ADMIN_USER.id, role: "member" },
  ],
): Promise<void> {
  await seedWorkspace(h.workspaceStore, h.wsId, { name: "Acme" });
  for (const m of members) {
    await h.workspaceStore.addMember(h.wsId, m.userId, m.role);
  }
}

function buildTool(h: Harness, identity: UserIdentity | null, wsIdOverride?: string | null) {
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
    operatorConfigured?: boolean;
  }>;
  errors?: Array<{ file: string; message: string }>;
  key?: string;
  keys?: Array<{ key: string; updatedAt: string }>;
}

/** A ref's own client id; undefined for no client or one naming an instance app. */
function registeredClientId(client: OAuthClientConfig | undefined): string | undefined {
  return client && "clientId" in client ? client.clientId : undefined;
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
      catalogId: DROPBOX_ID,
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
      catalogId: DROPBOX_ID,
      clientId: "cid-public",
      clientSecret: "sec-private",
    });

    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
    expect(structured(result).clientId).toBe("cid-public");

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]?.clientId).toBe("cid-public");
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]?.configuredBy).toBe(ADMIN_USER.id);

    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      DROPBOX_SECRET_KEY,
      TEST_READ,
    );
    expect(wrapped?.reveal()).toBe("sec-private");
  });

  test("upsert: calling twice updates both clientId and clientSecret", async () => {
    const tool = buildTool(h, ADMIN_USER);

    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-v1",
      clientSecret: "sec-v1",
    });
    const second = await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-v2",
      clientSecret: "sec-v2",
    });

    expect(second.isError).toBe(false);
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]?.clientId).toBe("cid-v2");
    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      DROPBOX_SECRET_KEY,
      TEST_READ,
    );
    expect(wrapped?.reveal()).toBe("sec-v2");
  });

  test("rejects missing wsId / catalogId / clientId / clientSecret", async () => {
    const noWs = buildTool(h, ADMIN_USER, null);
    expect(
      (
        await noWs.handler({
          action: "setup_operator",
          catalogId: DROPBOX_ID,
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
          catalogId: DROPBOX_ID,
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          catalogId: DROPBOX_ID,
          clientId: "x",
        })
      ).isError,
    ).toBe(true);
  });

  test("rejects unknown workspace and unknown catalog entry", async () => {
    const fakeWs = buildTool(h, ADMIN_USER, "ws_004f1f715b791487");
    const r1 = await fakeWs.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
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
    // com.notion/mcp is auth: "dcr" in the default catalog
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: NOTION_ID,
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
        catalogId: DROPBOX_ID,
        clientId: "cid-orphan",
        clientSecret: "sec-orphan",
      }),
    ).rejects.toThrow("simulated workspace.json failure");
    h.workspaceStore.update = original;

    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      DROPBOX_SECRET_KEY,
      TEST_READ,
    );
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
      catalogId: DROPBOX_ID,
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
        catalogId: DROPBOX_ID,
        clientId: "cid-v2",
        clientSecret: "sec-v2",
      }),
    ).rejects.toThrow("simulated workspace.json failure on rotate");
    h.workspaceStore.update = original;

    // Credential store now holds the new secret (the put already
    // landed before the failure) — but it's NOT been deleted, because
    // there was a prior valid secret under the same key.
    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      DROPBOX_SECRET_KEY,
      TEST_READ,
    );
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
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const memberTool = buildTool(h, NON_ADMIN_USER);
    const result = await memberTool.handler({
      action: "remove_operator_setup",
      catalogId: DROPBOX_ID,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("errors when no setup exists for the catalog entry", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: DROPBOX_ID,
    });
    expect(result.isError).toBe(true);
  });

  test("refuses while the connector is currently installed in workspace.connectors", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    // Simulate an installed connector by appending the ConnectorRef directly.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws).not.toBeNull();
    await h.workspaceStore.update(h.wsId, {
      connectors: [
        ...(ws?.connectors ?? []),
        { url: DROPBOX_URL, serverName: DROPBOX_ID } as ConnectorRef,
      ],
    });

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: DROPBOX_ID,
    });
    expect(result.isError).toBe(true);
  });

  test("on success removes both clientId from workspace.json and the credential", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: DROPBOX_ID,
    });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]).toBeUndefined();
    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      DROPBOX_SECRET_KEY,
      TEST_READ,
    );
    expect(wrapped).toBeNull();
  });

  test("succeeds on a workspace where the connector was never installed", async () => {
    // `connectors[]` empty + setup configured + no install ⇒ removable.
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.connectors).toEqual([]);

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: DROPBOX_ID,
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

  test("aggregates entries from the catalog directory by default", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "list_directory" });
    expect(result.isError).toBe(false);
    const entries = structured(result).entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
  });

  test("static entry shows operatorConfigured: false before setup_operator runs", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "list_directory" });
    const dropbox = (structured(result).entries ?? []).find((e) => e.id === DROPBOX_ID);
    expect(dropbox).toBeDefined();
    expect(dropbox?.operatorConfigured).toBe(false);
  });

  test("static entry shows operatorConfigured: true after setup_operator runs", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const result = await tool.handler({ action: "list_directory" });
    const dropbox = (structured(result).entries ?? []).find((e) => e.id === DROPBOX_ID);
    expect(dropbox?.operatorConfigured).toBe(true);
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
    const result = await tool.handler({
      action: "install",
      entry: dropboxEntry(),
      wsId: h.wsId,
    });
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
        [DROPBOX_ID]: {
          clientId: "cid-only",
          configuredAt: new Date().toISOString(),
          configuredBy: ADMIN_USER.id,
        },
      },
    });

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: dropboxEntry(),
      wsId: h.wsId,
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("client_secret");
  });

  test("on success the ConnectorRef in workspace.connectors carries oauthClient pointing at the credential", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-public",
      clientSecret: "sec-private",
    });

    const result = await tool.handler({
      action: "install",
      entry: dropboxEntry(),
      wsId: h.wsId,
    });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
    // serverName is the slug of the canonical reverse-DNS form
    // (`com.dropbox/mcp` → `com-dropbox-mcp`) — opaque, URL-safe, route-safe.
    expect(structured(result).serverName).toBe("com-dropbox-mcp");

    const ws = await h.workspaceStore.get(h.wsId);
    const installed = ws?.connectors.find(
      (b): b is Extract<ConnectorRef, { url: string }> => "url" in b && b.url === DROPBOX_URL,
    );
    expect(installed).toBeDefined();
    expect(installed?.oauthClient).toEqual({
      clientId: "cid-public",
      clientSecret: { ref: "credential", key: DROPBOX_SECRET_KEY },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// setup_operator on an installed connector — the rotated client reaches it
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.setup_operator on an installed connector", () => {
  const SERVER = "com-dropbox-mcp";
  const scope = () => ({ kind: "workspace" as const, wsId: h.wsId });
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-old",
      clientSecret: "sec-old",
    });
    const installed = await tool.handler({
      action: "install",
      entry: dropboxEntry(),
      wsId: h.wsId,
    });
    expect(installed.isError).toBe(false);
    // A completed sign-in under the old client.
    await h.credStore.put(scope(), `mcp-oauth.${SERVER}.tokens`, '{"access_token":"old"}');
    await h.credStore.put(scope(), `mcp-oauth.${SERVER}.identity`, '{"sub":"someone"}');
    h.lifecycle.recordConnectionStateChange(SERVER, h.wsId, "_workspace", "running");
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  async function installedRef(): Promise<ConnectorRef | undefined> {
    const ws = await h.workspaceStore.get(h.wsId);
    return ws?.connectors.find((b) => b.url === DROPBOX_URL);
  }

  async function oauthKeys(): Promise<string[]> {
    return (await h.credStore.list(scope()))
      .map((k) => k.key)
      .filter((k) => k.startsWith("mcp-oauth."));
  }

  test("a new client id reaches the persisted ref and the live instance", async () => {
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-new",
      clientSecret: "sec-new",
    });
    expect(result.isError).toBe(false);

    expect(registeredClientId((await installedRef())?.oauthClient)).toBe("cid-new");
    expect(registeredClientId(h.lifecycle.getInstance(SERVER, h.wsId)?.ref?.oauthClient)).toBe(
      "cid-new",
    );
  });

  test("a new client id drops the old sign-in and asks for a new one", async () => {
    await buildTool(h, ADMIN_USER).handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-new",
      clientSecret: "sec-new",
    });

    expect(await oauthKeys()).toEqual([]);
    const instance = h.lifecycle.getInstance(SERVER, h.wsId);
    expect(instance?.connections?.get("_workspace")?.state).toBe("not_authenticated");
  });

  test("the same client id with a new secret keeps the sign-in", async () => {
    await buildTool(h, ADMIN_USER).handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-old",
      clientSecret: "sec-new",
    });

    expect(registeredClientId((await installedRef())?.oauthClient)).toBe("cid-old");
    expect((await oauthKeys()).sort()).toEqual([
      `mcp-oauth.${SERVER}.identity`,
      `mcp-oauth.${SERVER}.tokens`,
    ]);
    // The secret is a reference, so the new value is what the next read sees.
    const secret = await h.credStore.get(scope(), DROPBOX_SECRET_KEY, {
      caller: "test",
      purpose: "assert the rotated secret",
    });
    expect(secret?.reveal()).toBe("sec-new");
  });
});

describe("manage_connectors.setup_operator before install", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("records the operator app and touches no connector", async () => {
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid-first",
      clientSecret: "sec-first",
    });
    expect(result.isError).toBe(false);
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]?.clientId).toBe("cid-first");
    expect(ws?.connectors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// uninstall of a static-auth connector — the operator app goes with its last user
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.uninstall of a static-auth connector", () => {
  const SERVER = "com-dropbox-mcp";
  const scope = () => ({ kind: "workspace" as const, wsId: h.wsId });
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    const installed = await tool.handler({
      action: "install",
      entry: dropboxEntry(),
      wsId: h.wsId,
    });
    expect(installed.isError).toBe(false);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  async function operatorConfigured(): Promise<boolean | undefined> {
    const result = await buildTool(h, ADMIN_USER).handler({ action: "list_directory" });
    return (structured(result).entries ?? []).find((e) => e.id === DROPBOX_ID)?.operatorConfigured;
  }

  test("removing the last user clears the operator app, so the entry needs Set up again", async () => {
    expect(await operatorConfigured()).toBe(true);

    const result = await buildTool(h, ADMIN_USER).handler({
      action: "uninstall",
      serverName: SERVER,
    });
    expect(result.isError).toBe(false);

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]).toBeUndefined();
    expect(await h.credStore.get(scope(), DROPBOX_SECRET_KEY, TEST_READ)).toBeNull();
    expect(await operatorConfigured()).toBe(false);
  });

  test("the result lists the removed client secret key", async () => {
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "uninstall",
      serverName: SERVER,
    });
    const out = result.structuredContent as { deletedSecretKeys?: string[] };
    expect(out.deletedSecretKeys).toEqual([DROPBOX_SECRET_KEY]);
  });

  test("a client secret that fails to delete is reported with its error", async () => {
    const realDelete = h.credStore.delete.bind(h.credStore);
    h.credStore.delete = async (scope, key) => {
      if (key === DROPBOX_SECRET_KEY) throw new Error("store unavailable");
      return realDelete(scope, key);
    };

    const result = await buildTool(h, ADMIN_USER).handler({
      action: "uninstall",
      serverName: SERVER,
    });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as {
      failedSecretKeys?: string[];
      secretDeleteError?: string;
    };
    expect(out.failedSecretKeys).toEqual([DROPBOX_SECRET_KEY]);
    expect(out.secretDeleteError).toBe("store unavailable");
  });

  test("an app another installed connector still uses is kept, and said", async () => {
    // A second ref built on the same operator app: same url, same secret ref.
    const ws = await h.workspaceStore.get(h.wsId);
    const first = ws?.connectors.find((c) => c.serverName === SERVER);
    expect(first?.oauthClient).toBeDefined();
    await h.workspaceStore.update(h.wsId, {
      connectors: [
        ...(ws?.connectors ?? []),
        { ...first, serverName: `${SERVER}-2` } as ConnectorRef,
      ],
    });

    const result = await buildTool(h, ADMIN_USER).handler({
      action: "uninstall",
      serverName: SERVER,
    });
    expect(result.isError).toBe(false);
    const out = result.structuredContent as {
      deletedSecretKeys?: string[];
      retainedSecretKeys?: string[];
    };
    expect(out.deletedSecretKeys).toEqual([]);
    expect(out.retainedSecretKeys).toEqual([DROPBOX_SECRET_KEY]);

    const after = await h.workspaceStore.get(h.wsId);
    expect(after?.oauthOperatorApps?.[DROPBOX_ID]?.clientId).toBe("cid");
    expect((await h.credStore.get(scope(), DROPBOX_SECRET_KEY, TEST_READ))?.reveal()).toBe("sec");
    expect(await operatorConfigured()).toBe(true);
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

  test("connectorsAllowList blocks entries whose id isn't on the list", async () => {
    // An operator authors the allow-list in workspace.json; no runtime path
    // writes it, so the test seeds the record the same way.
    const wsFile = join(h.workspaceStore.getWorkspacesDir(), h.wsId, "workspace.json");
    const ws = await h.workspaceStore.get(h.wsId);
    writeFileSync(wsFile, JSON.stringify({ ...ws, connectorsAllowList: ["ipinfo"] }));

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: unsupportedEntry(),
      wsId: h.wsId,
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("not visible in this workspace");
  });

  test("SECURITY: refuses a provider-auth install whose entry isn't a known catalog connector", async () => {
    // The provider class mints a fleet-trusted, workspace-scoped service token and
    // ships it to the entry's URL. Unlike every other install kind, its config must
    // NOT be trusted from the caller-supplied entry — a workspace admin could forge
    // one pointing at an in-cluster .svc with an attacker-chosen audience/scope and
    // exfiltrate a fleet token / reach the fleet rail the SSRF guard protects. The
    // handler must re-resolve from the server-trusted catalog by id and reject an
    // entry that isn't there.
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: {
        id: "evil.attacker/web",
        name: "Totally Legit",
        install: {
          kind: "remote-oauth",
          url: "http://mcp-authorizer.mcp-shared.svc/token",
          transportType: "streamable-http",
          auth: "provider",
          providerAuth: {
            provider: "minted",
            config: { audience: "artifacts", scope: "artifacts:write" },
          },
        },
      },
      wsId: h.wsId,
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toMatch(/not a recognized platform connector/i);
    // Nothing forged was persisted into workspace.json.
    const ws = await h.workspaceStore.get(h.wsId);
    const connectors = (ws?.connectors ?? []) as Array<{ url?: string }>;
    expect(connectors.some((b) => (b.url ?? "").includes("mcp-authorizer"))).toBe(false);
  });

  test("install hard-errors when there is no workspace in context (no session, no wsId arg)", async () => {
    // Install defaults to the request's workspace (`getWorkspaceId()`),
    // but here the session workspace is explicitly null (third arg to
    // buildTool) and the call omits `wsId` — so there is no workspace
    // anywhere. The tool must NOT recover a target from identity; with
    // nothing in context it hard-errors, naming the missing arg. (This is
    // the no-default-to-personal guard: it fires only when no workspace is
    // in scope at all, not on the normal path where the route supplies one.)
    const tool = buildTool(h, ADMIN_USER, null);
    const result = await tool.handler({ action: "install", entry: unsupportedEntry() });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("wsid is required");
  });

  test("install hard-errors when wsId is the empty string", async () => {
    // Whitespace / empty-string wsId is treated as missing. A client
    // that omitted the field and stringified `undefined` would land
    // here; the contract is the same as missing.
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", entry: unsupportedEntry(), wsId: "" });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("wsid is required");
  });

  test("install hard-errors when wsId names a workspace the caller is not a member of", async () => {
    // Adversarial: a tampered client could pick a wsId outside the
    // user's membership. The install must refuse — credentials would
    // otherwise land in a workspace the caller has no right to seed.
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: unsupportedEntry(),
      wsId: "ws_002cbcedbb32d4b3",
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("not found");
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    // Workspace-scope install widens the shared workspace surface
    // (placements, tools, credential inheritance). Non-admin members
    // can't unilaterally add connectors every other member then sees.
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: unsupportedEntry(),
      wsId: h.wsId,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("returns permission_denied for an org admin who is NOT a member of the target workspace", async () => {
    // Strict workspace-scoped-write policy (#389): orgRole grants NO
    // bypass. An org admin who isn't a workspace admin member of
    // the target workspace cannot install — they must be seated as a
    // workspace admin first. This is the behavior change from the old
    // org-admin override in isWorkspaceAdmin.
    const orgAdminNonMember: UserIdentity = {
      id: "usr_org_admin",
      email: "org-admin@example.test",
      displayName: "Org Admin",
      orgRole: "admin",
      preferences: {},
    };
    const tool = buildTool(h, orgAdminNonMember);
    const result = await tool.handler({
      action: "install",
      entry: unsupportedEntry(),
      wsId: h.wsId,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("rejects remote-oauth entry with non-http(s) URL", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: {
        id: "io.evil/mcp",
        name: "Evil",
        description: "x",
        install: {
          kind: "remote-oauth",
          url: "javascript:alert(1)",
          auth: "dcr",
        },
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("install action is required");
  });

  test("rejects remote-oauth entry whose install.additionalAuthorizationParams contains a reserved OAuth key", async () => {
    // Defense-in-depth at the parse boundary. A malicious aggregator
    // shipping `additionalAuthorizationParams: { client_id: "evil" }`
    // would let the catalog override an OAuth-flow-critical parameter.
    // The runtime gate in WorkspaceOAuthProvider's constructor still
    // catches it later, but failing here gives a source-tagged warning
    // that names the offending entry. Field lives on `install`, not
    // top-level — pre-fix this gate read `entry.additionalAuthorizationParams`
    // (always undefined per the projection's shape) and was a silent
    // no-op (QA round 5b).
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      entry: {
        id: "io.evil/mcp",
        name: "Evil",
        description: "x",
        install: {
          kind: "remote-oauth",
          url: "https://mcp.evil.test/mcp",
          auth: "dcr",
          additionalAuthorizationParams: { client_id: "attacker-controlled" },
        },
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("install action is required");
  });

  test("single-member workspace install: an explicit wsId is the target; stored ref has oauthScope=workspace", async () => {
    // Any workspace is a valid install target — the caller supplies the
    // target wsId (from the active `/w/<slug>` route or an explicit arg) and
    // the tool installs there. Pin three things:
    //   - The recorded `wsId` is the one supplied.
    //   - The persisted ConnectorRef carries `oauthScope: "workspace"`.
    //     There is no "user" literal.
    //   - The slug-shaped serverName is unchanged.
    const adminPersonalWsId = "ws_00130226f6411195";
    await seedWorkspace(h.workspaceStore, adminPersonalWsId, {
      name: "Admin's workspace",
      members: [{ userId: ADMIN_USER.id, role: "admin" }],
    });
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      wsId: adminPersonalWsId,
      entry: {
        id: "com.canva/mcp",
        name: "Canva",
        description: "x",
        install: {
          kind: "remote-oauth",
          url: "https://mcp.canva.com/mcp",
          auth: "dcr",
        },
      },
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { serverName?: string; scope?: string; wsId?: string };
    const sn = sc.serverName ?? "";
    expect(sn).not.toContain("/");
    expect(sn).not.toContain(".");
    expect(sn).toBe("com-canva-mcp");
    expect(sc.scope).toBe("workspace");
    expect(sc.wsId).toBe(adminPersonalWsId);

    // Persisted ref pins the shape: oauthScope: "workspace"
    // (there is no "user" literal).
    const personalWs = await h.workspaceStore.get(adminPersonalWsId);
    const installed = personalWs?.connectors.find(
      (b): b is Extract<ConnectorRef, { url: string }> =>
        "url" in b && b.url === "https://mcp.canva.com/mcp",
    );
    expect(installed).toBeDefined();
    expect(installed?.oauthScope).toBe("workspace");
  });

  test("a reattached orphan takes its entry's host UI only when it is the entry's server", async () => {
    // An entry with a placement, and a stored ref under its name with no live
    // instance: a re-install reattaches the stored ref (`handleDuplicateInstall`).
    const dir = mkdtempSync(join(tmpdir(), "nb-reattach-catalog-"));
    const entryUi = {
      placements: [{ slot: "sidebar.apps", resourceUri: "ui://app/main", route: "app" }],
    };
    writeFileSync(
      join(dir, "catalog.json"),
      JSON.stringify({
        servers: [
          {
            name: "ai.example/app",
            description: "App",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url: "https://app.example.test/mcp" }],
            _meta: { "ai.nimblebrain/host": { host_version: "1.0", ...entryUi } },
          },
        ],
      }),
    );
    h.runtime.getConnectorCatalog = () => new ConnectorCatalog(dir);
    const stored = {
      placements: [{ slot: "sidebar.apps", resourceUri: "ui://app/stored", route: "stored" }],
    };
    const reattach = async (url: string) => {
      await h.workspaceStore.update(h.wsId, {
        connectors: [{ url, serverName: "ai-example-app", ui: stored }],
      });
      const result = await buildTool(h, ADMIN_USER).handler({
        action: "install",
        wsId: h.wsId,
        entry: {
          id: "ai.example/app",
          name: "App",
          description: "x",
          install: { kind: "remote-oauth", url: "https://app.example.test/mcp", auth: "dcr" },
        },
      });
      expect(structured(result).alreadyInstalled).toBe(false);
      const ui = h.lifecycle.getInstance("ai-example-app", h.wsId)?.ui;
      h.lifecycle.removeInstance("ai-example-app", h.wsId);
      return ui;
    };
    try {
      expect(await reattach("https://app.example.test/mcp")).toEqual(entryUi);
      expect(await reattach("https://elsewhere.test/mcp")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a catalog connector is installed at its entry's URL, not the caller's", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "install",
      wsId: h.wsId,
      entry: {
        id: "com.notion/mcp",
        name: "Notion",
        description: "x",
        install: { kind: "remote-oauth", url: "https://elsewhere.test/mcp", auth: "dcr" },
      },
    });
    expect(result.isError).toBe(false);
    const ws = await h.workspaceStore.get(h.wsId);
    const ref = ws?.connectors.find((r) => r.serverName === "com-notion-mcp");
    expect(ref?.url).toBe("https://mcp.notion.com/mcp");
  });

  test("install into a shared workspace records wsId on the structuredContent (audit attribution)", async () => {
    // Audit attribution: every install event must
    // surface the picked `wsId`, NOT the session's active
    // workspace. We can't observe the persisted audit-log event
    // from the unit-test harness (NoopEventSink), but the
    // structuredContent IS the audit attribution surface — the
    // EventSink writer reads the same shape. Pinning `sc.wsId ===
    // <picked>` regardless of the harness's `h.wsId` rules out the
    // "ambient session leak" failure mode.
    const ws2 = await h.workspaceStore.create("Helix");
    await h.workspaceStore.addMember(ws2.id, ADMIN_USER.id, "admin");
    const tool = buildTool(h, ADMIN_USER, h.wsId); // session header says ws_000f7ed6658f9d30
    const result = await tool.handler({
      action: "install",
      wsId: ws2.id, // picker names the second workspace
      entry: {
        id: "com.canva/mcp",
        name: "Canva",
        description: "x",
        install: { kind: "remote-oauth", url: "https://mcp.canva.com/mcp", auth: "dcr" },
      },
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { wsId?: string };
    // The picked wsId is what the install recorded — the dispatcher did not
    // silently fall back to the session header's h.wsId.
    expect(sc.wsId).toBe(ws2.id);
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

  // Workspace-scope tool policy decides what the workspace's agent may call for
  // every member, so it carries the same admin gate its seven siblings in this
  // file carry. It was the one workspace-scoped write in `connector-tools.ts`
  // with no gate at all (#748) — reachable through `/mcp` and the agent, not
  // just the settings UI, which is why the fix is here and not in the client.
  test("a workspace member cannot set workspace tool policy", async () => {
    await seedConnector(h);
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "set_permissions",
      serverName: STUB_SERVER_NAME,
      scope: "workspace",
      tools: { read: "disallow" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Workspace admin role required");
    expect((result.structuredContent as { error?: string } | undefined)?.error).toBe(
      "permission_denied",
    );
  });

  test("a workspace admin can", async () => {
    // The negative above is worthless without this: a handler that refused
    // everyone would satisfy it.
    await seedConnector(h);
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_permissions",
      serverName: STUB_SERVER_NAME,
      scope: "workspace",
      tools: { read: "disallow" },
    });
    expect(result.isError).toBe(false);
    expect((result.structuredContent as { ok?: boolean } | undefined)?.ok).toBe(true);
    // ...and the policy actually persisted, so this can't pass on a handler
    // that returns ok without writing.
    const last = h.permissionWrites.at(-1);
    expect(last?.owner.scope).toBe("workspace");
    expect(last?.tools).toEqual({ read: "disallow" });
  });
});

const STUB_SERVER_NAME = "ipinfo-stub";
const STUB_URL = "https://ipinfo.example.com/mcp";

/**
 * Seed one connector instance into the lifecycle so handlers find it via
 * `getInstance(serverName, wsId)`. Lighter than the full source setup the
 * production lifecycle does — only `list_installed` needs a registered
 * ToolSource.
 */
async function seedConnector(h: Harness): Promise<void> {
  await h.lifecycle.seedInstance(
    STUB_SERVER_NAME,
    STUB_URL,
    { url: STUB_URL, serverName: STUB_SERVER_NAME },
    { manifestName: STUB_SERVER_NAME, version: "1.0.0", ui: null },
    h.wsId,
  );
}

describe("manage_connectors.get_installed", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns { installed: null } when the connector isn't installed in any scope", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "get_installed",
      serverName: "no-such-connector",
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

  test("names the signed-in account; the full list does not read it", async () => {
    // Records first: seeding derives the boot state from the stored tokens.
    const owner = { type: "workspace", wsId: h.wsId } as const;
    const records = new McpOAuthRecords({
      owner,
      serverName: STUB_SERVER_NAME,
    });
    await records.write("tokens", { access_token: "at", token_type: "Bearer" });
    await records.write("identity", { sub: "vendor-subject", email: "ops@acme-corp.example" });
    await seedConnector(h);
    const tool = buildTool(h, ADMIN_USER);

    const one = await tool.handler({ action: "get_installed", serverName: STUB_SERVER_NAME });
    const installed = (
      one.structuredContent as { installed: { state: string; identity?: unknown } }
    ).installed;
    expect(installed.state).toBe("running");
    expect(installed.identity).toEqual({ email: "ops@acme-corp.example" });

    // The full list backs every shell load; each identity read writes an audit
    // line, so it stays off this path.
    const all = await tool.handler({ action: "list_installed" });
    const entry = (
      all.structuredContent as { installed: Array<{ serverName: string; identity?: unknown }> }
    ).installed.find((e) => e.serverName === STUB_SERVER_NAME);
    expect(entry).toBeDefined();
    expect(entry?.identity).toBeUndefined();
  });
});

describe("manage_connectors installed entry — displayName", () => {
  // Every surface shows the name the server resolved, so the rule lives here once:
  // the catalog entry's name (its core `title ?? name`), else the server name.
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  const displayNameOf = async (): Promise<string | undefined> => {
    const one = await buildTool(h, ADMIN_USER).handler({
      action: "get_installed",
      serverName: STUB_SERVER_NAME,
    });
    return (one.structuredContent as { installed: { displayName?: string } }).installed.displayName;
  };

  test("ignores a host UI name stored on an installed ref", async () => {
    // Installs made while the host block carried `name` persisted it in the
    // ref's `ui` snapshot. Nothing reads it.
    // biome-ignore lint/plugin/never-cast: a `ui` snapshot holding the `name` and `icon` `ConnectorUiMeta` no longer has, which is the stored ref under test
    const ui = { name: "Spoofed", icon: "" } as never;
    await h.lifecycle.seedInstance(
      STUB_SERVER_NAME,
      STUB_URL,
      { url: STUB_URL, serverName: STUB_SERVER_NAME, ui },
      { manifestName: STUB_SERVER_NAME, version: "1.0.0", ui },
      h.wsId,
    );
    expect(await displayNameOf()).toBe(STUB_SERVER_NAME);
  });

  test("falls back to the server name when nothing names it", async () => {
    await seedConnector(h);
    expect(await displayNameOf()).toBe(STUB_SERVER_NAME);
  });
});

describe("manage_connectors — disconnect applies only to a sign-in", () => {
  // Disconnect revokes a credential a person authorized so it can be redone. A
  // fleet connector's token is minted by the platform and a static credential is
  // configuration: neither has a sign-in, so neither is disconnectable.
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  const seedWith = async (transport?: Record<string, unknown>) =>
    h.lifecycle.seedInstance(
      STUB_SERVER_NAME,
      STUB_URL,
      {
        url: STUB_URL,
        serverName: STUB_SERVER_NAME,
        ...(transport ? { transport } : {}),
      },
      { manifestName: STUB_SERVER_NAME, version: "1.0.0", ui: null },
      h.wsId,
    );

  const entryFlag = async (): Promise<boolean | undefined> => {
    const one = await buildTool(h, ADMIN_USER).handler({
      action: "get_installed",
      serverName: STUB_SERVER_NAME,
    });
    return (one.structuredContent as { installed: { disconnectable?: boolean } }).installed
      .disconnectable;
  };

  test("an OAuth connection is disconnectable", async () => {
    await seedWith();
    expect(await entryFlag()).toBe(true);
  });

  test("a platform-minted (fleet) connection is not, and the tool refuses it", async () => {
    await seedWith({ type: "streamable-http", auth: { type: "provider", provider: "minted" } });
    expect(await entryFlag()).toBe(false);
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "disconnect",
      serverName: STUB_SERVER_NAME,
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text?: string } | undefined)?.text).toContain(
      "no sign-in to disconnect",
    );
  });

  test("a connection that never finished connecting is still resettable, whatever its credential", async () => {
    // The header's Cancel on a connector wedged mid-connect calls disconnect. Only an
    // ESTABLISHED connection with no sign-in is refused.
    await seedWith({ type: "streamable-http", auth: { type: "provider", provider: "minted" } });
    const instance = h.lifecycle.getInstance(STUB_SERVER_NAME, h.wsId) as { state: string };
    instance.state = "starting";
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "disconnect",
      serverName: STUB_SERVER_NAME,
    });
    expect((result.content?.[0] as { text?: string } | undefined)?.text ?? "").not.toContain(
      "no sign-in to disconnect",
    );
  });

  test("a stored static credential is not", async () => {
    await seedWith({ type: "streamable-http", auth: { type: "bearer", token: "t" } });
    expect(await entryFlag()).toBe(false);
  });
});

describe("manage_connectors.uninstall", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    await seedConnector(h);
    // Mirror what the install path writes to workspace.json.
    await h.workspaceStore.update(h.wsId, {
      connectors: [{ url: STUB_URL, serverName: STUB_SERVER_NAME }],
    });
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("strips the entry from workspace.json so it doesn't reseed at next boot", async () => {
    const wsBefore = await h.workspaceStore.get(h.wsId);
    expect(wsBefore?.connectors).toHaveLength(1);
    expect(wsBefore?.connectors[0]?.url).toBe(STUB_URL);

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "uninstall",
      serverName: STUB_SERVER_NAME,
      scope: "workspace",
    });
    expect(result.isError).toBe(false);

    const wsAfter = await h.workspaceStore.get(h.wsId);
    expect(wsAfter?.connectors ?? []).toHaveLength(0);
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    // Uninstall removes a connector every workspace member relies on
    // and clears the credential file. Non-admin can't unilaterally
    // strip a shared connector.
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "uninstall",
      serverName: STUB_SERVER_NAME,
      scope: "workspace",
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");

    // And the connector is still in workspace.json — non-admin gate
    // didn't accidentally tear down state before the check.
    const wsAfter = await h.workspaceStore.get(h.wsId);
    expect(wsAfter?.connectors ?? []).toHaveLength(1);
  });
});

describe("manage_connectors.disconnect", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
    await seedConnector(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    // Workspace-scope disconnect revokes OAuth tokens used by every
    // workspace member. Non-admin can't log the whole workspace out
    // of a shared connector.
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "disconnect",
      serverName: STUB_SERVER_NAME,
      scope: "workspace",
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });
});

describe("deriveConnectorStatus", () => {
  test("running + no probes outstanding → ready", () => {
    // This is the state a provider-auth fleet source (e.g. deep_research `web`)
    // produces: no operator OAuth client, so its inputs are bare
    // `{ state: "running" }` → ready (no bogus Connect). Boot-side coverage:
    // provider-source-boot.test.ts.
    expect(deriveConnectorStatus({ state: "running" })).toEqual({ status: "ready" });
  });

  test("missingOperatorSetup wins over every other signal — admin acts first", () => {
    // Even with state=running, an unconfigured operator OAuth client should
    // mark the connector as needs_setup. Setup is the precondition.
    const result = deriveConnectorStatus({
      state: "running",
      missingOperatorSetup: true,
    });
    expect(result.status).toBe("needs_setup");
    expect(result.statusReason).toContain("OAuth app");
  });

  test("reauth_required → needs_auth, prefers lastError over generic copy", () => {
    expect(deriveConnectorStatus({ state: "reauth_required" }).status).toBe("needs_auth");
    expect(
      deriveConnectorStatus({ state: "reauth_required", lastError: "refresh token revoked" })
        .statusReason,
    ).toBe("refresh token revoked");
  });

  test("not_authenticated → not_connected, a resting state apart from a broken connection", () => {
    expect(deriveConnectorStatus({ state: "not_authenticated" }).status).toBe("not_connected");
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

  test("setup priority outranks needs_auth — same logic, finer level", () => {
    // A connector in needs_auth state with missing operator setup should
    // still surface as needs_setup; the user can't auth against an
    // OAuth app that doesn't exist yet.
    const result = deriveConnectorStatus({
      state: "not_authenticated",
      missingOperatorSetup: true,
    });
    expect(result.status).toBe("needs_setup");
  });
});

// ─────────────────────────────────────────────────────────────────────
// install — no workspace is connectors-only
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.install — a single-member workspace admits any install kind", () => {
  let h: Harness;
  const OWN_WS = "ws_00130226f6411195";

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h); // shared ws_000f7ed6658f9d30, ADMIN_USER is admin
    await seedWorkspace(h.workspaceStore, OWN_WS, {
      name: "Admin's workspace",
      members: [{ userId: ADMIN_USER.id, role: "admin" }],
    });
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("a non-remote-oauth install is not refused for who belongs to the workspace", async () => {
    const tool = buildTool(h, ADMIN_USER, OWN_WS);
    const result = await tool.handler({ action: "install", entry: unsupportedEntry() });
    // Whatever the outcome, it is never a connectors-only rejection.
    expect(structured(result).error).not.toBe("permission_denied");
    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).not.toMatch(/personal workspace/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// set_secret / delete_secret / list_secret_keys
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors workspace secrets", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("an admin can set a secret, and the value lands in the workspace scope", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_secret",
      key: "acme.db_url",
      value: "postgres://tenant-a",
    });
    expect(result.isError).toBe(false);
    expect(structured(result).key).toBe("acme.db_url");
    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      "acme.db_url",
      TEST_READ,
    );
    expect(wrapped?.reveal()).toBe("postgres://tenant-a");
  });

  test("a non-admin member is refused", async () => {
    const tool = buildTool(h, NON_ADMIN_USER);
    for (const action of ["set_secret", "delete_secret", "list_secret_keys"]) {
      const result = await tool.handler({ action, key: "acme.db_url", value: "v" });
      expect(result.isError).toBe(true);
      expect(structured(result).error).toBe("permission_denied");
    }
  });

  test("setting the same key again rotates it", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({ action: "set_secret", key: "acme.db_url", value: "v1" });
    await tool.handler({ action: "set_secret", key: "acme.db_url", value: "v2" });
    const wrapped = await h.credStore.get(
      { kind: "workspace", wsId: h.wsId },
      "acme.db_url",
      TEST_READ,
    );
    expect(wrapped?.reveal()).toBe("v2");
  });

  test("a blank value is refused — an empty secret would resolve to an empty header", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "set_secret", key: "acme.db_url", value: "   " });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text?: string })?.text).toMatch(/delete_secret/);
  });

  test("an invalid key is refused with the grammar, not a filesystem error", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "set_secret", key: "../evil", value: "v" });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text?: string })?.text).toMatch(/invalid key/);
  });

  test("listing returns keys and timestamps and never a value", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({ action: "set_secret", key: "acme.db_url", value: "supersecret" });
    await tool.handler({ action: "set_secret", key: "acme.api_key", value: "othersecret" });
    const result = await tool.handler({ action: "list_secret_keys" });
    expect(structured(result).keys?.map((k) => k.key)).toEqual(["acme.api_key", "acme.db_url"]);
    expect(JSON.stringify(result)).not.toContain("supersecret");
    expect(JSON.stringify(result)).not.toContain("othersecret");
  });

  test("delete removes it and is idempotent", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({ action: "set_secret", key: "acme.db_url", value: "v" });
    expect((await tool.handler({ action: "delete_secret", key: "acme.db_url" })).isError).toBe(
      false,
    );
    expect((await tool.handler({ action: "delete_secret", key: "acme.db_url" })).isError).toBe(
      false,
    );
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys).toEqual([]);
  });

  test("no workspace in scope means no secret action at all", async () => {
    const tool = buildTool(h, ADMIN_USER, null);
    const result = await tool.handler({ action: "list_secret_keys" });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text?: string })?.text).toMatch(/names no workspace/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Instance operator apps — the OAuth app declared once for the instance
// ─────────────────────────────────────────────────────────────────────

/** Declare an instance operator app for Dropbox and bind it against the fixture catalog. */
async function declareDropboxInstanceApp(): Promise<void> {
  setConnectorsConfig({
    operatorApps: { [DROPBOX_ID]: { clientId: "inst-cid", clientSecret: "inst-sec" } },
  });
  await bindInstanceOperatorApps(() =>
    new ConnectorCatalog(CONNECTOR_FIXTURE_DIR).catalogByIdMap(),
  );
}

describe("manage_connectors with an instance operator app", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    _resetConnectorsConfigForTest();
    _resetInstanceOperatorAppsForTest();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("Browse reports the entry configured with no workspace setup", async () => {
    await declareDropboxInstanceApp();
    const result = await buildTool(h, ADMIN_USER).handler({ action: "list_directory" });
    const dropbox = (structured(result).entries ?? []).find((e) => e.id === DROPBOX_ID);
    expect(dropbox?.operatorConfigured).toBe(true);
  });

  test("install writes a ref naming the instance app, with no client id or secret on it", async () => {
    await declareDropboxInstanceApp();
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "install",
      entry: dropboxEntry(),
      wsId: h.wsId,
    });
    expect(result.isError).toBe(false);
    const ws = await h.workspaceStore.get(h.wsId);
    const installed = ws?.connectors.find((b) => "url" in b && b.url === DROPBOX_URL);
    expect(installed?.oauthClient).toEqual({ instanceApp: DROPBOX_ID });
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]).toBeUndefined();
  });

  test("the instance app wins over a workspace's own setup for the same entry", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "ws-cid",
      clientSecret: "ws-sec",
    });
    await declareDropboxInstanceApp();

    await tool.handler({ action: "install", entry: dropboxEntry(), wsId: h.wsId });
    const ws = await h.workspaceStore.get(h.wsId);
    const installed = ws?.connectors.find((b) => "url" in b && b.url === DROPBOX_URL);
    expect(installed?.oauthClient).toEqual({ instanceApp: DROPBOX_ID });
  });

  test("setup_operator is refused: the app is the operator's", async () => {
    await declareDropboxInstanceApp();
    const result = await buildTool(h, ADMIN_USER).handler({
      action: "setup_operator",
      catalogId: DROPBOX_ID,
      clientId: "ws-cid",
      clientSecret: "ws-sec",
    });
    expect(result.isError).toBe(true);
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[DROPBOX_ID]).toBeUndefined();
    expect(
      await h.credStore.get({ kind: "workspace", wsId: h.wsId }, DROPBOX_SECRET_KEY, {
        caller: "test",
        purpose: "assert setup wrote nothing",
      }),
    ).toBeNull();
  });

  test("an install naming another URL lands at the catalog's, the one the app serves", async () => {
    await declareDropboxInstanceApp();
    const forged = dropboxEntry();
    if (forged.install.kind === "remote-oauth") forged.install.url = "https://evil.example/mcp";
    await buildTool(h, ADMIN_USER).handler({ action: "install", entry: forged, wsId: h.wsId });
    const ws = await h.workspaceStore.get(h.wsId);
    const urls = (ws?.connectors ?? []).map((b) => ("url" in b ? b.url : undefined));
    expect(urls).toEqual([DROPBOX_URL]);
  });

  test("a personal install is accepted and names the instance app", async () => {
    await declareDropboxInstanceApp();
    const result = await buildTool(h, NON_ADMIN_USER).handler({
      action: "install",
      scope: "identity",
      entry: dropboxEntry(),
    });
    expect(result.isError).toBe(false);
    expect(structured(result).scope).toBe("identity");
    const ref = await new IdentityConnectorStore({ workDir: h.workDir }).get(
      NON_ADMIN_USER.id,
      "com-dropbox-mcp",
    );
    expect(ref && "url" in ref ? ref.oauthClient : undefined).toEqual({ instanceApp: DROPBOX_ID });
  });

  test("a personal install of a static entry is refused without an instance app", async () => {
    const result = await buildTool(h, NON_ADMIN_USER).handler({
      action: "install",
      scope: "identity",
      entry: dropboxEntry(),
    });
    expect(result.isError).toBe(true);
  });

  test("the personal catalog offers a static entry only when the instance holds its app", async () => {
    const tool = buildTool(h, NON_ADMIN_USER);
    const ids = async () =>
      (
        (await tool.handler({ action: "list_personal_catalog" })).structuredContent as {
          catalog: Array<{ id: string }>;
        }
      ).catalog.map((e) => e.id);
    expect(await ids()).not.toContain(DROPBOX_ID);
    await declareDropboxInstanceApp();
    expect(await ids()).toContain(DROPBOX_ID);
  });

  test("rotating a workspace app leaves refs that name the instance app alone", () => {
    const instanceRef: ConnectorRef = {
      url: DROPBOX_URL,
      serverName: "com-dropbox-mcp",
      oauthClient: { instanceApp: DROPBOX_ID },
    };
    const rotated = rotateInstalledOAuthClients([instanceRef], DROPBOX_URL, "new-cid");
    expect(rotated.refs).toHaveLength(0);
    expect(rotated.connectors[0]).toBe(instanceRef);
  });
});
