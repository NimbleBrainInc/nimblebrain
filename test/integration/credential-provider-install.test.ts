/**
 * One catalog entry, two workspaces, two customer-owned secrets.
 *
 * This is the shape the secrets door exists to enable: an operator publishes a
 * single `auth: provider` entry naming the built-in `credential` provider and a
 * credential-store KEY; a workspace admin sets that key to their own value; the
 * connection presents it. Nothing secret reaches `workspace.json`, and the
 * second workspace's install is a click rather than a second catalog entry, a
 * second connector, or any vendor code.
 *
 * It covers the two halves separately because they fail separately:
 *
 *   - the INSTALL half — `providerAuth.config` is copied verbatim from the
 *     SERVER-trusted catalog entry into the persisted `BundleRef`, carrying the
 *     key and no value. A caller-forged `providerAuth` is discarded, which
 *     matters more here than for the fleet rail: a workspace admin who could
 *     forge `config.key` would name another key in their own store, so the blast
 *     radius is their own workspace — but the discard is what keeps the URL from
 *     being forgeable alongside it.
 *   - the RESOLVE half — each workspace's connection resolves that same key in
 *     its own scope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { _resetCredentialProvidersForTest } from "../../src/tools/credential-provider.ts";
import {
  _resetCredentialStoreForTest,
  FileCredentialStore,
  setCredentialStore,
} from "../../src/tools/credential-store.ts";
import {
  CREDENTIAL_PROVIDER,
  registerCredentialTransportCredentialProvider,
} from "../../src/tools/credential-transport-credential.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { resolveTransportCredential } from "../../src/tools/remote-transport.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const CATALOG_DIR = join(import.meta.dir, "..", "fixtures", "connectors-credential");
const ENTRY_ID = "com.acme/db";
const KEY = "acme.db_url";

const ADMIN: UserIdentity = {
  id: "usr_admin_credprov",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

let workDir: string;
let store: FileCredentialStore;
let workspaceStore: WorkspaceStore;
let originalFetch: typeof fetch;

/** The catalog entry as `list_directory` projects it — what the web shell hands `install`. */
function entry(): DirectoryEntry {
  return {
    id: ENTRY_ID,
    registryId: "bundled-static",
    registryType: "static",
    name: "Acme DB",
    description: "Query the workspace's own Acme database",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.acme.test/mcp",
      transportType: "streamable-http",
      auth: "provider",
      providerAuth: { provider: CREDENTIAL_PROVIDER, config: { key: KEY } },
    },
  };
}

function toolFor(sessionWsId: string) {
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const registryStore = new RegistryStore(workDir);
  const workspaceRegistry = new ToolRegistry();
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
    getAllowInsecureRemotes: () => false,
  } as unknown as Runtime;
  return createManageConnectorsTool({
    runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => sessionWsId,
  });
}

/** The persisted ref for the installed connector, read off disk. */
function persistedRef(wsId: string): BundleRef {
  const ws = JSON.parse(
    readFileSync(join(workDir, "workspaces", wsId, "workspace.json"), "utf-8"),
  ) as { bundles: BundleRef[] };
  const ref = ws.bundles.find((b) => b.url === "https://mcp.acme.test/mcp");
  if (!ref) throw new Error(`no acme ref in ${wsId}`);
  return ref;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-credprov-install-"));
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
          url: CATALOG_DIR,
        },
        { id: "mpak", name: "mpak.dev", type: "mpak", enabled: false },
      ],
    }),
  );
  store = new FileCredentialStore(workDir);
  setCredentialStore(store);
  _resetCredentialProvidersForTest();
  registerCredentialTransportCredentialProvider();

  workspaceStore = new WorkspaceStore(workDir);
  for (const [name, slug] of [
    ["Tenant A", "tenanta"],
    ["Tenant B", "tenantb"],
  ] as const) {
    await workspaceStore.create(name, slug);
    await workspaceStore.addMember(`ws_${slug}`, ADMIN.id, "admin");
  }

  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetCredentialProvidersForTest();
  _resetCredentialStoreForTest();
  rmSync(workDir, { recursive: true, force: true });
});

describe("installing a `credential` provider entry", () => {
  test("the persisted ref names the key and holds no value", async () => {
    const result = await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    expect(result.isError).toBe(false);

    const ref = persistedRef("ws_tenanta");
    expect(ref.transport?.auth).toEqual({
      type: "provider",
      provider: CREDENTIAL_PROVIDER,
      config: { key: KEY },
    });
    // Nothing secret at rest, and no env-var name either.
    expect(JSON.stringify(ref)).not.toContain("postgres://");
  });

  test("a caller-forged providerAuth is discarded for the catalog's own", async () => {
    const forged = entry();
    forged.install = {
      ...forged.install,
      url: "http://evil.internal.test/mcp",
      providerAuth: { provider: CREDENTIAL_PROVIDER, config: { key: "someone.elses_key" } },
    } as DirectoryEntry["install"];

    await toolFor("ws_tenanta").handler({ action: "install", entry: forged });
    const ref = persistedRef("ws_tenanta");
    expect(ref.url).toBe("https://mcp.acme.test/mcp");
    expect(ref.transport?.auth).toMatchObject({ config: { key: KEY } });
  });

  test("the same entry installs into a second workspace and each sends its own secret", async () => {
    await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    await toolFor("ws_tenantb").handler({ action: "install", entry: entry() });

    // Each admin seeds their own value under the SAME key.
    await toolFor("ws_tenanta").handler({
      action: "set_secret",
      key: KEY,
      value: "postgres://a.acme.test/db",
    });
    await toolFor("ws_tenantb").handler({
      action: "set_secret",
      key: KEY,
      value: "postgres://b.acme.test/db",
    });

    // The two persisted refs are byte-identical — the difference is entirely in
    // the store, which is the property that makes one catalog entry enough.
    expect(persistedRef("ws_tenanta").transport).toEqual(persistedRef("ws_tenantb").transport);

    const sent: string[] = [];
    globalThis.fetch = (async (_input: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    for (const wsId of ["ws_tenanta", "ws_tenantb"]) {
      const { fetch: authed } = await resolveTransportCredential(
        persistedRef(wsId).transport,
        wsId,
      );
      await authed?.("https://mcp.acme.test/mcp", { method: "POST" });
    }

    expect(sent).toEqual([
      "Bearer postgres://a.acme.test/db",
      "Bearer postgres://b.acme.test/db",
    ]);
  });

  test("a workspace that never set the key fails its connection, naming the key", async () => {
    await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    const { fetch: authed } = await resolveTransportCredential(
      persistedRef("ws_tenanta").transport,
      "ws_tenanta",
    );
    await expect(authed?.("https://mcp.acme.test/mcp", {})).rejects.toThrow(
      /acme\.db_url.*workspace:ws_tenanta/s,
    );
  });
});
