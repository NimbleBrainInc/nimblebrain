/**
 * `handleInstallRemoteOAuth`'s smithery branch in `src/tools/connector-tools.ts`.
 *
 * Sibling of `connector-tools-composio-install.test.ts` and deliberately the
 * same shape: drive the REAL `manage_connectors` tool and assert on what lands
 * in `workspace.json`. Asserting against a hand-written ref would pass even if
 * the install path started persisting the live broker key, which is the one
 * property here that must never regress.
 *
 * Smithery's Connect API is stubbed at `fetch` — it has no SDK to mock, and the
 * install path's own behavior (session → transport template → ref marker) is
 * what's under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import { buildManagedConnectorRegistry } from "../../src/connectors/providers/registry.ts";
import { _resetSmitheryConfigForTest } from "../../src/connectors/providers/smithery/config.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const BASSETHOUND_ID = "ai.bassethound/mcp";
const SERVER = "nimblebrain/bassethound";
const ADMIN = { id: "usr_admin", name: "Admin", email: "admin@test" };

function bassethoundEntry(): DirectoryEntry {
  return {
    id: BASSETHOUND_ID,
    name: "Bassethound",
    description: "Company intelligence for AI agents",
    registryId: "bundled-static",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.bassethound.ai/mcp",
      transportType: "streamable-http",
      auth: "smithery",
      smithery: { server: SERVER },
    },
  } as unknown as DirectoryEntry;
}

interface Harness {
  workDir: string;
  wsId: string;
  workspaceStore: WorkspaceStore;
  runtime: Runtime;
}

function buildHarness(): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-smithery-install-"));
  const wsId = "ws_test";
  const workspaceStore = new WorkspaceStore(workDir);
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated",
          type: "static",
          enabled: true,
          locked: true,
          url: join(workDir, "catalog.yaml"),
        },
        { id: "mpak", name: "mpak", type: "mpak", enabled: false },
      ],
    }),
  );
  // The catalog must PUBLISH the entry: a smithery install is permitted only for
  // a server the operator's own catalog names, so an empty catalog would (now
  // correctly) reject every install. This mirrors a real deployment pointing
  // NB_CURATED_CATALOG_DIR at its brokered entries.
  writeFileSync(
    join(workDir, "catalog.yaml"),
    [
      "servers:",
      `  - name: ${BASSETHOUND_ID}`,
      "    title: Bassethound",
      "    description: Company intelligence for AI agents",
      '    version: "1.0.0"',
      "    remotes:",
      "      - type: streamable-http",
      "        url: https://mcp.bassethound.ai/mcp",
      "    _meta:",
      "      ai.nimblebrain/connector:",
      "        auth: smithery",
      "        smithery:",
      `          server: ${SERVER}`,
      "",
    ].join("\n"),
  );
  const registryStore = new RegistryStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: () => workspaceRegistry,
    getAllowInsecureRemotes: () => false,
    getEventSink: () => new NoopEventSink(),
    getPermissionStore: () => ({
      deleteConnector: async () => {},
      listConnectorGrants: async () => ({}),
      getConnectorGrants: async () => [],
      revokeConnector: async () => {},
    }),
    getUserStore: () => ({ get: async () => null }),
    getBundleInstancesForWorkspace: () => lifecycle.getInstances(),
    getManagedConnectorRegistry: () => buildManagedConnectorRegistry(),
  } as unknown as Runtime;

  return { workDir, wsId, workspaceStore, runtime };
}

function buildTool(h: Harness) {
  const ctx: ManageConnectorsContext = {
    runtime: h.runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => h.wsId,
  } as unknown as ManageConnectorsContext;
  return createManageConnectorsTool(ctx);
}

const TRACKED_ENV = ["SMITHERY_API_KEY", "SMITHERY_NAMESPACE", "NB_TENANT_ID"];
const SAVED_ENV: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let h: Harness;

/** Stub the Connect API upsert with a ready connection. */
function stubConnectApi(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ connectionId: "ignored", status: { state: "connected" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

beforeEach(async () => {
  for (const k of TRACKED_ENV) SAVED_ENV[k] = process.env[k];
  for (const k of TRACKED_ENV) delete process.env[k];
  _resetSmitheryConfigForTest();
  _resetConnectorsConfigForTest();
  stubConnectApi();
  h = buildHarness();
  await h.workspaceStore.create("Test", h.wsId.slice(3));
  await h.workspaceStore.addMember(h.wsId, ADMIN.id, "admin");
});

afterEach(() => {
  for (const k of TRACKED_ENV) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  _resetSmitheryConfigForTest();
  _resetConnectorsConfigForTest();
  globalThis.fetch = realFetch;
  rmSync(h.workDir, { recursive: true, force: true });
});

describe("manage_connectors.install (smithery-auth)", () => {
  /**
   * The install fails at the unmocked `startBundleSource` step (the stubbed
   * session URL isn't a live MCP server), but the BundleRef is persisted
   * BEFORE that — so we read what landed and assert its shape.
   */
  async function installAndReadPersistedRef(): Promise<
    Extract<BundleRef, { url: string }> | undefined
  > {
    const tool = buildTool(h);
    await tool.handler({ action: "install", entry: bassethoundEntry(), wsId: h.wsId });
    const ws = await h.workspaceStore.get(h.wsId);
    return ws?.bundles.find(
      (b): b is Extract<BundleRef, { url: string }> => "url" in b && "smithery" in b,
    );
  }

  test("(a) persists the smithery marker: catalog id, connection id, and namespace", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });

    const installed = await installAndReadPersistedRef();
    expect(installed).toBeDefined();
    expect(installed?.smithery?.connectorId).toBe(BASSETHOUND_ID);
    expect(installed?.smithery?.namespace).toBe("test-ns");
    expect(installed?.smithery?.baseUrl).toBe("https://api.smithery.ai");
    // Deterministic per (owner, server) — non-empty is the contract; an empty
    // id is what silently disables revalidation.
    expect(installed?.smithery?.connectionId).toBeTruthy();
  });

  test("(b) the persisted url is the brokered session, not the catalog endpoint", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });

    const installed = await installAndReadPersistedRef();
    expect(installed?.url).toContain("/connect/test-ns/");
    expect(installed?.url).toContain("/mcp");
    expect(installed?.url).not.toBe("https://mcp.bassethound.ai/mcp");
  });

  test("(c) transport.auth names the credential provider, not the env", async () => {
    process.env.SMITHERY_API_KEY = "secret-smithery-key-DO-NOT-LEAK";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });

    const installed = await installAndReadPersistedRef();
    // Names the credential provider — neither the secret NOR an env var's name
    // reaches workspace.json.
    expect(installed?.transport?.auth?.type).toBe("provider");
    expect((installed?.transport?.auth as { provider?: string } | undefined)?.provider).toBe(
      "smithery",
    );

    const serialized = JSON.stringify(installed);
    expect(serialized).not.toContain("secret-smithery-key-DO-NOT-LEAK");
    expect(serialized).not.toContain("SMITHERY_API_KEY");
  });

  test("(d) the Authorization header is not duplicated into transport.headers", async () => {
    process.env.SMITHERY_API_KEY = "secret-key";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });

    const installed = await installAndReadPersistedRef();
    // The bearer is attached by the credential provider transport.auth names.
    // The wiring must not persist a second copy alongside the template —
    // which, holding the live key, is exactly what would leak.
    expect(installed?.transport?.headers?.Authorization).toBeUndefined();
    expect(JSON.stringify(installed)).not.toContain("secret-key");
  });

  test("(e0) a forged server on a KNOWN entry is discarded for the catalog's", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "operator-namespace" } } });

    // Installing spends the PLATFORM's broker credential at the operator's
    // Smithery account, so the target server must come from the operator's
    // catalog — never the caller. Same treatment the provider arm gets.
    const forged = bassethoundEntry();
    (forged.install as { smithery: { server: string } }).smithery.server =
      "attacker-namespace/exfiltrator";

    const bodies: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ connectionId: "c", status: { state: "connected" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await buildTool(h).handler({ action: "install", entry: forged, wsId: h.wsId });

    // The decisive assertion: the broker was asked for the CATALOG's server.
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? "{}").server).toBe(SERVER);
    expect(bodies[0]).not.toContain("attacker-namespace/exfiltrator");
  });

  test("(e1) refuses an entry the trusted catalog doesn't publish at all", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "operator-namespace" } } });

    const forged = bassethoundEntry();
    forged.id = "attacker.example/forged";
    (forged.install as { smithery: { server: string } }).smithery.server =
      "attacker-namespace/exfiltrator";

    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ connectionId: "c", status: { state: "connected" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await buildTool(h).handler({ action: "install", entry: forged, wsId: h.wsId });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not a recognized Smithery connector");
    // The broker was never called, so no connection exists at the operator's account.
    expect(calls).toHaveLength(0);
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles.some((b) => "smithery" in b)).toBe(false);
  });

  test("(a2) eager-starts the source — there is no Connect step to wait for", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });

    // A smithery source authenticates with the broker credential, so nothing
    // interactive follows the install. Dropping it from the eager-start list
    // would leave the connector installed-but-never-started, with a UI that
    // offers no way to start it.
    const result = await buildTool(h).handler({
      action: "install",
      entry: bassethoundEntry(),
      wsId: h.wsId,
    });

    // The harness has no real MCP server, so the eager start fails — but that it
    // was ATTEMPTED is the assertion: the warning only exists on that path.
    const structured = result.structuredContent as { warning?: string } | undefined;
    expect(structured?.warning).toBeTruthy();
  });

  test("(e2) refuses when the broker returns no session coordinates", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });

    // A session URL the coordinate parse can't satisfy. Persisting an empty
    // connectionId would leave `ref.smithery` truthy — claimed by the
    // revalidator, answered indeterminate forever, and skipped by uninstall.
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/connect/")) {
        return new Response(JSON.stringify({ connectionId: "c", status: { state: "connected" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const registry = h.runtime.getManagedConnectorRegistry();
    const provider = registry.get("smithery");
    if (provider) {
      // Force the seam-contract violation the guard exists for.
      provider.createSession = async () => ({ type: "http", url: "https://api.smithery.ai/x/mcp" });
    }
    const ctx = {
      runtime: {
        ...h.runtime,
        getManagedConnectorRegistry: () => registry,
      },
      getIdentity: () => ADMIN,
      getWorkspaceId: () => h.wsId,
    } as unknown as ManageConnectorsContext;
    const result = await createManageConnectorsTool(ctx).handler({
      action: "install",
      entry: bassethoundEntry(),
      wsId: h.wsId,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no connection coordinates");
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles.some((b) => "smithery" in b)).toBe(false);
  });

  test("(e) refuses the install when Smithery is unconfigured", async () => {
    // No SMITHERY_API_KEY — the provider is not registered.
    const tool = buildTool(h);
    const result = await tool.handler({
      action: "install",
      entry: bassethoundEntry(),
      wsId: h.wsId,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Smithery integration is not configured");
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles.some((b) => "smithery" in b)).toBe(false);
  });

  test("(g) a half-configured provider (key, no namespace) refuses rather than guessing", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    // SMITHERY_NAMESPACE deliberately unset.
    const result = await buildTool(h).handler({
      action: "install",
      entry: bassethoundEntry(),
      wsId: h.wsId,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Smithery integration is not configured");
  });
});
