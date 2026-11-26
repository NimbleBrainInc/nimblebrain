import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import { buildManagedConnectorRegistry } from "../../src/connectors/providers/registry.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { PermissionStore } from "../../src/permissions/permission-store.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { requireCredentialStore } from "../../src/tools/credential-store.ts";
import { McpOAuthRecords } from "../../src/tools/mcp-oauth-records.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { stub } from "../helpers/stub.ts";

/**
 * Integration coverage for `manage_connectors.install` with `scope: "identity"`
 * — installing a personal connector on the caller's own identity plane
 * (`users/<id>/connectors.json`) instead of into a workspace.
 *
 * Scope of the slice under test: DCR (standard OAuth) and composio connectors.
 * static / provider auth are workspace/platform-bound and rejected here — a
 * separate slice. The composio session-creation path needs a module-level SDK
 * mock, so its happy path lives in the unit suite
 * (`connector-tools-composio-install.test.ts`); here we pin the gate (composio is
 * admitted, and fails on the missing platform prerequisite, not the auth type).
 * A connector can be both a personal connector and a workspace install: the two
 * are owned apart (identity vs workspace) and reached through different doors.
 */

const USER: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.test",
  displayName: "Alice",
  orgRole: "member",
  preferences: {},
};

function dcrEntry(): CatalogListing {
  return {
    id: "ai.granola/mcp",
    name: "Granola",
    description: "Meeting notes",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.granola.ai/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

function composioEntry(): CatalogListing {
  return {
    id: "io.asana/mcp",
    name: "Asana",
    description: "Tasks",
    install: {
      kind: "remote-oauth",
      url: "https://backend.composio.dev/v3/mcp",
      transportType: "streamable-http",
      auth: "composio",
      composio: { toolkit: "asana" },
    },
  };
}

/** A `remote-oauth` entry whose id the operator catalog does not list. */
function uncataloguedEntry(): CatalogListing {
  return {
    id: "zz.attacker/not-in-catalog",
    name: "Looks Official",
    description: "x",
    install: {
      kind: "remote-oauth",
      url: "https://attacker.example.test/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

function unsupportedEntry(): CatalogListing {
  return {
    id: "dev.example/tool",
    name: "Some Tool",
    description: "A pasted-URL entry (the direct-url kind, workspace-only)",
    install: { kind: "direct-url", url: "https://tool.example.com/mcp" },
  };
}

interface Harness {
  workDir: string;
  sharedWsId: string;
  /** A workspace the caller alone belongs to — the kind provisioning gives a new user. */
  ownWsId: string;
  grants: Record<string, string[]>;
  toolPolicies: Record<string, unknown>;
  /** Every event the tool emitted on the runtime's sink, in order. */
  events: EngineEvent[];
  tool: ReturnType<typeof createManageConnectorsTool>;
}

/** The `connector.grant_changed` payloads emitted so far. */
function grantChanges(h: Harness): unknown[] {
  return h.events.filter((e) => e.type === "connector.grant_changed").map((e) => e.data);
}

/**
 * `hostLoopback` is the local-install gate: `null` (the default) is a hosted
 * instance, where adding a server by URL is refused.
 */
async function buildHarness(hostLoopback: string | null = null): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-identity-install-"));
  // Identity OAuth tokens and DCR registrations are keys in the credential store, which
  // the runtime installs at its composition root; this harness has no runtime.
  installTestCredentialStore(workDir);

  const workspaceStore = new WorkspaceStore(workDir);
  const events: EngineEvent[] = [];
  const eventSink = { emit: (event: EngineEvent) => events.push(event) };
  const lifecycle = new ConnectorLifecycleManager(eventSink);
  const workspaceRegistry = new ToolRegistry();

  // One shared workspace (admin) + a workspace the caller alone belongs to.
  const sharedWsId = (await workspaceStore.create("Helix")).id;
  await workspaceStore.addMember(sharedWsId, USER.id, "admin");
  const ownWs = await workspaceStore.create("User's workspace", {
    members: [{ userId: USER.id, role: "admin" }],
  });
  const ownWsId = ownWs.id;

  const grants: Record<string, string[]> = {};
  // Per-tool allow/deny policies, keyed serverName — the user-scope
  // `connectors[serverName]` block a disconnect must also clear.
  const toolPolicies: Record<string, unknown> = {};
  const runtime = stub<Runtime>({
    getWorkDir: () => workDir,
    getEventSink: () => eventSink,
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getConnectorCatalog: () => new ConnectorCatalog(CONNECTOR_FIXTURE_DIR),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    getPermissionStore: () =>
      stub<PermissionStore>({
        deleteConnector: async (owner: { scope: string }, serverName: string) => {
          if (owner.scope === "user") delete toolPolicies[serverName];
        },
        listConnectorGrants: async (_userId: string) => grants,
        getConnectorGrants: async (_userId: string, serverName: string) => grants[serverName] ?? [],
        // Idempotent, as the real store is.
        grantConnector: async (_userId: string, serverName: string, wsId: string) => {
          const existing = grants[serverName] ?? [];
          if (existing.includes(wsId)) return false;
          grants[serverName] = [...existing, wsId];
          return true;
        },
        revokeConnector: async (_userId: string, serverName: string, wsId: string) => {
          const existing = grants[serverName] ?? [];
          if (!existing.includes(wsId)) return false;
          const remaining = existing.filter((id) => id !== wsId);
          if (remaining.length === 0) delete grants[serverName];
          else grants[serverName] = remaining;
          return true;
        },
      }),
    getAllowInsecureRemotes: () => false,
    getHostLoopback: () => hostLoopback,
    getCredentialStore: () => requireCredentialStore(),
    getManagedConnectorRegistry: () => buildManagedConnectorRegistry(),
  });

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => USER,
    getWorkspaceId: () => sharedWsId,
  };
  return {
    workDir,
    sharedWsId,
    ownWsId,
    grants,
    toolPolicies,
    events,
    tool: createManageConnectorsTool(ctx),
  };
}

function resultText(result: { content?: unknown }): string {
  const content = result.content as Array<{ text?: string }> | undefined;
  return content?.[0]?.text ?? "";
}

describe("manage_connectors.install scope:identity — DCR personal-connector install", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    resetTestCredentialStore();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("writes users/<id>/connectors.json and reports scope:identity", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { scope?: string; serverName?: string; ok?: boolean };
    expect(sc.ok).toBe(true);
    expect(sc.scope).toBe("identity");

    // Persisted on the identity plane — not into any workspace.
    const refs = await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id);
    expect(refs).toHaveLength(1);
    const ref = refs[0] as { url?: string; oauthScope?: unknown };
    expect(ref.url).toBe("https://mcp.granola.ai/mcp");
    // Identity refs are user-owned structurally and carry NO oauthScope literal.
    expect(ref.oauthScope).toBeUndefined();
    // Fresh install reports alreadyInstalled:false (symmetric with the dup path).
    expect((result.structuredContent as { alreadyInstalled?: boolean }).alreadyInstalled).toBe(
      false,
    );
  });

  test("re-installing an already-installed connector is idempotent (alreadyInstalled:true, one ref)", async () => {
    const first = await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    expect(first.isError).toBe(false);

    const second = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
    });
    expect(second.isError).toBe(false);
    const sc = second.structuredContent as { ok?: boolean; alreadyInstalled?: boolean };
    expect(sc.ok).toBe(true);
    expect(sc.alreadyInstalled).toBe(true);

    // Upsert-idempotent: still exactly one ref (no duplicate row).
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(1);
  });

  test("list_personal_connectors reads the identity plane after an identity install", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const result = await h.tool.handler({ action: "list_personal_connectors" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      connectors: Array<{ serverName: string; state: string; grantedWorkspaces: string[] }>;
    };
    expect(sc.connectors).toHaveLength(1);
    // Resting state for an installed-but-not-yet-connected personal connector.
    expect(sc.connectors[0].state).toBe("not_authenticated");
    expect(sc.connectors[0].grantedWorkspaces).toEqual([]);
  });

  test("state is `running` from persisted tokens, even with a cold source (survives a pod roll)", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });

    // Simulate a completed OAuth: tokens stored, but the source is NOT warmed in
    // this process (a fresh pod). The state must come from the stored tokens, or
    // the UI offers a Connect that then fails.
    await new McpOAuthRecords({
      owner: { type: "user", userId: USER.id },
      serverName: "ai-granola-mcp",
    }).write("tokens", { access_token: "x" });

    const result = await h.tool.handler({ action: "list_personal_connectors" });
    const sc = result.structuredContent as { connectors: Array<{ state: string }> };
    expect(sc.connectors[0].state).toBe("running");
  });

  test("refuses a direct-url entry on a hosted instance before the personal path", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: unsupportedEntry(),
      scope: "identity",
      wsId: h.sharedWsId,
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: string }).error).toBe("DIRECT_URL_NOT_ALLOWED");
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
    expect(h.grants).toEqual({});
  });

  test("rejects a non-remote-oauth entry on a local install — personal connectors are remote MCP connections", async () => {
    const local = await buildHarness("127.0.0.1");
    try {
      const result = await local.tool.handler({
        action: "install",
        entry: unsupportedEntry(),
        scope: "identity",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/remote MCP connection/i);
      // Nothing written to the identity plane.
      expect(
        await new IdentityConnectorStore({ workDir: local.workDir }).list(USER.id),
      ).toHaveLength(0);
    } finally {
      rmSync(local.workDir, { recursive: true, force: true });
    }
  });

  test("refuses an id the catalog does not list, and a case variant of one it does", async () => {
    const caseVariant = dcrEntry();
    caseVariant.id = "AI.Granola/mcp";
    for (const entry of [uncataloguedEntry(), caseVariant]) {
      const result = await h.tool.handler({ action: "install", entry, scope: "identity" });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error?: string }).error).toBe("NOT_IN_CATALOG");
    }
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
  });

  test("a known id is installed from the catalog's entry: forged url, transport, scopes and params are dropped", async () => {
    const forged = dcrEntry();
    forged.install = {
      kind: "remote-oauth",
      url: "https://attacker.example.test/mcp",
      transportType: "sse",
      // The catalog entry is `dcr`. Were the caller's `static` trusted, the
      // personal path would refuse it (no instance OAuth client).
      auth: "static",
      oauthClientSetup: { portalUrl: "https://x.test", hint: "x", clientSecretKey: "x.secret" },
      requiredScopes: ["admin:everything"],
      additionalAuthorizationParams: { prompt: "none" },
    };
    const result = await h.tool.handler({ action: "install", entry: forged, scope: "identity" });
    expect(result.isError).toBe(false);
    const refs = await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id);
    expect(refs).toHaveLength(1);
    const ref = refs[0] as {
      url?: string;
      transport?: unknown;
      scopes?: unknown;
      additionalAuthorizationParams?: unknown;
    };
    expect(ref.url).toBe("https://mcp.granola.ai/mcp");
    expect(ref.transport).toEqual({ type: "streamable-http" });
    expect(ref.scopes).toBeUndefined();
    expect(ref.additionalAuthorizationParams).toBeUndefined();
  });

  test("rejects a connector whose slug is a reserved system name (nb) — nothing persisted", async () => {
    // A DCR entry whose id slugifies to `nb` would surface its tools as `nb__…`
    // in the trusted system band. A catalog id is reverse-DNS, so its slug
    // carries a `-` and never equals a reserved name; a bare `nb` is refused at
    // the catalog lookup, and no reserved-name record reaches connectors.json.
    const reserved: CatalogListing = {
      id: "nb",
      name: "Reserved",
      description: "collides with the system-tool prefix",
      install: {
        kind: "remote-oauth",
        url: "https://reserved.test/mcp",
        transportType: "streamable-http",
        auth: "dcr",
      },
    };
    const result = await h.tool.handler({ action: "install", entry: reserved, scope: "identity" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: string }).error).toBe("NOT_IN_CATALOG");
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
  });

  test("names the unconfigured broker rather than refusing the auth type", async () => {
    // Deterministically drive the no-key path: with COMPOSIO_API_KEY unset no
    // provider is registered, so the install refuses with the deploy-config
    // message — NOT the "not supported on this plane" gate, which is what a
    // configured Composio would pass. (The happy path — a real session + a
    // persisted ref — lives in the unit suite, which mocks the Composio SDK.)
    const savedKey = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    try {
      const result = await h.tool.handler({
        action: "install",
        entry: composioEntry(),
        scope: "identity",
      });
      expect(result.isError).toBe(true);
      // NOT the plane gate — composio is not refused by auth type.
      expect(resultText(result)).not.toMatch(/isn't supported for personal connectors yet/i);
      // It named the missing deploy config instead.
      expect(resultText(result)).toMatch(/COMPOSIO_API_KEY/);
      // A prerequisite failure persists nothing to the identity plane.
      expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(
        0,
      );
    } finally {
      if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
      else process.env.COMPOSIO_API_KEY = savedKey;
    }
  });

  test("rejects a static remote-oauth entry without an instance OAuth client", async () => {
    const staticEntry = composioEntry();
    staticEntry.id = "com.dropbox/mcp";
    staticEntry.name = "Dropbox";
    if (staticEntry.install.kind === "remote-oauth") {
      staticEntry.install.auth = "static";
      delete (staticEntry.install as { composio?: unknown }).composio;
    }
    const result = await h.tool.handler({
      action: "install",
      entry: staticEntry,
      scope: "identity",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/isn't supported for personal connectors here/i);
  });

  describe("a personal connector and a workspace install coexist (both install directions)", () => {
    test("workspace install then identity install of the same connector → both land", async () => {
      const shared = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        wsId: h.sharedWsId,
      });
      expect(shared.isError).toBe(false);

      const identity = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        scope: "identity",
      });
      expect(identity.isError).toBe(false);
      expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(
        1,
      );
    });

    test("identity install then workspace install of the same connector → both land", async () => {
      const identity = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        scope: "identity",
      });
      expect(identity.isError).toBe(false);

      const shared = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        wsId: h.sharedWsId,
      });
      expect(shared.isError).toBe(false);
    });

    test("install into the caller's own workspace then identity install → both land", async () => {
      const own = await h.tool.handler({ action: "install", entry: dcrEntry(), wsId: h.ownWsId });
      expect(own.isError).toBe(false);

      const identity = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        scope: "identity",
      });
      expect(identity.isError).toBe(false);
    });
  });
});

describe("manage_connectors.install scope:identity with wsId — install and grant in one act", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    resetTestCredentialStore();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("an id the catalog does not list installs nothing and grants nothing", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: uncataloguedEntry(),
      scope: "identity",
      wsId: h.sharedWsId,
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: string }).error).toBe("NOT_IN_CATALOG");
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
    expect(h.grants).toEqual({});
    expect(grantChanges(h)).toEqual([]);
  });

  test("grants the new personal connector into the named workspace", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
      wsId: h.sharedWsId,
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { scope?: string; grantedWsId?: string };
    expect(sc.scope).toBe("identity");
    expect(sc.grantedWsId).toBe(h.sharedWsId);
    expect(h.grants["ai-granola-mcp"]).toEqual([h.sharedWsId]);
    expect(grantChanges(h)).toEqual([
      { userId: USER.id, serverName: "ai-granola-mcp", wsId: h.sharedWsId, granted: true },
    ]);
  });

  test("without wsId, nothing is granted (the profile's install)", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    expect((result.structuredContent as { grantedWsId?: string }).grantedWsId).toBeUndefined();
    expect(h.grants["ai-granola-mcp"]).toBeUndefined();
    expect(grantChanges(h)).toEqual([]);
  });

  test("the grant precedes the connection and stands after the OAuth return, once", async () => {
    await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
      wsId: h.sharedWsId,
    });
    // Before the sign-in: installed, not connected, already on here.
    const before = (await h.tool.handler({ action: "list_personal_connectors" }))
      .structuredContent as { connectors: Array<{ state: string; grantedWorkspaces: string[] }> };
    expect(before.connectors[0]?.state).toBe("not_authenticated");
    expect(before.connectors[0]?.grantedWorkspaces).toEqual([h.sharedWsId]);

    // The OAuth callback stores the tokens.
    await new McpOAuthRecords({
      owner: { type: "user", userId: USER.id },
      serverName: "ai-granola-mcp",
    }).write("tokens", { access_token: "x" });

    // Installing again from the same workspace (a retry, or the person coming
    // back to Browse) grants nothing twice.
    const again = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
      wsId: h.sharedWsId,
    });
    expect((again.structuredContent as { alreadyInstalled?: boolean }).alreadyInstalled).toBe(true);

    const after = (await h.tool.handler({ action: "list_personal_connectors" }))
      .structuredContent as { connectors: Array<{ state: string; grantedWorkspaces: string[] }> };
    expect(after.connectors[0]?.state).toBe("running");
    expect(after.connectors[0]?.grantedWorkspaces).toEqual([h.sharedWsId]);
  });

  test("re-installing from another workspace turns it on there too", async () => {
    await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
      wsId: h.sharedWsId,
    });
    await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
      wsId: h.ownWsId,
    });
    expect(h.grants["ai-granola-mcp"]).toEqual([h.sharedWsId, h.ownWsId]);
  });

  test("refuses a workspace the caller doesn't belong to, and installs nothing", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: dcrEntry(),
      scope: "identity",
      wsId: "ws_00ffffffffffffff",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/not a member/i);
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
    expect(h.grants).toEqual({});
  });
});

describe("manage_connectors.list_directory — personalInstallable per entry", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    resetTestCredentialStore();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("matches what the personal catalog offers", async () => {
    const directory = (await h.tool.handler({ action: "list_directory" })).structuredContent as {
      entries: Array<{ id: string; personalInstallable?: boolean }>;
    };
    const personal = (await h.tool.handler({ action: "list_personal_catalog" }))
      .structuredContent as { catalog: Array<{ id: string }> };
    const offered = new Set(personal.catalog.map((e) => e.id));
    for (const e of directory.entries) {
      expect(e.personalInstallable).toBe(offered.has(e.id));
    }
    const byId = new Map(directory.entries.map((e) => [e.id, e.personalInstallable]));
    // Notion and Granola are DCR, so each person holds their own credential;
    // Granola's retired `personal` key changes nothing. Dropbox is static with no
    // instance OAuth client, so one account for the workspace, key or not.
    expect(byId.get("com.notion/mcp")).toBe(true);
    expect(byId.get("ai.granola/mcp")).toBe(true);
    expect(byId.get("com.dropbox/mcp")).toBe(false);
  });
});

describe("manage_connectors.list_personal_catalog — the curated personal-connect set", () => {
  let h: Harness;
  let savedComposioKey: string | undefined;
  beforeEach(async () => {
    // The picker offers a brokered connector only when its provider is
    // registered and brokers an interactive connect — offered ⊆ acceptable, so
    // it can never present one the install then refuses.
    savedComposioKey = process.env.COMPOSIO_API_KEY;
    process.env.COMPOSIO_API_KEY = "k_test";
    _resetComposioConfigForTest();
    h = await buildHarness();
  });
  afterEach(() => {
    if (savedComposioKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = savedComposioKey;
    _resetComposioConfigForTest();
    resetTestCredentialStore();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("withholds a brokered connector whose provider is unconfigured", async () => {
    delete process.env.COMPOSIO_API_KEY;
    _resetComposioConfigForTest();

    const result = await h.tool.handler({ action: "list_personal_catalog" });
    const ids = (result.structuredContent as { catalog: Array<{ id: string }> }).catalog.map(
      (e) => e.id,
    );
    // Granola (dcr) is unaffected; Asana's broker is not configured here, and an
    // offer the install would refuse is worse than no offer.
    expect(ids).toContain("ai.granola/mcp");
    expect(ids).not.toContain("io.asana/mcp");
  });

  test("offers every DCR and brokered connector by its auth; excludes static", async () => {
    const result = await h.tool.handler({ action: "list_personal_catalog" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      catalog: Array<{ id: string; install: { auth?: string } }>;
    };
    const ids = sc.catalog.map((e) => e.id);
    // Notion: dcr, no catalog flag → offered.
    expect(ids).toContain("com.notion/mcp");
    // Granola: dcr carrying the retired `personal` key → offered, the same as Notion.
    expect(ids).toContain("ai.granola/mcp");
    // Asana and Linear: composio, and the broker is configured → offered.
    expect(ids).toContain("io.asana/mcp");
    expect(ids).toContain("io.linear/mcp");
    // Dropbox: static with no instance OAuth client → excluded, though it carries
    // the retired key; static stays workspace-bound.
    expect(ids).not.toContain("com.dropbox/mcp");
    // Everything offered is a DCR or brokered remote MCP connection — lockstep
    // with the install gate.
    for (const e of sc.catalog) expect(["dcr", "composio"]).toContain(e.install.auth);
  });

  test("drops connectors already installed on the caller's identity", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const result = await h.tool.handler({ action: "list_personal_catalog" });
    const ids = (result.structuredContent as { catalog: Array<{ id: string }> }).catalog.map(
      (e) => e.id,
    );
    // `dcrEntry()` slugs to the same serverName as the fixture's Granola, so the
    // now-installed connector is no longer offered.
    expect(ids).not.toContain("ai.granola/mcp");
  });
});

describe("startIdentityAuth reserved-name guard", () => {
  test("rejects a reserved serverName (nb) before any wiring", async () => {
    // Defense-in-depth mirroring `startConnectorSource`: the interactive Connect
    // path builds its source directly (outside startConnectorSource), so it
    // enforces the reserved-name invariant itself. Install already blocks such a
    // record, so reaching here means a hand-edited connectors.json — it must
    // still fail closed before constructing a source named `nb`.
    const workDir = mkdtempSync(join(tmpdir(), "nb-startauth-reserved-"));
    try {
      const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
      await expect(lifecycle.startIdentityAuth("nb", USER.id, { workDir })).rejects.toThrow(
        /reserved/i,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("manage_connectors.disconnect scope:identity — sign out, keep the plugin", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    resetTestCredentialStore();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  const SERVER = "ai-granola-mcp"; // slugifyServerName("ai.granola/mcp")

  test("clears the identity credentials and keeps the install record, every grant, and the tool policies", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    await h.tool.handler({ action: "grant_connector", serverName: SERVER, wsId: h.sharedWsId });
    await h.tool.handler({ action: "grant_connector", serverName: SERVER, wsId: h.ownWsId });
    h.toolPolicies[SERVER] = { tools: { some_tool: "allow" } };
    const records = new McpOAuthRecords({
      owner: { type: "user", userId: USER.id },
      serverName: SERVER,
    });
    await records.write("tokens", { access_token: "x" });
    await records.write("identity", { email: "alice@example.test" });

    const before = await h.tool.handler({ action: "list_personal_connectors" });
    const stateOf = (r: typeof before) =>
      (r.structuredContent as { connectors: Array<{ serverName: string; state: string }> })
        .connectors[0]?.state;
    expect(stateOf(before)).toBe("running");
    h.events.length = 0;

    const result = await h.tool.handler({
      action: "disconnect",
      serverName: SERVER,
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, scope: "identity", serverName: SERVER });

    // The plugin stays: install record, both grants, its tool policy.
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(1);
    expect(h.grants[SERVER]).toEqual([h.sharedWsId, h.ownWsId]);
    expect(h.toolPolicies[SERVER]).toEqual({ tools: { some_tool: "allow" } });
    expect(grantChanges(h)).toEqual([]);
    // The account goes.
    expect(await records.has("tokens")).toBe(false);
    expect(await records.has("identity")).toBe(false);
    expect(stateOf(await h.tool.handler({ action: "list_personal_connectors" }))).toBe(
      "not_authenticated",
    );
    // Its owner's tabs hear the new state; no workspace is named, so no member does.
    expect(
      h.events.filter((e) => e.type === "connection.state_changed").map((e) => e.data),
    ).toEqual([
      {
        userId: USER.id,
        serverName: SERVER,
        connectorName: SERVER,
        principalId: USER.id,
        state: "not_authenticated",
      },
    ]);
  });

  test("a sign-in that cannot be deleted fails the sign-out and publishes no state", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const records = new McpOAuthRecords({
      owner: { type: "user", userId: USER.id },
      serverName: SERVER,
    });
    await records.write("tokens", { access_token: "x" });
    const store = requireCredentialStore();
    store.delete = async () => {
      throw new Error("store unavailable");
    };
    h.events.length = 0;

    const result = await h.tool.handler({
      action: "disconnect",
      serverName: SERVER,
      scope: "identity",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/could not sign out/i);
    expect(await records.has("tokens")).toBe(true);
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "connection.state_changed")).toEqual([]);
  });

  test("errors on a connector that isn't installed on the identity", async () => {
    const result = await h.tool.handler({
      action: "disconnect",
      serverName: "not-installed",
      scope: "identity",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/not one of your personal connectors/i);
  });
});

describe("manage_connectors.uninstall scope:identity — full remove", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    resetTestCredentialStore();
    rmSync(h.workDir, { recursive: true, force: true });
  });

  const SERVER = "ai-granola-mcp"; // slugifyServerName("ai.granola/mcp")

  test("removes the install record, revokes all grants, drops tool policies, and deletes identity credentials", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    await h.tool.handler({ action: "grant_connector", serverName: SERVER, wsId: h.sharedWsId });
    await h.tool.handler({ action: "grant_connector", serverName: SERVER, wsId: h.ownWsId });

    // A per-tool allow policy the user set on this personal connector — it must not
    // survive the removal (else it silently rebinds on a reinstall).
    h.toolPolicies[SERVER] = { tools: { some_tool: "allow" } };

    // Simulate a completed OAuth: tokens at the identity's credential scope.
    const records = new McpOAuthRecords({
      owner: { type: "user", userId: USER.id },
      serverName: SERVER,
    });
    await records.write("tokens", { access_token: "x" });

    const store = new IdentityConnectorStore({ workDir: h.workDir });
    expect(await store.list(USER.id)).toHaveLength(1);
    expect(h.grants[SERVER]).toEqual([h.sharedWsId, h.ownWsId]);
    h.events.length = 0;

    const result = await h.tool.handler({
      action: "uninstall",
      serverName: SERVER,
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      ok?: boolean;
      scope?: string;
      revokedWorkspaces?: number;
    };
    expect(sc.ok).toBe(true);
    expect(sc.scope).toBe("identity");
    expect(sc.revokedWorkspaces).toBe(2);

    // Install record gone → offered again by the catalog.
    expect(await store.list(USER.id)).toHaveLength(0);
    // Every grant revoked, and the owner's tabs told once per workspace.
    expect(h.grants[SERVER]).toBeUndefined();
    expect(grantChanges(h)).toEqual([
      { userId: USER.id, serverName: SERVER, wsId: h.sharedWsId, granted: false },
      { userId: USER.id, serverName: SERVER, wsId: h.ownWsId, granted: false },
    ]);
    // Per-tool policies dropped (no silent rebind on reconnect).
    expect(h.toolPolicies[SERVER]).toBeUndefined();
    // Identity credentials deleted.
    expect(await records.has("tokens")).toBe(false);
  });

  test("errors on a connector that isn't installed on the identity", async () => {
    const result = await h.tool.handler({
      action: "uninstall",
      serverName: "not-installed",
      scope: "identity",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/not one of your personal connectors/i);
  });

  test("uninstall with no grants succeeds (revokedWorkspaces: 0)", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const result = await h.tool.handler({
      action: "uninstall",
      serverName: SERVER,
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    expect((result.structuredContent as { revokedWorkspaces?: number }).revokedWorkspaces).toBe(0);
    expect(grantChanges(h)).toEqual([]);
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
  });
});
