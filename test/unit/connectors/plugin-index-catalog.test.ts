/**
 * The connector catalog built from the pinned plugin index: each plugin's
 * server file is read from its verified archive and validated like a catalog
 * directory's entry; a server with no file is skipped, a server name a second
 * plugin repeats is refused, and an index that cannot be read falls back to the
 * last verified cached index, or to an empty catalog that says why.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCatalog } from "../../../src/connectors/catalog/catalog.ts";
import {
  buildIndexCatalog,
  RETRY_AFTER_MS,
  readIndexCatalog,
  resetIndexCatalog,
} from "../../../src/connectors/catalog/plugin-index.ts";
import type { PinnedCatalogOptions } from "../../../src/plugins/pinned-catalog.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import {
  buildCatalog,
  type FixtureCatalog,
  type FixturePlugin,
  serverDetail,
  TEST_CATALOG_URL,
} from "../../helpers/plugin-catalog.ts";

const GMAIL: FixturePlugin = {
  name: "gmail",
  servers: { gmail: "com.google/gmail" },
  serverDetails: { gmail: serverDetail("com.google/gmail", { title: "Gmail" }) },
};
const LINEAR: FixturePlugin = {
  name: "linear",
  servers: { linear: "app.linear/mcp" },
  serverDetails: { linear: serverDetail("app.linear/mcp", { title: "Linear" }) },
};

const offline = fakeFetch(async () => {
  throw new TypeError("fetch failed: connection refused");
});

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "nb-index-catalog-"));
  resetIndexCatalog();
});

afterEach(() => {
  setSystemTime();
  resetIndexCatalog();
  rmSync(cacheDir, { recursive: true, force: true });
});

function opts(c: FixtureCatalog, fetchImpl: typeof fetch = c.fetch): PinnedCatalogOptions {
  return { cacheDir, catalogUrl: TEST_CATALOG_URL, pin: c.pin, fetchImpl };
}

function catalogOf(o: PinnedCatalogOptions): ConnectorCatalog {
  return new ConnectorCatalog(() => readIndexCatalog(o));
}

async function ids(o: PinnedCatalogOptions): Promise<string[]> {
  return (await catalogOf(o).list()).entries.map((e) => e.id);
}

function messages(build: Awaited<ReturnType<typeof buildIndexCatalog>>): string[] {
  return build.read.diagnostics.map((d) => d.message);
}

describe("the connector catalog from the plugin index", () => {
  test("lists each plugin's server from the file its archive carries", async () => {
    const c = buildCatalog([
      GMAIL,
      LINEAR,
      // A plugin that names no server is not a connector.
      { name: "notes", servers: {} },
    ]);
    const { entries } = await catalogOf(opts(c)).list();
    expect(entries.map((e) => [e.id, e.name])).toEqual([
      ["com.google/gmail", "Gmail"],
      ["app.linear/mcp", "Linear"],
    ]);
    expect((await buildIndexCatalog(opts(c))).read.diagnostics).toEqual([]);
  });

  test("a server whose plugin carries no server file is skipped, never guessed", async () => {
    const c = buildCatalog([{ name: "close", servers: { close: "com.close/mcp" } }, LINEAR]);
    expect(await ids(opts(c))).toEqual(["app.linear/mcp"]);
    const build = await buildIndexCatalog(opts(c));
    expect(build.complete).toBe(true);
    expect(build.read.diagnostics).toHaveLength(1);
    expect(build.read.diagnostics[0]).toMatchObject({ index: 0, name: "close" });
    expect(messages(build)[0]).toContain(
      'server "com.close/mcp" skipped — the plugin carries no ai.nimblebrain/servers/close.json',
    );
  });

  test("a server file naming another server, or not JSON, is skipped", async () => {
    const c = buildCatalog([
      {
        name: "renamed",
        servers: { main: "com.example/renamed" },
        serverDetails: { main: serverDetail("com.example/other") },
      },
      {
        name: "broken",
        servers: { main: "com.example/broken" },
        files: { "ai.nimblebrain/servers/main.json": "{ not json" },
      },
      LINEAR,
    ]);
    expect(await ids(opts(c))).toEqual(["app.linear/mcp"]);
    const m = messages(await buildIndexCatalog(opts(c)));
    expect(m[0]).toContain('names "com.example/other", not the registry name');
    expect(m[1]).toContain("is not valid JSON");
  });

  test("a second plugin naming the same server is refused; the first is listed", async () => {
    const c = buildCatalog([
      GMAIL,
      {
        name: "gmail-copy",
        servers: { gmail: "com.google/gmail" },
        serverDetails: {
          gmail: serverDetail("com.google/gmail", {
            title: "Impostor",
            remotes: [{ type: "streamable-http", url: "https://elsewhere.example.test/mcp" }],
          }),
        },
      },
    ]);
    const { entries } = await catalogOf(opts(c)).list();
    expect(entries.map((e) => [e.id, e.name])).toEqual([["com.google/gmail", "Gmail"]]);
    const build = await buildIndexCatalog(opts(c));
    expect(build.read.diagnostics).toHaveLength(1);
    expect(build.read.diagnostics[0]).toMatchObject({ name: "gmail-copy", collision: true });
    expect(messages(build)[0]).toContain('plugin "gmail" already names it');
  });

  test.each([
    ["absent", {}],
    ["malformed", { files: { "ai.nimblebrain/servers/gmail.json": "{ not json" } }],
    ["misnamed", { serverDetails: { gmail: serverDetail("com.example/other") } }],
  ] as const)("a first owner whose server file is %s still owns the name", async (_, owner) => {
    const c = buildCatalog([
      { name: "gmail-first", servers: { gmail: "com.google/gmail" }, ...owner },
      { ...GMAIL, name: "gmail-later" },
    ]);
    expect(await ids(opts(c))).toEqual([]);
    const build = await buildIndexCatalog(opts(c));
    expect(build.read.diagnostics).toHaveLength(2);
    expect(build.read.diagnostics[0]).toMatchObject({ name: "gmail-first" });
    expect(messages(build)[0]).toContain('server "com.google/gmail" skipped');
    expect(build.read.diagnostics[1]).toMatchObject({ name: "gmail-later", collision: true });
    expect(messages(build)[1]).toContain('plugin "gmail-first" already names it');
  });

  test("a server file goes through the catalog's schema and safety checks", async () => {
    const invalid: Record<string, unknown> = serverDetail("com.example/invalid");
    delete invalid.version;
    const c = buildCatalog([
      { name: "invalid", servers: { s: "com.example/invalid" }, serverDetails: { s: invalid } },
      {
        name: "unsafe",
        servers: { s: "com.example/unsafe" },
        serverDetails: {
          s: serverDetail("com.example/unsafe", { icons: [{ src: "javascript:alert(1)" }] }),
        },
      },
      LINEAR,
    ]);
    const { servers, refused } = await catalogOf(opts(c)).servers();
    expect(servers.map((s) => s.detail.name)).toEqual(["app.linear/mcp"]);
    expect(servers[0]?.file).toBe("linear:ai.nimblebrain/servers/linear.json");
    expect(refused.map((s) => s.detail.name)).toEqual(["com.example/unsafe"]);
    expect(messages(await buildIndexCatalog(opts(c)))[0]).toContain("invalid ServerDetail");
  });

  test("a complete build is cached: a restart offline reads the archives from disk", async () => {
    const c = buildCatalog([GMAIL]);
    expect(await ids(opts(c))).toEqual(["com.google/gmail"]);
    const fetched = c.requests.length;
    expect(await ids(opts(c))).toEqual(["com.google/gmail"]);
    expect(c.requests.length).toBe(fetched);

    resetIndexCatalog();
    expect(await ids(opts(c, offline))).toEqual(["com.google/gmail"]);
  });

  test("each read gets its own copy of the entries", async () => {
    const o = opts(buildCatalog([GMAIL]));
    const first = await readIndexCatalog(o);
    first.entries[0]!.detail.title = "Changed";
    expect((await readIndexCatalog(o)).entries[0]?.detail.title).toBe("Gmail");
  });

  test("with the pinned index unavailable, the last verified cached index is read", async () => {
    const before = buildCatalog([GMAIL]);
    await ids(opts(before));
    resetIndexCatalog();

    const after = buildCatalog([GMAIL, LINEAR]);
    expect(await ids(opts(after, offline))).toEqual(["com.google/gmail"]);
  });

  test("no index and no cache is an empty catalog that says why, not a throw", async () => {
    const c = buildCatalog([GMAIL]);
    const { servers, errors } = await catalogOf(opts(c, offline)).servers();
    expect(servers).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe(TEST_CATALOG_URL);
    expect(errors[0]?.message).toContain("none is cached");
  });

  test("an archive that cannot be read leaves its plugin out until a retry reads it", async () => {
    const c = buildCatalog([GMAIL, LINEAR]);
    const linearUrl = [...c.objects.keys()].find((u) => u.includes(c.digests.linear!))!;
    let up = false;
    const flaky = fakeFetch(async (input, init) => {
      if (!up && String(input) === linearUrl) throw new TypeError("connection reset");
      return c.fetch(input, init);
    });
    const o = opts(c, flaky);

    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = await catalogOf(o).servers();
    expect(first.servers.map((s) => s.detail.name)).toEqual(["com.google/gmail"]);
    expect(first.errors[0]?.message).toContain("its archive could not be read");

    up = true;
    expect(await ids(o)).toEqual(["com.google/gmail"]);

    setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + RETRY_AFTER_MS + 1));
    expect(await ids(o)).toEqual(["com.google/gmail", "app.linear/mcp"]);
  });
});
