/**
 * A connector whose secret is set before it is installed connects on the first
 * try — and one whose secret arrives late heals without being rebuilt.
 *
 * `secret-headers-install.test.ts` covers what the install PERSISTS and what a
 * request CARRIES. This covers the connection itself, because that is what the
 * ordering in the UI exists for and what a user who hit the missing-credential
 * error wants to know:
 *
 *   - an `auth: "provider"` entry eager-starts its source at install, and that
 *     start resolves every `secretHeaders` reference before it opens the
 *     transport. Set the key first and the source establishes with no warning;
 *     that is why the dialog opens BEFORE `install` rather than after it.
 *   - install without the key and the source is registered but never
 *     established — the install still succeeds, carrying the failure as a
 *     warning. Setting the key afterwards is enough: `tryRecoverSource`
 *     re-registers on next use. No reinstall, no migration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleMcpDeps } from "../../src/bundles/startup.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { MINTED_PROVIDER } from "../../src/oauth/minted-credential-provider.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import {
  _resetCredentialProvidersForTest,
  registerCredentialProvider,
} from "../../src/tools/credential-provider.ts";
import {
  _resetCredentialStoreForTest,
  FileCredentialStore,
  setCredentialStore,
} from "../../src/tools/credential-store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { type FakeConnectorServer, startFakeConnectorServer } from "../helpers/fake-connector-server.ts";

const ENTRY_ID = "com.acme/db-query";
const SERVER_NAME = "com-acme-db-query";
const HEADER = "X-Db-Url";
const KEY = "acme.db_url";
const WS = "ws_tenanta";

const ADMIN: UserIdentity = {
  id: "usr_admin_secret_conn",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

let workDir: string;
let catalogDir: string;
let store: FileCredentialStore;
let workspaceStore: WorkspaceStore;
let lifecycle: BundleLifecycleManager;
let workspaceRegistry: ToolRegistry;
let upstream: FakeConnectorServer;

/**
 * The provider stub, matching `secret-headers-install.test.ts`: it owns
 * `Authorization` and leaves the transport's other headers alone, which is what
 * lets the workspace's own secret ride the same request.
 */
function registerStubMintedProvider(): void {
  registerCredentialProvider(MINTED_PROVIDER, {
    credentialFor(workspaceId) {
      return {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("Authorization", `Bearer minted-for-${workspaceId}`);
          return fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
        },
      };
    },
  });
}

/** The catalog entry, written per-run because the upstream's port is assigned at listen. */
function writeCatalog(url: string): void {
  writeFileSync(
    join(catalogDir, "db-query.json"),
    JSON.stringify({
      servers: [
        {
          name: ENTRY_ID,
          title: "Acme DB Query",
          description: "Read-only queries against the workspace's own database",
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url }],
          _meta: {
            "ai.nimblebrain/connector": {
              auth: "provider",
              providerAuth: { provider: MINTED_PROVIDER, config: { audience: "mcp-fleet" } },
              secretHeaders: { [HEADER]: { ref: "credential", key: KEY } },
            },
          },
        },
      ],
    }),
  );
}

function entry(url: string): DirectoryEntry {
  return {
    id: ENTRY_ID,
    registryId: "bundled-static",
    registryType: "static",
    name: "Acme DB Query",
    description: "Read-only queries against the workspace's own database",
    install: {
      kind: "remote-oauth",
      url,
      transportType: "streamable-http",
      auth: "provider",
      providerAuth: { provider: MINTED_PROVIDER, config: { audience: "mcp-fleet" } },
      secretHeaders: { [HEADER]: { ref: "credential", key: KEY } },
    },
  };
}

/**
 * The workspace binding a transport needs. `workspaceId` is the load-bearing
 * field here — a `{ ref: "credential" }` header resolves at the CONNECTION's
 * workspace scope and is refused outright when the connection names none, which
 * is the property that keeps one tenant's key off another tenant's request. The
 * host-resources handles are unused: nothing in these tests calls a tool.
 */
function bundleMcpDeps(wsId: string): BundleMcpDeps {
  return { workspaceId: wsId } as unknown as BundleMcpDeps;
}

function tool() {
  const registryStore = new RegistryStore(workDir);
  const runtime = {
    getWorkDir: () => workDir,
    getCredentialStore: () => store,
    getEventSink: () => new NoopEventSink(),
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    getPermissionStore: () => ({ deleteConnector: async () => {} }),
    getUserStore: () => ({ get: async () => null }),
    getBundleInstancesForWorkspace: (_wsId: string) => lifecycle.getInstances(),
    getAllowInsecureRemotes: () => true,
    getBundleMcpDeps: bundleMcpDeps,
  } as unknown as Runtime;
  return createManageConnectorsTool({
    runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => WS,
  });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-secret-conn-"));
  catalogDir = mkdtempSync(join(tmpdir(), "nb-secret-conn-catalog-"));
  upstream = startFakeConnectorServer(["query"]);
  writeCatalog(upstream.url);
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated services",
          type: "static",
          enabled: true,
          locked: true,
          url: catalogDir,
        },
        { id: "mpak", name: "mpak.dev", type: "mpak", enabled: false },
      ],
    }),
  );
  store = new FileCredentialStore(workDir);
  setCredentialStore(store);
  _resetCredentialProvidersForTest();
  registerStubMintedProvider();

  // `allowInsecureRemotes` on the constructor: `tryRecoverSource` reads the
  // lifecycle's own flag, not the install path's, and the fake upstream is http.
  lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined, true);
  lifecycle.setBundleMcpDepsFactory(bundleMcpDeps);
  workspaceRegistry = new ToolRegistry();
  // What `Runtime.start` binds — `tryRecoverSource` and the eager start both
  // reach the workspace's registry through it.
  const registries = new Map([[WS, workspaceRegistry]]);
  lifecycle.bindWorkspaceRegistries(() => registries);

  workspaceStore = new WorkspaceStore(workDir);
  await workspaceStore.create("Tenant A", "tenanta");
  await workspaceStore.addMember(WS, ADMIN.id, "admin");
});

afterEach(async () => {
  // Stop whatever the install established so the transport does not outlive the
  // upstream it is pointed at.
  for (const name of workspaceRegistry.sourceNames()) {
    await workspaceRegistry.removeSource(name);
  }
  upstream.close();
  _resetCredentialProvidersForTest();
  _resetCredentialStoreForTest();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(catalogDir, { recursive: true, force: true });
});

describe("a connector whose header carries a workspace secret", () => {
  test("the secret set first, the source establishes on the install's own start", async () => {
    await tool().handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });

    const result = await tool().handler({ action: "install", entry: entry(upstream.url) });
    expect(result.isError).toBe(false);
    // The eager start reports its failure as a warning rather than an error, so
    // the absence of one is the assertion that it did not fail.
    expect(result.structuredContent).not.toHaveProperty("warning");
    expect(workspaceRegistry.hasEstablishedSource(SERVER_NAME)).toBe(true);
  });

  test("no secret: the install succeeds, warns, and leaves the source unestablished", async () => {
    const result = await tool().handler({ action: "install", entry: entry(upstream.url) });
    expect(result.isError).toBe(false);
    const warning = (result.structuredContent as { warning?: string }).warning;
    // The remedy the error names is the surface that collects it, not a tool call.
    expect(warning).toContain(KEY);
    expect(warning).toContain("Settings → Connectors");
    expect(warning).not.toContain("set_secret");
    expect(workspaceRegistry.hasEstablishedSource(SERVER_NAME)).toBe(false);
  });

  test("an install already broken this way heals on setting the key — no reinstall", async () => {
    await tool().handler({ action: "install", entry: entry(upstream.url) });
    expect(workspaceRegistry.hasEstablishedSource(SERVER_NAME)).toBe(false);

    await tool().handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });

    // What the tool door and the REST doors call on a miss. The 30s cooldown is
    // stamped by the failed install's own attempt only if one ran through this
    // path; a fresh key here is the first call, so it proceeds.
    expect(await lifecycle.tryRecoverSource(SERVER_NAME, WS, workDir)).toBe(true);
    expect(workspaceRegistry.hasEstablishedSource(SERVER_NAME)).toBe(true);
  });
});
