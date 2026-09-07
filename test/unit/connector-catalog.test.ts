import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";

/**
 * `ConnectorCatalog` is the only thing tool handlers should call.
 * These tests pin the contract that composition across the catalog's
 * files — error isolation, dedup, projection, the safety scrub, the
 * lookup tables — lives in one place.
 *
 * A catalog is a directory of `ServerDetail` files, so a test writes
 * the files it wants and points the catalog at the directory. Two
 * files stand in for "curation split across more than one file",
 * which is what the aggregation and isolation contracts care about.
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

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("ConnectorCatalog.list", () => {
  test("aggregates entries from every catalog file, projecting to CatalogListing", async () => {
    const catalogDir = freshCatalog();
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

    const result = await new ConnectorCatalog(catalogDir).list();
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
      const result = await new ConnectorCatalog(catalogDir).list();
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

    const result = await new ConnectorCatalog(catalogDir).list();
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.description).toBe("first");
  });

  test("operatorConfigured probe runs only for static-auth entries with operatorSetup", async () => {
    const catalogDir = freshCatalog();
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
    const probe = mock(async () => true);
    const result = await new ConnectorCatalog(catalogDir).list({ isOperatorConfigured: probe });
    // Only Asana (static-auth + operatorSetup) gets probed; Granola (dcr) doesn't.
    expect(probe).toHaveBeenCalledTimes(1);
    const asana = result.entries.find((e) => e.id === "io.asana/mcp");
    expect(asana?.operatorConfigured).toBe(true);
  });

  test("a packages-only entry is dropped — this runtime installs no downloaded code", async () => {
    const catalogDir = freshCatalog();
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

    const result = await new ConnectorCatalog(catalogDir).list();
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

    const directory = new ConnectorCatalog(catalogDir);
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
    const catalogDir = freshCatalog();
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

    const entry = await new ConnectorCatalog(catalogDir).catalogById("ai.nimblebrain/web");
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
    const path = writeStaticCatalog([server]);
    return new ConnectorCatalog(catalogDir).list();
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
