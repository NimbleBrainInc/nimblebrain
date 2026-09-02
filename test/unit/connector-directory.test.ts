import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";

/**
 * `ConnectorDirectory` is the only thing tool handlers should call.
 * These tests pin the contract that uniform behavior — scope
 * filtering, error isolation, dedup, projection, lookup tables —
 * lives in one place regardless of which sources are configured.
 *
 * Sources are stubbed by writing small static catalog files; two
 * `static` rows stand in for "more than one enabled source", which is
 * all the aggregation and isolation contracts care about.
 */

let workDir: string;

function freshStore(): RegistryStore {
  workDir = mkdtempSync(join(tmpdir(), "directory-test-"));
  return new RegistryStore(workDir);
}

function writeStaticCatalog(servers: Record<string, unknown>[], file = "catalog.yaml"): string {
  const path = join(workDir, file);
  writeFileSync(path, `servers:\n${servers.map((s) => `  - ${JSON.stringify(s)}`).join("\n")}\n`);
  return path;
}

function configureRegistries(_store: RegistryStore, configs: object[]): Promise<void> {
  // RegistryStore.load() auto-injects a `bundled-static` row pointing at
  // the platform's shipped catalog directory when missing — that row would
  // pollute every test with a fixed set of entries. Pre-seed an empty
  // bundled-static placeholder pointing at a missing path so
  // readStaticServers gracefully returns []; tests then add only the
  // sources they want.
  const bundledPlaceholder = {
    id: "bundled-static",
    name: "Curated services",
    type: "static",
    enabled: false,
    locked: true,
    url: "/dev/null/missing-on-purpose.yaml",
  };
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({ registries: [bundledPlaceholder, ...configs] }),
  );
  return Promise.resolve();
}

/** A minimal installable `ServerDetail` — one remote, one icon. */
function remoteServer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "io.evil/mcp",
    description: "Evil",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://evil.test/mcp" }],
    ...over,
  };
}

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("ConnectorDirectory.list", () => {
  test("aggregates entries from every enabled source, projecting to DirectoryEntry", async () => {
    const store = freshStore();
    const granola = writeStaticCatalog(
      [
        {
          name: "ai.granola/mcp",
          description: "Granola",
          version: "1.0.0",
          title: "Granola",
          icons: [{ src: "https://x.test/granola.svg" }],
          remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
        },
      ],
      "granola.yaml",
    );
    const echo = writeStaticCatalog(
      [
        {
          name: "ai.nimblebrain/echo",
          description: "Echo",
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url: "https://echo.test/mcp" }],
        },
      ],
      "echo.yaml",
    );
    await configureRegistries(store, [
      { id: "a", name: "A", type: "static", enabled: true, url: granola },
      { id: "b", name: "B", type: "static", enabled: true, url: echo },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => e.id).sort()).toEqual([
      "ai.granola/mcp",
      "ai.nimblebrain/echo",
    ]);
  });

  test("a source with no implementation for its type yields no entries and no crash", async () => {
    // `RegistryType` is an open string keyed into the directory's
    // source-factory map. A config naming a type this build does not carry
    // must degrade to "no entries from that registry", not a throw.
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.granola/mcp",
        description: "Granola",
        version: "1.0.0",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
      { id: "future", name: "Upstream MCP registry", type: "mcp", enabled: true },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.map((e) => e.id)).toEqual(["ai.granola/mcp"]);
    expect(result.errors).toEqual([]);
  });

  test("isolates per-source failures — an unreadable source doesn't blank the others", async () => {
    // A mounted catalog directory the process cannot list (bad ConfigMap
    // permissions) throws out of that source's `fetch()`. The directory must
    // record it under that registry id and still return every other source's
    // entries.
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.granola/mcp",
        description: "Granola",
        version: "1.0.0",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
      },
    ]);
    const unreadable = join(workDir, "unreadable");
    mkdirSync(unreadable);
    chmodSync(unreadable, 0o000);
    try {
      await configureRegistries(store, [
        { id: "static", name: "Static", type: "static", enabled: true, url: path },
        { id: "broken", name: "Broken", type: "static", enabled: true, url: unreadable },
      ]);

      const result = await new ConnectorDirectory(store).list();
      expect(result.entries.map((e) => e.id)).toEqual(["ai.granola/mcp"]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.registryId).toBe("broken");
    } finally {
      // Restore so afterEach can remove the tree.
      chmodSync(unreadable, 0o700);
    }
  });

  test("dedups entries within a single source by (registryId, id)", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.granola/mcp",
        description: "first",
        version: "1.0.0",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
      },
      {
        name: "ai.granola/mcp",
        description: "second",
        version: "2.0.0",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.description).toBe("first");
  });

  test("scope filter: matches by reverse-DNS prefix (ai.nimblebrain → ai.nimblebrain/echo)", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/echo",
        description: "Echo",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://echo.test/mcp" }],
      },
      {
        name: "com.acme/widget",
        description: "Acme widget",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://widget.test/mcp" }],
      },
    ]);
    await configureRegistries(store, [
      {
        id: "scoped",
        name: "Scoped",
        type: "static",
        enabled: true,
        url: path,
        scopes: ["ai.nimblebrain"],
      },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.map((e) => e.id)).toEqual(["ai.nimblebrain/echo"]);
  });

  test("scope filter: matches by npm scope (acme → @acme/widget)", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/echo",
        description: "Echo",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://echo.test/mcp" }],
      },
      {
        name: "com.acme/widget",
        description: "Acme widget",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://widget.test/mcp" }],
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/widget",
            version: "1.0.0",
            transport: { type: "stdio" },
          },
        ],
      },
    ]);
    await configureRegistries(store, [
      { id: "scoped", name: "Scoped", type: "static", enabled: true, url: path, scopes: ["acme"] },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.map((e) => e.id)).toEqual(["com.acme/widget"]);
  });

  test("empty / undefined scopes = no filter (unchanged behavior)", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/echo",
        description: "Echo",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://echo.test/mcp" }],
      },
      {
        name: "com.acme/widget",
        description: "Acme",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://widget.test/mcp" }],
      },
    ]);
    await configureRegistries(store, [
      { id: "all", name: "All", type: "static", enabled: true, url: path },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.length).toBe(2);
  });

  test("operatorConfigured probe runs only for static-auth entries with operatorSetup", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "io.asana/mcp",
        description: "Asana",
        version: "1.0.0",
        icons: [{ src: "https://x.test/asana.svg" }],
        remotes: [{ type: "streamable-http", url: "https://app.asana.com/api/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "static",
            operatorSetup: {
              portalUrl: "https://app.asana.com/0/developer-console",
              hint: "Create OAuth app",
              clientSecretKey: "asana.client_secret",
            },
          },
        },
      },
      {
        name: "ai.granola/mcp",
        description: "Granola",
        version: "1.0.0",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": { auth: "dcr" },
        },
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);
    const probe = mock(async () => true);
    const result = await new ConnectorDirectory(store).list({ isOperatorConfigured: probe });
    // Only Asana (static-auth + operatorSetup) gets probed; Granola (dcr) doesn't.
    expect(probe).toHaveBeenCalledTimes(1);
    const asana = result.entries.find((e) => e.id === "io.asana/mcp");
    expect(asana?.operatorConfigured).toBe(true);
  });

  test("a packages-only entry is dropped — this runtime installs no downloaded code", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/echo",
        description: "Echo",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@nimblebraininc/echo",
            version: "1.0.0",
            transport: { type: "stdio" },
          },
        ],
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries).toEqual([]);
  });
});

describe("ConnectorDirectory lookup tables", () => {
  test("catalogByUrl + catalogById are built from one shared read (memoized)", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/echo",
        description: "Echo",
        version: "1.0.0",
        icons: [{ src: "https://x.test/echo.svg" }],
        remotes: [{ type: "streamable-http", url: "https://echo.test/mcp" }],
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);

    const directory = new ConnectorDirectory(store);
    await directory.list();
    // Delete the catalog out from under the directory: a second read would
    // now fail, so surviving these calls proves the fetch was memoized.
    rmSync(path);
    const byUrl = await directory.catalogByUrl();
    expect(byUrl.get("https://echo.test/mcp")?.id).toBe("ai.nimblebrain/echo");
    expect((await directory.catalogById("ai.nimblebrain/echo"))?.id).toBe("ai.nimblebrain/echo");
  });

  test("catalogById finds an icon-less provider entry — the path that refused the install", async () => {
    // Regression for the catalog projection foot-gun: an icon-less
    // `provider`-auth connector used to be dropped at projection time, so
    // catalogById returned null and the provider-auth install failed with
    // "not a recognized platform connector". Icons are cosmetic — a missing
    // icon must never make a connector non-functional.
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/web",
        description: "Web tools",
        version: "1.0.0",
        // NOTE: no `icons` field.
        remotes: [{ type: "streamable-http", url: "http://mcp-web.mcp-shared.svc/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "provider",
            providerAuth: { provider: "minted", config: { audience: "mcp-fleet" } },
          },
        },
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);

    const entry = await new ConnectorDirectory(store).catalogById("ai.nimblebrain/web");
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("ai.nimblebrain/web");
    expect(entry?.iconUrl).toBeUndefined();
    expect(entry?.auth).toBe("provider");
    expect(entry?.providerAuth).toEqual({ provider: "minted", config: { audience: "mcp-fleet" } });
  });
});

describe("ConnectorDirectory safety scrub (XSS via _meta extension URLs)", () => {
  // Pre-fix only static-source ran the URL-scheme allowlist + reserved
  // OAuth-param check, so an entry from any other source reached projection
  // unchecked: a publisher could ship `_meta.docsUrl: "javascript:..."` and
  // the Configure page would render it as a clickable `<a href>`
  // (target="_blank" rel="noopener noreferrer" does NOT block javascript:
  // URI execution). The check lives in ConnectorDirectory.fetchAll so every
  // source is scrubbed at one boundary.

  async function listWith(server: Record<string, unknown>) {
    const store = freshStore();
    const path = writeStaticCatalog([server]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);
    return new ConnectorDirectory(store).list();
  }

  test("drops an entry whose _meta.docsUrl carries a javascript: scheme", async () => {
    const result = await listWith(
      remoteServer({
        _meta: {
          "ai.nimblebrain/connector": { auth: "dcr", docsUrl: "javascript:alert(1)" },
        },
      }),
    );
    expect(result.entries).toEqual([]);
  });

  test("drops an entry whose _meta.operatorSetup.portalUrl carries a non-http(s) scheme", async () => {
    const result = await listWith(
      remoteServer({
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "static",
            operatorSetup: {
              portalUrl: "javascript:fetch('https://evil')",
              hint: "x",
              clientSecretKey: "x.client_secret",
            },
          },
        },
      }),
    );
    expect(result.entries).toEqual([]);
  });

  test("drops an entry whose _meta.additionalAuthorizationParams contains a reserved OAuth key", async () => {
    const result = await listWith(
      remoteServer({
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "dcr",
            additionalAuthorizationParams: { client_id: "attacker-controlled" },
          },
        },
      }),
    );
    expect(result.entries).toEqual([]);
  });

  test("drops an entry whose icons[].src is a non-http(s) scheme", async () => {
    const result = await listWith(
      remoteServer({ icons: [{ src: "data:image/svg+xml;<script>alert(1)</script>" }] }),
    );
    expect(result.entries).toEqual([]);
  });

  test("safe entries pass unmodified — scrub doesn't over-reject", async () => {
    const result = await listWith(
      remoteServer({
        name: "io.safe/mcp",
        icons: [{ src: "https://x.test/safe.png" }],
        _meta: {
          "ai.nimblebrain/connector": { auth: "dcr", docsUrl: "https://safe.example/docs" },
        },
      }),
    );
    expect(result.entries.map((e) => e.id)).toEqual(["io.safe/mcp"]);
  });
});
