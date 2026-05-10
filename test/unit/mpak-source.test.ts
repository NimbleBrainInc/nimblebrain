import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetMpakSourceCache, MpakSource } from "../../src/registries/mpak-source.ts";

/**
 * `MpakSource.fetch()` returns the raw upstream `ServerDetail[]` from
 * mpak's `/v1/servers/search`. The directory facade does projection,
 * filtering, and aggregation on top — those concerns aren't tested
 * here. This file pins the source's narrow contract:
 *
 *   1. Calls the right URL (operator override or SDK default).
 *   2. Returns ajv-valid ServerDetail[] only; drops malformed entries.
 *   3. Caches successful fetches; doesn't cache failures.
 *   4. Wraps backend errors with a `mpak registry fetch failed` prefix
 *      so the directory's per-source error tag stays readable.
 */

const SOURCE_ID = "mpak";
const URL = "https://registry.example.test";

const originalFetch = globalThis.fetch;
let fetchMock: ((input: unknown, init?: unknown) => Promise<Response>) | null = null;

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
});

describe("MpakSource.fetch", () => {
  test("returns ajv-valid ServerDetail[] from /v1/servers/search", async () => {
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/echo",
              description: "Echo bundle",
              version: "1.0.0",
              title: "Echo",
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
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const source = new MpakSource(SOURCE_ID, URL);
    const servers = await source.fetch();
    expect(servers.length).toBe(1);
    expect(servers[0]?.name).toBe("ai.nimblebrain/echo");
    expect(servers[0]?.icons?.[0]?.src).toBe("https://x.test/echo.svg");
  });

  test("throws on HTTP 5xx so the directory records a per-source error", async () => {
    fetchMock = async () => new Response("nope", { status: 503 });
    const source = new MpakSource(SOURCE_ID, URL);
    await expect(source.fetch()).rejects.toThrow(/mpak registry fetch failed/);
  });

  test("throws on network failure (signal aborted, host unreachable)", async () => {
    fetchMock = async () => {
      throw new TypeError("fetch failed");
    };
    const source = new MpakSource(SOURCE_ID, URL);
    await expect(source.fetch()).rejects.toThrow(/mpak registry fetch failed/);
  });

  test("malformed payload (no `servers` array) yields zero entries, no throw", async () => {
    fetchMock = async () => new Response(JSON.stringify({ wrong: "shape" }), { status: 200 });
    const source = new MpakSource(SOURCE_ID, URL);
    const servers = await source.fetch();
    expect(servers).toEqual([]);
  });

  test("drops individual entries that fail ServerDetail validation, keeps the rest", async () => {
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.nimblebrain/ok",
              description: "fine",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@x/ok",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
            { description: "missing name + version" },
            { name: "no-slash", description: "bad name format", version: "1.0.0" },
          ],
        }),
        { status: 200 },
      );
    const source = new MpakSource(SOURCE_ID, URL);
    const servers = await source.fetch();
    expect(servers.length).toBe(1);
    expect(servers[0]?.name).toBe("ai.nimblebrain/ok");
  });

  test("undefined baseUrl falls through to SDK default — platform doesn't duplicate the constant", async () => {
    let observedUrl: string | undefined;
    fetchMock = async (input: unknown) => {
      observedUrl = String(input);
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    };
    const source = new MpakSource(SOURCE_ID, undefined);
    await source.fetch();
    expect(observedUrl).toContain("https://registry.mpak.dev/v1/servers/search");
  });
});

describe("MpakSource pagination", () => {
  test("follows metadata.next_cursor across pages and concatenates results", async () => {
    const pages = [
      {
        servers: [
          {
            name: "ai.x/one",
            description: "first",
            version: "1.0.0",
            packages: [
              {
                registryType: "mpak",
                identifier: "@x/one",
                version: "1.0.0",
                transport: { type: "stdio" },
              },
            ],
          },
        ],
        metadata: { next_cursor: "cursor-page-2" },
      },
      {
        servers: [
          {
            name: "ai.x/two",
            description: "second",
            version: "1.0.0",
            packages: [
              {
                registryType: "mpak",
                identifier: "@x/two",
                version: "1.0.0",
                transport: { type: "stdio" },
              },
            ],
          },
        ],
        // No next_cursor — pagination terminates here.
      },
    ];
    let pageIdx = 0;
    fetchMock = async (input) => {
      const url = String(input);
      // Page 1: no cursor in URL. Page 2: cursor=cursor-page-2.
      const expected = pageIdx === 0 ? false : url.includes("cursor=cursor-page-2");
      if (pageIdx > 0 && !expected) {
        throw new Error(`page ${pageIdx + 1} request did not carry expected cursor — saw ${url}`);
      }
      const body = pages[pageIdx];
      pageIdx++;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const source = new MpakSource(SOURCE_ID, URL);
    const servers = await source.fetch();
    expect(servers.map((s) => s.name).sort()).toEqual(["ai.x/one", "ai.x/two"]);
    expect(pageIdx).toBe(2);
  });

  test("stops when next_cursor is absent — single-page registries don't loop", async () => {
    let calls = 0;
    fetchMock = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.x/only",
              description: "lone",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@x/only",
                  version: "1.0.0",
                  transport: { type: "stdio" },
                },
              ],
            },
          ],
          // metadata absent
        }),
        { status: 200 },
      );
    };
    const source = new MpakSource(SOURCE_ID, URL);
    const servers = await source.fetch();
    expect(servers.length).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("MpakSource caching", () => {
  test("second call within TTL hits cache — one fetch for repeated reads", async () => {
    let calls = 0;
    fetchMock = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          servers: [
            {
              name: "ai.x/y",
              description: "z",
              version: "1.0.0",
              packages: [
                {
                  registryType: "mpak",
                  identifier: "@x/y",
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
    const source = new MpakSource(SOURCE_ID, URL);
    await source.fetch();
    await source.fetch();
    await source.fetch();
    expect(calls).toBe(1);
  });

  test("failed fetch is NOT cached — next call retries (no negative cache masks an outage)", async () => {
    let calls = 0;
    fetchMock = async () => {
      calls++;
      throw new TypeError("connection refused");
    };
    const source = new MpakSource(SOURCE_ID, URL);
    await expect(source.fetch()).rejects.toThrow();
    await expect(source.fetch()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
