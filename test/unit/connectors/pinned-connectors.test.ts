/**
 * The connector list read from the pinned plugin catalog: only bytes that hash
 * to the pin are used, a verified list is cached and read offline, and a
 * catalog that cannot answer leaves an empty catalog with the reason, never a
 * throw.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCatalog } from "../../../src/connectors/catalog/catalog.ts";
import {
  loadPinnedConnectors,
  RETRY_AFTER_MS,
  resetPinnedConnectorAttempts,
} from "../../../src/connectors/catalog/pinned.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import { sha256 } from "../../helpers/plugin-catalog.ts";

const CATALOG_URL = "https://catalog.test";

function list(name: string): Uint8Array {
  return new TextEncoder().encode(`servers:
  - name: ${name}
    title: Fixture
    description: A fixture connector
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://mcp.example.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
`);
}

/** A catalog serving `objects` by URL, 404 for anything else, recording each request. */
function serve(objects: Record<string, Uint8Array>) {
  const requests: string[] = [];
  const fetchImpl = fakeFetch(async (input) => {
    const url = input.toString();
    requests.push(url);
    const body = objects[url];
    return body ? new Response(body) : new Response("", { status: 404 });
  });
  return { fetchImpl, requests };
}

const offline = fakeFetch(async () => {
  throw new TypeError("fetch failed: connection refused");
});

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "nb-pinned-connectors-"));
  resetPinnedConnectorAttempts();
});

afterEach(() => {
  setSystemTime();
  rmSync(cacheDir, { recursive: true, force: true });
});

async function servers(opts: Parameters<typeof loadPinnedConnectors>[0]): Promise<string[]> {
  const catalog = new ConnectorCatalog(() => loadPinnedConnectors(opts));
  return (await catalog.servers()).servers.map((s) => s.detail.name);
}

describe("loadPinnedConnectors", () => {
  test("reads the copy kept under the pin first", async () => {
    const bytes = list("com.example/kept");
    const pin = sha256(bytes);
    const catalog = serve({ [`${CATALOG_URL}/nimblebrain/connectors/${pin}.yaml`]: bytes });

    expect(await servers({ cacheDir, catalogUrl: CATALOG_URL, sha256: pin, ...catalog })).toEqual([
      "com.example/kept",
    ]);
    expect(catalog.requests).toEqual([`${CATALOG_URL}/nimblebrain/connectors/${pin}.yaml`]);
  });

  test("takes the current list when the catalog keeps no copy and it matches the pin", async () => {
    const bytes = list("com.example/current");
    const pin = sha256(bytes);
    const catalog = serve({ [`${CATALOG_URL}/nimblebrain/connectors.yaml`]: bytes });

    expect(await servers({ cacheDir, catalogUrl: CATALOG_URL, sha256: pin, ...catalog })).toEqual([
      "com.example/current",
    ]);
    expect(existsSync(join(cacheDir, "connectors", `${pin}.yaml`))).toBe(true);
  });

  test("a verified list is cached: the next read, offline, fetches nothing", async () => {
    const bytes = list("com.example/cached");
    const pin = sha256(bytes);
    const online = serve({ [`${CATALOG_URL}/nimblebrain/connectors.yaml`]: bytes });
    await loadPinnedConnectors({ cacheDir, catalogUrl: CATALOG_URL, sha256: pin, ...online });

    resetPinnedConnectorAttempts();
    const requests: string[] = [];
    const fetchImpl = fakeFetch(async (input) => {
      requests.push(input.toString());
      throw new TypeError("offline");
    });
    expect(await servers({ cacheDir, catalogUrl: CATALOG_URL, sha256: pin, fetchImpl })).toEqual([
      "com.example/cached",
    ]);
    expect(requests).toEqual([]);
  });

  test("a list that does not match the pin is refused and never cached", async () => {
    const pin = sha256(list("com.example/pinned"));
    const catalog = serve({
      [`${CATALOG_URL}/nimblebrain/connectors.yaml`]: list("com.example/moved-on"),
    });

    const file = await loadPinnedConnectors({
      cacheDir,
      catalogUrl: CATALOG_URL,
      sha256: pin,
      ...catalog,
    });
    expect("error" in file && file.error).toContain("does not match the pin");
    expect(existsSync(join(cacheDir, "connectors", `${pin}.yaml`))).toBe(false);
  });

  test("with the pin unavailable, the newest verified list in the cache is read", async () => {
    const dir = join(cacheDir, "connectors");
    mkdirSync(dir, { recursive: true });
    const older = list("com.example/older");
    const newer = list("com.example/newer");
    writeFileSync(join(dir, `${sha256(older)}.yaml`), older);
    writeFileSync(join(dir, `${sha256(newer)}.yaml`), newer);
    utimesSync(join(dir, `${sha256(older)}.yaml`), 1, 1);
    // A corrupted copy is never read, however new.
    writeFileSync(join(dir, `${"c".repeat(64)}.yaml`), newer);

    expect(
      await servers({
        cacheDir,
        catalogUrl: CATALOG_URL,
        sha256: sha256(list("com.example/pinned")),
        fetchImpl: offline,
      }),
    ).toEqual(["com.example/newer"]);
  });

  test("a fallback list changed within the retry window is refused, not read", async () => {
    const dir = join(cacheDir, "connectors");
    mkdirSync(dir, { recursive: true });
    const original = list("com.example/original");
    const fallbackPath = join(dir, `${sha256(original)}.yaml`);
    writeFileSync(fallbackPath, original);
    const opts = {
      cacheDir,
      catalogUrl: CATALOG_URL,
      sha256: sha256(list("com.example/pinned")),
      fetchImpl: offline,
    };

    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(await servers(opts)).toEqual(["com.example/original"]);
    writeFileSync(fallbackPath, list("com.example/changed"));
    expect(await servers(opts)).toEqual([]);
  });

  test("a cache that cannot be written or listed is an empty catalog, and recovers once repaired", async () => {
    const bytes = list("com.example/repaired");
    const pin = sha256(bytes);
    const catalog = serve({ [`${CATALOG_URL}/nimblebrain/connectors.yaml`]: bytes });
    const opts = { cacheDir, catalogUrl: CATALOG_URL, sha256: pin, ...catalog };
    // A file where the cache directory belongs: the write and the listing both fail (ENOTDIR).
    const blocked = join(cacheDir, "connectors");
    writeFileSync(blocked, "not a directory");

    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const file = await loadPinnedConnectors(opts);
    expect("error" in file && file.error).toContain("could not be cached");

    rmSync(blocked);
    setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + RETRY_AFTER_MS + 1));
    expect(await servers(opts)).toEqual(["com.example/repaired"]);
  });

  test("no cache and no network is an empty catalog that says why, not a throw", async () => {
    const catalog = new ConnectorCatalog(() =>
      loadPinnedConnectors({
        cacheDir,
        catalogUrl: CATALOG_URL,
        sha256: "d".repeat(64),
        fetchImpl: offline,
      }),
    );
    const { servers: entries, errors } = await catalog.servers();
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe(CATALOG_URL);
    expect(errors[0]?.message).toContain("none is cached");
  });

  test("a failed fetch is retried only after the retry window", async () => {
    const bytes = list("com.example/later");
    const pin = sha256(bytes);
    let up = false;
    const requests: string[] = [];
    const fetchImpl = fakeFetch(async (input) => {
      const url = input.toString();
      requests.push(url);
      if (!up) throw new TypeError("offline");
      return url.endsWith("/connectors.yaml")
        ? new Response(bytes)
        : new Response("", { status: 404 });
    });
    const opts = { cacheDir, catalogUrl: CATALOG_URL, sha256: pin, fetchImpl };

    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect("error" in (await loadPinnedConnectors(opts))).toBe(true);
    const afterFirst = requests.length;

    up = true;
    expect("error" in (await loadPinnedConnectors(opts))).toBe(true);
    expect(requests.length).toBe(afterFirst);

    setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + RETRY_AFTER_MS + 1));
    expect(await loadPinnedConnectors(opts)).toEqual({
      path: join(cacheDir, "connectors", `${pin}.yaml`),
    });
  });
});
