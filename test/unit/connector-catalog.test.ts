import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseCatalog } from "../../src/catalogs/browse.ts";
import { createCatalogListings } from "../../src/catalogs/reader.ts";
import type { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import { readCatalogEntries } from "../../src/connectors/catalog/read.ts";
import { pathCatalog } from "../helpers/ai-catalog.ts";
import { connectorListCatalog, connectorListCatalogs } from "../helpers/connector-list-catalog.ts";

/**
 * `ConnectorCatalog` is the only thing tool handlers should call.
 * These tests pin the contract that composition of the listed records —
 * dedup, projection, the safety scrub, the lookup tables — lives in one
 * place.
 *
 * A test writes `ServerDetail` files into a directory, which
 * `connectorListCatalog` lists as bare connectors, as a converted path
 * catalog carries them. Two files stand in for "curation split across more
 * than one file", which is what the aggregation and isolation contracts care
 * about.
 */

let workDir: string;
let catalogDir: string;

function freshCatalog(): string {
  workDir = mkdtempSync(join(tmpdir(), "catalog-test-"));
  catalogDir = join(workDir, "catalog");
  mkdirSync(catalogDir);
  return catalogDir;
}

function writeStaticCatalog(servers: Record<string, unknown>[], file = "catalog.yaml"): string {
  const path = join(catalogDir, file);
  writeFileSync(path, `servers:\n${servers.map((s) => `  - ${JSON.stringify(s)}`).join("\n")}\n`);
  return path;
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

/**
 * The connector list's installable records, and the file-level errors reading
 * the test's directory reported: its projection, dedupe and scrub, as every
 * reader of the list applies them.
 */
async function list(catalog: ConnectorCatalog) {
  const errors = readCatalogEntries(catalogDir)
    .diagnostics.filter((d) => d.index === undefined)
    .map((d) => ({ file: d.source, message: d.message }));
  return { entries: await catalog.listings(), errors };
}

/** Browse over the list as an operator now mounts it: converted to a path catalog. */
function browseConverted(
  catalogDir: string,
  opts: { isOAuthClientConfigured?: (id: string, key: string) => Promise<boolean> } = {},
) {
  const [catalog] = connectorListCatalogs(catalogDir);
  return browseCatalog({
    listings: createCatalogListings({
      catalogs: [pathCatalog("test", (catalog as { source: string }).source)],
      cacheDir: join(workDir, "cache"),
    }),
    brokers: { has: () => false },
    ...opts,
  });
}

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("ConnectorCatalog listings", () => {
  test("aggregates entries from every catalog file, projecting to CatalogListing", async () => {
    const catalogDir = freshCatalog();
    writeStaticCatalog(
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
    writeStaticCatalog(
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

    const result = await list(connectorListCatalog(catalogDir));
    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => e.id).sort()).toEqual([
      "ai.granola/mcp",
      "ai.nimblebrain/echo",
    ]);
  });

  test("isolates per-file failures — an unreadable catalog file doesn't blank the rest", async () => {
    // A catalog file the process cannot read (bad ConfigMap permissions)
    // must be reported against that file and leave every other file's
    // entries intact — one bad file must never empty the catalog.
    const catalogDir = freshCatalog();
    writeStaticCatalog([
      {
        name: "ai.granola/mcp",
        description: "Granola",
        version: "1.0.0",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
      },
    ]);
    const unreadable = writeStaticCatalog(
      [
        {
          name: "ai.other/mcp",
          description: "Other",
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url: "https://other.test/mcp" }],
        },
      ],
      "unreadable.yaml",
    );
    chmodSync(unreadable, 0o000);
    try {
      const result = await list(connectorListCatalog(catalogDir));
      expect(result.entries.map((e) => e.id)).toEqual(["ai.granola/mcp"]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.file).toBe(unreadable);
    } finally {
      // Restore so afterEach can remove the tree.
      chmodSync(unreadable, 0o700);
    }
  });

  test("dedups entries by id across the catalog", async () => {
    const catalogDir = freshCatalog();
    writeStaticCatalog([
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

    const result = await list(connectorListCatalog(catalogDir));
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.description).toBe("first");
  });

  test("oauthClientConfigured probe runs only for static-auth entries with oauthClientSetup", async () => {
    const catalogDir = freshCatalog();
    writeStaticCatalog([
      {
        name: "io.asana/mcp",
        description: "Asana",
        version: "1.0.0",
        icons: [{ src: "https://x.test/asana.svg" }],
        remotes: [{ type: "streamable-http", url: "https://app.asana.com/api/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "static",
            oauthClientSetup: {
              portalUrl: "https://app.asana.com/0/developer-console",
              hint: "Create OAuth client",
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
    const probe = mock(async () => true);
    const result = await browseConverted(catalogDir, { isOAuthClientConfigured: probe });
    // Only Asana (static-auth + oauthClientSetup) gets probed; Granola (dcr) doesn't.
    expect(probe).toHaveBeenCalledTimes(1);
    const asana = result.entries.find((e) => e.id === "io.asana/mcp");
    expect(asana?.oauthClientConfigured).toBe(true);
  });

  test("a packages-only entry is dropped — this runtime installs no downloaded code", async () => {
    const catalogDir = freshCatalog();
    writeStaticCatalog([
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

    const result = await list(connectorListCatalog(catalogDir));
    expect(result.entries).toEqual([]);
  });
});

describe("ConnectorCatalog lookup tables", () => {
  test("catalogByUrl + catalogById are built from one shared read (memoized)", async () => {
    const catalogDir = freshCatalog();
    const path = writeStaticCatalog([
      {
        name: "ai.nimblebrain/echo",
        description: "Echo",
        version: "1.0.0",
        icons: [{ src: "https://x.test/echo.svg" }],
        remotes: [{ type: "streamable-http", url: "https://echo.test/mcp" }],
      },
    ]);

    const directory = connectorListCatalog(catalogDir);
    await list(directory);
    // Delete the catalog out from under the directory: a second read would
    // now fail, so surviving these calls proves the fetch was memoized.
    rmSync(path);
    const byUrl = await directory.catalogByUrl();
    expect(byUrl.get("https://echo.test/mcp")?.id).toBe("ai.nimblebrain/echo");
    expect((await directory.catalogById("ai.nimblebrain/echo"))?.id).toBe("ai.nimblebrain/echo");
  });

  test("catalogById finds an icon-less provider entry — the path that refused the install", async () => {
    // An icon-less `provider`-auth connector must survive catalog
    // projection; dropped there, catalogById returns null and the
    // provider-auth install fails with "not a recognized platform connector". Icons are cosmetic — a missing
    // icon must never make a connector non-functional.
    const catalogDir = freshCatalog();
    writeStaticCatalog([
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

    const entry = await connectorListCatalog(catalogDir).catalogById("ai.nimblebrain/web");
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("ai.nimblebrain/web");
    expect(entry?.iconUrl).toBeUndefined();
    expect(entry?.auth).toBe("provider");
    expect(entry?.providerAuth).toEqual({ provider: "minted", config: { audience: "mcp-fleet" } });
  });
});

describe("ConnectorCatalog safety scrub (XSS via _meta extension URLs)", () => {
  // Pre-fix only static-source ran the URL-scheme allowlist + reserved
  // OAuth-param check, so an entry from any other source reached projection
  // unchecked: a publisher could ship `_meta.docsUrl: "javascript:..."` and
  // the Configure page would render it as a clickable `<a href>`
  // (target="_blank" rel="noopener noreferrer" does NOT block javascript:
  // URI execution). The check lives in ConnectorCatalog.fetchAll so every
  // source is scrubbed at one boundary.

  async function listWith(server: Record<string, unknown>) {
    const catalogDir = freshCatalog();
    writeStaticCatalog([server]);
    return list(connectorListCatalog(catalogDir));
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

  test("drops an entry whose _meta.oauthClientSetup.portalUrl carries a non-http(s) scheme", async () => {
    const result = await listWith(
      remoteServer({
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "static",
            oauthClientSetup: {
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

describe("ConnectorCatalog server-name collisions", () => {
  test("loads neither of two ids that share a server name, and every other entry", async () => {
    const dir = freshCatalog();
    // `a.b/c` and `a/b.c` both slugify to `a-b-c`.
    writeStaticCatalog([
      remoteServer({ name: "a.b/c" }),
      remoteServer({ name: "io.safe/mcp" }),
      remoteServer({ name: "a/b.c" }),
    ]);
    const entries = await connectorListCatalog(dir).catalogEntries();
    expect(entries.map((e) => e.id)).toEqual(["io.safe/mcp"]);
    const said = readCatalogEntries(dir)
      .diagnostics.filter((d) => d.collision)
      .map((d) => d.message);
    expect(said).toHaveLength(2);
    for (const line of said) {
      expect(line).toContain('"a-b-c"');
      expect(line).toContain("a.b/c");
      expect(line).toContain("a/b.c");
    }
  });
});
