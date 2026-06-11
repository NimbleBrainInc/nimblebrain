import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { _resetMpakSourceCache } from "../../src/registries/mpak-source.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";

/**
 * `ConnectorDirectory` is the only thing tool handlers should call.
 * These tests pin the contract that uniform behavior — scope
 * filtering, error isolation, dedup, projection, lookup tables —
 * lives in one place regardless of which sources are configured.
 *
 * Sources are stubbed by writing a tiny static catalog YAML +
 * stubbing global `fetch` for the mpak source.
 */

const originalFetch = globalThis.fetch;
let fetchMock: ((input: unknown, init?: unknown) => Promise<Response>) | null = null;
let workDir: string;

function freshStore(): RegistryStore {
  workDir = mkdtempSync(join(tmpdir(), "directory-test-"));
  return new RegistryStore(workDir);
}

function writeStaticCatalog(servers: Record<string, unknown>[]): string {
  const path = join(workDir, "catalog.yaml");
  writeFileSync(path, `servers:\n${servers.map((s) => `  - ${JSON.stringify(s)}`).join("\n")}\n`);
  return path;
}

function configureRegistries(_store: RegistryStore, configs: object[]): Promise<void> {
  // RegistryStore.load() auto-injects a `bundled-static` row pointing at
  // the platform's shipped catalog.yaml when missing — that row would
  // pollute every test with a fixed set of entries. Pre-seed an empty
  // bundled-static placeholder pointing at /dev/null so readStaticServers
  // gracefully returns []; tests then add only the sources they want.
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

beforeEach(() => {
  fetchMock = null;
  _resetMpakSourceCache();
  globalThis.fetch = ((input: unknown, init?: unknown) =>
    fetchMock
      ? fetchMock(input, init)
      : Promise.reject(new Error("fetch not stubbed"))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("ConnectorDirectory.list", () => {
  test("aggregates entries from every enabled source, projecting to DirectoryEntry", async () => {
    const store = freshStore();
    const path = writeStaticCatalog([
      {
        name: "ai.granola/mcp",
        description: "Granola",
        version: "1.0.0",
        title: "Granola",
        icons: [{ src: "https://x.test/granola.svg" }],
        remotes: [{ type: "streamable-http", url: "https://api.granola.test/mcp" }],
      },
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
      { id: "mpak", name: "mpak.dev", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@nimblebraininc/echo",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );

    const result = await new ConnectorDirectory(store).list();
    expect(result.errors).toEqual([]);
    expect(result.entries.map((e) => e.id).sort()).toEqual([
      "ai.granola/mcp",
      "ai.nimblebrain/echo",
    ]);
  });

  test("isolates per-source failures — a down mpak doesn't blank the static catalog", async () => {
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
      { id: "mpak", name: "mpak.dev", type: "mpak", enabled: true },
    ]);
    fetchMock = async () => new Response("nope", { status: 503 });

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.registryId).toBe("mpak");
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
    ]);
    await configureRegistries(store, [
      { id: "static", name: "Static", type: "static", enabled: true, url: path },
    ]);

    const directory = new ConnectorDirectory(store);
    const result = await directory.list();
    // Even if the projection somehow ran twice, dedup keeps the first.
    expect(result.entries.length).toBe(1);
  });

  test("scope filter: matches by reverse-DNS prefix (ai.nimblebrain → ai.nimblebrain/echo)", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      {
        id: "mpak-nb",
        name: "NimbleBrain bundles",
        type: "mpak",
        enabled: true,
        scopes: ["ai.nimblebrain"],
      },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@nimblebraininc/echo",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
            {
              name: "com.acme/widget",
              description: "Acme widget",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@acme/widget",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.map((e) => e.id)).toEqual(["ai.nimblebrain/echo"]);
  });

  test("scope filter: matches by npm scope (nimblebraininc → @nimblebraininc/echo)", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      {
        id: "mpak-nb",
        name: "NimbleBrain bundles",
        type: "mpak",
        enabled: true,
        scopes: ["nimblebraininc"],
      },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@nimblebraininc/echo",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
            {
              name: "com.acme/widget",
              description: "Acme",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@acme/widget",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );

    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.map((e) => e.id)).toEqual(["ai.nimblebrain/echo"]);
  });

  test("empty / undefined scopes = no filter (unchanged behavior)", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@nimblebraininc/echo",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
            {
              name: "com.acme/widget",
              description: "Acme",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@acme/widget",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );

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
});

describe("ConnectorDirectory lookup tables", () => {
  test("catalogByUrl + iconByPackage are built from one shared fetch (memoized)", async () => {
    const store = freshStore();
    let calls = 0;
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo",
              version: "1.0.0",
              icons: [{ src: "https://x.test/echo.svg" }],
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@nimblebraininc/echo",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    };
    const directory = new ConnectorDirectory(store);
    await directory.list();
    await directory.catalogByUrl();
    await directory.iconByPackage();
    await directory.catalogById("ai.nimblebrain/echo");
    expect(calls).toBe(1);
  });

  test("iconByPackage maps npm-scoped package identifier → icon src", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo",
              version: "1.0.0",
              icons: [{ src: "https://x.test/echo.svg" }],
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@nimblebraininc/echo",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    const icons = await new ConnectorDirectory(store).iconByPackage();
    expect(icons.get("@nimblebraininc/echo")).toBe("https://x.test/echo.svg");
  });
});

describe("ConnectorDirectory safety scrub (mpak XSS via _meta extension URLs)", () => {
  // Pre-fix only static-source ran the URL-scheme allowlist + reserved
  // OAuth-param check. Mpak entries reached projection unchecked, so a
  // non-curated mpak publisher could ship `_meta.docsUrl: "javascript:..."`
  // and the Configure page would render it as a clickable `<a href>`
  // (target="_blank" rel="noopener noreferrer" does NOT block javascript:
  // URI execution). Hoisting the check into ConnectorDirectory.fetchAll
  // means every source — mpak / static / future — is scrubbed at one
  // boundary. These tests pin the protection from the mpak side, which
  // was the gap.

  function mpakServer(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "io.evil/mcp",
      description: "Evil",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://evil.test/mcp" }],
      ...over,
    };
  }

  test("drops mpak entry whose _meta.docsUrl carries a javascript: scheme", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            mpakServer({
              _meta: {
                "ai.nimblebrain/connector": {
                  auth: "dcr",
                  docsUrl: "javascript:alert(1)",
                },
              },
            }),
          ],
        }),
        { status: 200 },
      );
    const result = await new ConnectorDirectory(store).list();
    expect(result.entries).toEqual([]);
  });

  test("drops mpak entry whose _meta.operatorSetup.portalUrl carries a non-http(s) scheme", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            mpakServer({
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
          ],
        }),
        { status: 200 },
      );
    const result = await new ConnectorDirectory(store).list();
    expect(result.entries).toEqual([]);
  });

  test("drops mpak entry whose _meta.additionalAuthorizationParams contains a reserved OAuth key", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            mpakServer({
              _meta: {
                "ai.nimblebrain/connector": {
                  auth: "dcr",
                  additionalAuthorizationParams: { client_id: "attacker-controlled" },
                },
              },
            }),
          ],
        }),
        { status: 200 },
      );
    const result = await new ConnectorDirectory(store).list();
    expect(result.entries).toEqual([]);
  });

  test("drops mpak entry whose icons[].src is a non-http(s) scheme", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            mpakServer({
              icons: [{ src: "data:image/svg+xml;<script>alert(1)</script>" }],
            }),
          ],
        }),
        { status: 200 },
      );
    const result = await new ConnectorDirectory(store).list();
    expect(result.entries).toEqual([]);
  });

  test("safe mpak entries pass unmodified — scrub doesn't over-reject", async () => {
    const store = freshStore();
    await configureRegistries(store, [
      { id: "mpak", name: "mpak", type: "mpak", enabled: true },
    ]);
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            mpakServer({
              name: "io.safe/mcp",
              icons: [{ src: "https://x.test/safe.png" }],
              _meta: {
                "ai.nimblebrain/connector": {
                  auth: "dcr",
                  docsUrl: "https://safe.example/docs",
                },
              },
            }),
          ],
        }),
        { status: 200 },
      );
    const result = await new ConnectorDirectory(store).list();
    expect(result.entries.map((e) => e.id)).toEqual(["io.safe/mcp"]);
  });
});
