import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogListings, RETRY_AFTER_MS } from "../../../src/catalogs/reader.ts";
import {
  listingBytes,
  listingEntry,
  pathCatalog,
  sha256Of,
  urlCatalog,
} from "../../helpers/ai-catalog.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";

const URL_ = "https://catalog.test/.well-known/ai-catalog.json";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-catalog-reader-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch serving `body()` at the listing URL, recording every URL asked for. */
function server(body: () => Uint8Array | null) {
  const requests: string[] = [];
  const fetchImpl = fakeFetch(async (input) => {
    const url = String(input);
    requests.push(url);
    const bytes = url === URL_ ? body() : null;
    if (!bytes) return new Response("no", { status: bytes === null && url === URL_ ? 503 : 404 });
    return new Response(bytes, { status: 200 });
  });
  return { fetchImpl, requests };
}

const ahrefs = listingEntry({ name: "ahrefs" });
const zoom = listingEntry({
  name: "zoom",
  tags: ["video"],
  nimblebrainOnly: true,
  servers: { zoom: { name: "us.zoom/mcp", auth: "composio" } },
});

describe("createCatalogListings", () => {
  test("reads a listing in the live catalog's shape, without fetching any artifact", async () => {
    const live = server(() => listingBytes([ahrefs, zoom]));
    const listings = createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_)],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
    });
    const [snap] = await listings.snapshots();
    expect(snap?.origin).toBe("source");
    expect(snap?.entries.map((e) => e.address)).toEqual(["ahrefs@nimblebrain", "zoom@nimblebrain"]);
    const z = snap?.entries[1];
    expect(z?.displayName).toBe("Zoom");
    expect(z?.tags).toEqual(["video"]);
    expect(z?.nimblebrainOnly).toBe(true);
    expect(z?.category).toBe("Productivity");
    expect(z?.iconUrl).toBe("https://static.test/logos/zoom/light.svg");
    expect(z?.servers).toEqual({ zoom: { name: "us.zoom/mcp", auth: "composio" } });
    expect(live.requests).toEqual([URL_]);
  });

  test("a listing that matches its pin is used and never read again", async () => {
    const bytes = listingBytes([ahrefs]);
    let t = 0;
    const live = server(() => bytes);
    const listings = createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_, { sha256: sha256Of(bytes) })],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
      now: () => t,
    });
    expect((await listings.snapshots())[0]?.entries).toHaveLength(1);
    t += 24 * 60 * 60_000;
    await listings.snapshots();
    await listings.refresh();
    expect(live.requests).toHaveLength(1);
  });

  test("a listing that does not match its pin is refused, and the catalog lists nothing", async () => {
    const live = server(() => listingBytes([ahrefs]));
    const listings = createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_, { sha256: "0".repeat(64) })],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
    });
    const [snap] = await listings.snapshots();
    expect(snap?.origin).toBe("none");
    expect(snap?.entries).toEqual([]);
    expect(snap?.error).toMatch(/does not match its pin/);
  });

  test("a path source reads a file, or the listing in a directory", async () => {
    const file = join(dir, "vendor.json");
    writeFileSync(file, listingBytes([ahrefs]));
    const local = join(dir, "local");
    mkdirSync(join(local, ".well-known"), { recursive: true });
    writeFileSync(join(local, ".well-known", "ai-catalog.json"), listingBytes([zoom]));
    const listings = createCatalogListings({
      catalogs: [pathCatalog("vendor", file), pathCatalog("local", local)],
      cacheDir: join(dir, "cache"),
    });
    const [vendor, mounted] = await listings.snapshots();
    expect(vendor?.entries.map((e) => e.address)).toEqual(["ahrefs@vendor"]);
    expect(mounted?.entries.map((e) => e.address)).toEqual(["zoom@local"]);
  });

  test("a pinned path source is verified against its pin", async () => {
    const file = join(dir, "vendor.json");
    writeFileSync(file, listingBytes([ahrefs]));
    const listings = createCatalogListings({
      catalogs: [pathCatalog("vendor", file, { sha256: "1".repeat(64) })],
      cacheDir: join(dir, "cache"),
    });
    expect((await listings.snapshots())[0]?.error).toMatch(/does not match its pin/);
  });

  test("invalid entries are dropped with a diagnostic; the rest load", async () => {
    const bad = [
      { identifier: "urn:air:x:no-type:plugin", url: "https://x.test/a.zip" },
      { ...listingEntry({ name: "both" }), data: {} },
      { ...listingEntry({ name: "weakdigest" }), digest: "md5:abc" },
      listingEntry({ name: "badauth", servers: { s: { name: "com.x/mcp", auth: "Not An Id" } } }),
      {
        ...listingEntry({ name: "badicon" }),
        extensions: { "ai.nimblebrain": { iconUrl: "javascript:alert(1)" } },
      },
      ahrefs,
      { ...ahrefs, identifier: "urn:air:other.example:ahrefs:plugin" },
    ];
    const live = server(() => listingBytes(bad));
    const [snap] = await createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_)],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
    }).snapshots();
    expect(snap?.entries.map((e) => e.address)).toEqual(["ahrefs@nimblebrain"]);
    expect(snap?.diagnostics.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 6]);
    expect(snap?.diagnostics[0]?.message).toMatch(/no "type"/);
    expect(snap?.diagnostics[5]?.message).toMatch(/another entry's/);
  });

  test("a document that is not an AI Catalog this host reads is refused whole", async () => {
    const live = server(() =>
      new TextEncoder().encode(JSON.stringify({ specVersion: "2.0", entries: [] })),
    );
    const [snap] = await createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_)],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
    }).snapshots();
    expect(snap?.origin).toBe("none");
    expect(snap?.error).toMatch(/major this host does not read/);
  });

  test("an unreachable catalog falls back to the cached last good copy", async () => {
    const first = server(() => listingBytes([ahrefs]));
    await createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_)],
      cacheDir: dir,
      fetchImpl: first.fetchImpl,
    }).snapshots();

    // A restart with the catalog down reads the copy the work directory kept.
    const down = server(() => null);
    const [snap] = await createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_)],
      cacheDir: dir,
      fetchImpl: down.fetchImpl,
    }).snapshots();
    expect(snap?.origin).toBe("cache");
    expect(snap?.error).toMatch(/HTTP 503/);
    expect(snap?.entries.map((e) => e.address)).toEqual(["ahrefs@nimblebrain"]);
  });

  test("offline with nothing cached, the catalog is empty and says why", async () => {
    const down = server(() => null);
    const [snap] = await createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_)],
      cacheDir: dir,
      fetchImpl: down.fetchImpl,
    }).snapshots();
    expect(snap?.origin).toBe("none");
    expect(snap?.entries).toEqual([]);
    expect(snap?.error).toMatch(/HTTP 503/);
  });

  test("an unpinned listing refreshes once its interval passes, behind the copy it has", async () => {
    let t = 0;
    let entries = [ahrefs];
    const live = server(() => listingBytes(entries));
    const listings = createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_, { refreshMs: 60_000 })],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
      now: () => t,
    });
    expect((await listings.snapshots())[0]?.entries).toHaveLength(1);
    entries = [ahrefs, zoom];

    t += 30_000;
    expect((await listings.snapshots())[0]?.entries).toHaveLength(1);
    expect(live.requests).toHaveLength(1);

    t += 30_000;
    // Due: the copy in hand is answered while the read runs behind it.
    expect((await listings.snapshots())[0]?.entries).toHaveLength(1);
    await Bun.sleep(0);
    expect((await listings.snapshots())[0]?.entries).toHaveLength(2);
    expect(live.requests).toHaveLength(2);
  });

  test("a failed read keeps the copy in memory and is retried after the retry delay", async () => {
    let t = 0;
    let up = true;
    const live = server(() => (up ? listingBytes([ahrefs]) : null));
    const listings = createCatalogListings({
      catalogs: [urlCatalog("nimblebrain", URL_, { refreshMs: 10 * 60_000 })],
      cacheDir: dir,
      fetchImpl: live.fetchImpl,
      now: () => t,
    });
    await listings.snapshots();
    up = false;
    t += 10 * 60_000;
    await listings.snapshots();
    await Bun.sleep(0);
    const [kept] = await listings.snapshots();
    expect(kept?.entries).toHaveLength(1);
    expect(kept?.error).toMatch(/HTTP 503/);
    expect(live.requests).toHaveLength(2);
    t += RETRY_AFTER_MS;
    await listings.snapshots();
    expect(live.requests).toHaveLength(3);
  });
});

describe("one connection name is one server across listings", () => {
  test("a later entry whose server slugifies to an earlier one's connection is dropped and said", async () => {
    // `a.b/c` and `a/b.c` both take connection `a-b-c`.
    const first = listingEntry({ name: "first", servers: { s: { name: "a.b/c", auth: "dcr" } } });
    const same = listingEntry({ name: "same", servers: { s: { name: "a.b/c", auth: "dcr" } } });
    const clash = listingEntry({ name: "clash", servers: { s: { name: "a/b.c", auth: "dcr" } } });
    const inner = listingEntry({ name: "inner", servers: { s: { name: "a/b.c", auth: "dcr" } } });
    const other = listingEntry({ name: "other" });
    const one = join(dir, "one.json");
    const two = join(dir, "two.json");
    writeFileSync(one, listingBytes([first, inner, other]));
    writeFileSync(two, listingBytes([same, clash]));
    const listings = createCatalogListings({
      catalogs: [pathCatalog("one", one), pathCatalog("two", two)],
      cacheDir: join(dir, "cache"),
    });

    const [a, b] = await listings.snapshots();
    // First in configuration, then listing, order keeps it; the same name elsewhere is one server.
    expect(a?.entries.map((e) => e.address)).toEqual(["first@one", "other@one"]);
    expect(b?.entries.map((e) => e.address)).toEqual(["same@two"]);
    expect(a?.diagnostics.map((d) => d.identifier)).toEqual([String(inner.identifier)]);
    expect(b?.diagnostics.map((d) => d.identifier)).toEqual([String(clash.identifier)]);
    expect(b?.diagnostics[0]?.message).toContain('"a/b.c" takes connection "a-b-c"');
    expect(b?.diagnostics[0]?.message).toContain('"a.b/c" (first@one)');
    // The same objects until a catalog's listing changes.
    expect(await listings.snapshots()).toEqual([a, b]);
    expect((await listings.snapshots())[1]).toBe(b);
  });
});
