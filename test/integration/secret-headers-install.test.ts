/**
 * One catalog entry, two credentials: the connection's own identity and the
 * workspace's own secret.
 *
 * A service that reads a customer-owned database needs both, and they are
 * different things. `providerAuth` is how the connection proves who is calling
 * — for a platform service, a short-lived minted token its front door verifies.
 * `secretHeaders` is what that caller may open — a value only this workspace
 * holds, named by a credential-store key and resolved per connection. Neither
 * replaces the other, so they compose on one connection rather than choosing.
 *
 * The three properties that make one catalog entry enough:
 *
 *   - the header's NAME and KEY come from the SERVER-trusted entry, never the
 *     caller's copy. A workspace admin who could forge either would choose what
 *     a connection carrying a fleet-trusted identity sends, and where.
 *   - two workspaces install the identical entry and each sends its own value.
 *   - a workspace that never set the key fails its connection naming the key,
 *     rather than sending a blank header and reading a driver error a hop later.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { MINTED_PROVIDER } from "../../src/oauth/minted-credential-provider.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
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
import { resolveTransportCredential } from "../../src/tools/remote-transport.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const CATALOG_DIR = join(import.meta.dir, "..", "fixtures", "connectors-secret-headers");
const ENTRY_ID = "com.acme/db-query";
const URL_ = "https://mcp.acme.test/mcp";
const HEADER = "X-Db-Url";
const KEY = "acme.db_url";
// What `install` derives from the entry id — the handle every later action uses.
const SERVER_NAME = slugifyServerName(ENTRY_ID);

const ADMIN: UserIdentity = {
  id: "usr_admin_secret_headers",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

let workDir: string;
let store: FileCredentialStore;
let workspaceStore: WorkspaceStore;
let originalFetch: typeof fetch;

/**
 * A stand-in for the real minting provider: it attaches an identity header the
 * way the real one does — `new Headers(init?.headers)` then set — so the test
 * proves composition rather than assuming it. The real provider would need an
 * authorizer; what matters here is that a provider owning `Authorization`
 * leaves the transport's other headers intact.
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

/** The catalog entry as `list_directory` projects it — what the web shell hands `install`. */
function entry(): CatalogListing {
  return {
    id: ENTRY_ID,
    name: "Acme DB Query",
    description: "Read-only queries against the workspace's own database",
    install: {
      kind: "remote-oauth",
      url: URL_,
      transportType: "streamable-http",
      auth: "provider",
      providerAuth: { provider: MINTED_PROVIDER, config: { audience: "mcp-fleet", scope: "mcp:invoke" } },
      secretHeaders: { [HEADER]: { ref: "credential", key: KEY } },
    },
  };
}

function toolFor(sessionWsId: string) {
  const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  const workspaceRegistry = new ToolRegistry();
  const runtime = {
    getWorkDir: () => workDir,
    getCredentialStore: () => store,
    getEventSink: () => new NoopEventSink(),
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getConnectorCatalog: () => new ConnectorCatalog(CATALOG_DIR),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    getPermissionStore: () => ({ deleteConnector: async () => {} }),
    getUserStore: () => ({ get: async () => null }),
    getConnectorInstancesForWorkspace: (_wsId: string) => lifecycle.getInstances(),
    getAllowInsecureRemotes: () => false,
  } as unknown as Runtime;
  return createManageConnectorsTool({
    runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => sessionWsId,
  });
}

/** The structured half of a tool result, typed to what these tests read. */
function structured(result: { structuredContent?: unknown }): {
  deletedSecretKeys?: string[];
  secretDeleteError?: string;
  keys?: Array<{ key: string; updatedAt: string }>;
} {
  return (result.structuredContent ?? {}) as ReturnType<typeof structured>;
}

/** The persisted ref for the installed connector, read off disk. */
function persistedRef(wsId: string): ConnectorRef {
  const ws = JSON.parse(
    readFileSync(join(workDir, "workspaces", wsId, "workspace.json"), "utf-8"),
  ) as { connectors: ConnectorRef[] };
  const ref = ws.connectors.find((b) => b.url === URL_);
  if (!ref) throw new Error(`no db-query ref in ${wsId}`);
  return ref;
}

/** Drive one connection the way `createRemoteTransport` does: resolved headers on the init. */
async function send(wsId: string): Promise<Headers> {
  const { headers, fetch: authed } = await resolveTransportCredential(
    persistedRef(wsId).transport,
    wsId,
  );
  let seen = new Headers();
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await (authed ?? globalThis.fetch)(URL_, { method: "POST", headers });
  return seen;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-secret-headers-"));
  store = new FileCredentialStore(workDir);
  setCredentialStore(store);
  _resetCredentialProvidersForTest();
  registerStubMintedProvider();

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

describe("a catalog entry that binds a workspace secret to a header", () => {
  test("the persisted ref names the key and holds no value", async () => {
    const result = await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    expect(result.isError).toBe(false);

    const ref = persistedRef("ws_tenanta");
    expect(ref.transport?.headers).toEqual({ [HEADER]: { ref: "credential", key: KEY } });
    expect(ref.transport?.auth).toMatchObject({ type: "provider", provider: MINTED_PROVIDER });
    expect(JSON.stringify(ref)).not.toContain("postgres://");
  });

  test("a caller-forged header name and key are discarded for the catalog's own", async () => {
    const forged = entry();
    forged.install = {
      ...forged.install,
      secretHeaders: {
        Authorization: { ref: "credential", key: "someone.elses_key" },
      },
    } as CatalogListing["install"];

    await toolFor("ws_tenanta").handler({ action: "install", entry: forged });
    expect(persistedRef("ws_tenanta").transport?.headers).toEqual({
      [HEADER]: { ref: "credential", key: KEY },
    });
  });

  test("both credentials ride one request, and each workspace sends its own secret", async () => {
    await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    await toolFor("ws_tenantb").handler({ action: "install", entry: entry() });

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

    // The two persisted refs are byte-identical; the difference is entirely in
    // the store, which is what makes one catalog entry enough.
    expect(persistedRef("ws_tenanta").transport).toEqual(persistedRef("ws_tenantb").transport);

    const a = await send("ws_tenanta");
    expect(a.get(HEADER)).toBe("postgres://a.acme.test/db");
    expect(a.get("Authorization")).toBe("Bearer minted-for-ws_tenanta");

    const b = await send("ws_tenantb");
    expect(b.get(HEADER)).toBe("postgres://b.acme.test/db");
    expect(b.get("Authorization")).toBe("Bearer minted-for-ws_tenantb");
  });

  test("rotating the key takes effect on the next connection, with no config edit", async () => {
    await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    await toolFor("ws_tenanta").handler({
      action: "set_secret",
      key: KEY,
      value: "postgres://old.acme.test/db",
    });
    const before = persistedRef("ws_tenanta");
    expect((await send("ws_tenanta")).get(HEADER)).toBe("postgres://old.acme.test/db");

    await toolFor("ws_tenanta").handler({
      action: "set_secret",
      key: KEY,
      value: "postgres://new.acme.test/db",
    });
    expect((await send("ws_tenanta")).get(HEADER)).toBe("postgres://new.acme.test/db");
    expect(persistedRef("ws_tenanta")).toEqual(before);
  });

  // ── Uninstall ───────────────────────────────────────────────────────
  //
  // A connector owns its secrets, so removing the connector resolves them.
  // Leaving them behind is not neutral: the rotation surface renders only for
  // an INSTALLED connector, so an orphaned key is unreachable from the UI
  // entirely — a live outbound capability on a volume with nothing referencing
  // it and nothing admitting it exists.
  //
  // The key is read from the connector's OWN declaration here, never from the
  // call. A caller-named key would be a delete primitive pointed at any secret
  // in the workspace.

  test("uninstalling removes the connector's declared secrets", async () => {
    // One tool for both actions: `toolFor` builds a fresh lifecycle per call,
    // and uninstall resolves the instance install seeded.
    const tool = toolFor("ws_tenanta");
    await tool.handler({ action: "install", entry: entry() });
    await tool.handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys).toHaveLength(1);

    const result = await tool.handler({ action: "uninstall", serverName: SERVER_NAME });
    expect(result.isError).toBe(false);
    expect(structured(result).deletedSecretKeys).toEqual([KEY]);
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys).toEqual([]);
  });

  test("keepSecrets leaves them, and says nothing else changed", async () => {
    const tool = toolFor("ws_tenanta");
    await tool.handler({ action: "install", entry: entry() });
    await tool.handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });

    const result = await tool.handler({
      action: "uninstall",
      serverName: SERVER_NAME,
      keepSecrets: true,
    });
    expect(result.isError).toBe(false);
    expect(structured(result).deletedSecretKeys).toEqual([]);
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys?.[0]?.key).toBe(KEY);
  });

  test("only the uninstalled connector's own keys go", async () => {
    // The declaration is the bound. A key the workspace holds for something
    // else is not this connector's to resolve.
    const tool = toolFor("ws_tenanta");
    await tool.handler({ action: "install", entry: entry() });
    await tool.handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });
    await tool.handler({ action: "set_secret", key: "unrelated.token", value: "keep-me" });

    await tool.handler({ action: "uninstall", serverName: SERVER_NAME });
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys?.map((k) => k.key)).toEqual([
      "unrelated.token",
    ]);
  });

  test("uninstalling a connector that declares no secret removes none", async () => {
    // Same code path, no branch: the plain-fleet entry declares nothing, so
    // `secretHeaders` yields no keys and the workspace's other secrets stand.
    const plain = entry();
    plain.id = "com.acme/plain-fleet";
    plain.name = "Acme Plain Fleet";
    plain.install = {
      ...plain.install,
      url: "https://mcp.acme.test/plain/mcp",
      secretHeaders: undefined,
    } as DirectoryEntry["install"];

    const tool = toolFor("ws_tenanta");
    await tool.handler({ action: "install", entry: plain });
    await tool.handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });

    const result = await tool.handler({
      action: "uninstall",
      serverName: slugifyServerName("com.acme/plain-fleet"),
    });
    expect(result.isError).toBe(false);
    expect(structured(result).deletedSecretKeys).toEqual([]);
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys?.[0]?.key).toBe(KEY);
  });

  test("a failed uninstall deletes no key", async () => {
    // The connector is not installed, so the uninstall is refused before
    // anything is torn down — and the secret it would have owned is untouched.
    const tool = toolFor("ws_tenanta");
    await tool.handler({ action: "set_secret", key: KEY, value: "postgres://a.acme.test/db" });

    const result = await tool.handler({ action: "uninstall", serverName: SERVER_NAME });
    expect(result.isError).toBe(true);
    expect(structured(await tool.handler({ action: "list_secret_keys" })).keys?.[0]?.key).toBe(KEY);
  });

  // The complement of the forged-pair test above, and the one that matters more:
  // an entry declaring NO secretHeaders is the ordinary fleet shape, so this is
  // the branch nearly every platform connector takes.
  test("a caller cannot ADD a header to an entry that declares none", async () => {
    const forged = entry();
    forged.id = "com.acme/plain-fleet";
    forged.install = {
      ...forged.install,
      url: "https://mcp.acme.test/plain/mcp",
      secretHeaders: {
        "X-Acme-Impersonate": { ref: "credential", key: "attacker.chosen" },
      },
    } as CatalogListing["install"];

    const result = await toolFor("ws_tenanta").handler({ action: "install", entry: forged });
    expect(result.isError).toBe(false);

    const ws = JSON.parse(
      readFileSync(join(workDir, "workspaces", "ws_tenanta", "workspace.json"), "utf-8"),
    ) as { connectors: ConnectorRef[] };
    const ref = ws.connectors.find((b) => b.url === "https://mcp.acme.test/plain/mcp");
    expect(ref).toBeDefined();
    expect(ref?.transport?.headers).toBeUndefined();
    expect(JSON.stringify(ref)).not.toContain("X-Acme-Impersonate");
  });

  test("a literal where a reference belongs is refused at install, naming the header", async () => {
    const literal = entry();
    literal.id = "com.acme/db-query-literal";
    literal.install = {
      ...literal.install,
      url: "https://mcp.acme.test/literal/mcp",
      secretHeaders: undefined,
    } as CatalogListing["install"];

    const result = await toolFor("ws_tenanta").handler({ action: "install", entry: literal });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("X-Db-Url");
  });

  test("a workspace that never set the key fails its connection, naming the key", async () => {
    await toolFor("ws_tenanta").handler({ action: "install", entry: entry() });
    await expect(
      resolveTransportCredential(persistedRef("ws_tenanta").transport, "ws_tenanta"),
    ).rejects.toThrow(/acme\.db_url.*workspace:ws_tenanta/s);
  });
});
