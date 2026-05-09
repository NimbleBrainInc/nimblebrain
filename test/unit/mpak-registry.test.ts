import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetMpakRegistryCache,
  loadMpakServers,
  MpakRegistry,
} from "../../src/registries/mpak-registry.ts";
import type { RegistryConfig } from "../../src/registries/types.ts";

/**
 * MpakRegistry now passthrough-projects whatever `/v1/servers/search`
 * returns (mpak-side composer owns the canonical wire format). Tests
 * stub `globalThis.fetch` since the SDK uses it under the hood.
 *
 * The module-level cache is reset between tests so a stale entry from
 * one test doesn't bleed into the next.
 */

const cfg: RegistryConfig = {
  id: "mpak",
  name: "mpak.dev",
  type: "mpak",
  enabled: true,
  url: "https://registry.example.test",
};

const originalFetch = globalThis.fetch;
let fetchMock: ((input: unknown, init?: unknown) => Promise<Response>) | null = null;

beforeEach(() => {
  fetchMock = null;
  _resetMpakRegistryCache();
  globalThis.fetch = ((input: unknown, init?: unknown) =>
    fetchMock
      ? fetchMock(input, init)
      : Promise.reject(new Error("fetch not stubbed"))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MpakRegistry.listEntries", () => {
  test("projects each ServerDetail in the response to a DirectoryEntry with iconUrl", async () => {
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
    const reg = new MpakRegistry(cfg);
    const entries = await reg.listEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("ai.nimblebrain/echo");
    expect(entries[0]?.iconUrl).toBe("https://x.test/echo.svg");
    expect(entries[0]?.install.kind).toBe("mpak-bundle");
  });

  test("throws on HTTP 5xx so the aggregator records a per-registry error", async () => {
    fetchMock = async () => new Response("nope", { status: 503 });
    const reg = new MpakRegistry(cfg);
    await expect(reg.listEntries()).rejects.toThrow(/mpak registry fetch failed/);
  });

  test("throws on network failure (signal aborted, host unreachable)", async () => {
    fetchMock = async () => {
      throw new TypeError("fetch failed");
    };
    const reg = new MpakRegistry(cfg);
    await expect(reg.listEntries()).rejects.toThrow(/mpak registry fetch failed/);
  });

  test("malformed payload (no `servers` array) yields zero entries, no throw", async () => {
    fetchMock = async () => new Response(JSON.stringify({ wrong: "shape" }), { status: 200 });
    const reg = new MpakRegistry(cfg);
    const entries = await reg.listEntries();
    expect(entries).toEqual([]);
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
    const reg = new MpakRegistry(cfg);
    const entries = await reg.listEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("ai.nimblebrain/ok");
  });

  test("undefined config.url falls through to SDK default — platform doesn't duplicate the constant", async () => {
    let observedUrl: string | undefined;
    fetchMock = async (input: unknown) => {
      observedUrl = String(input);
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    };
    const reg = new MpakRegistry({
      id: "mpak",
      name: "mpak.dev",
      type: "mpak",
      enabled: true,
      // no url
    });
    await reg.listEntries();
    expect(observedUrl).toContain("https://registry.mpak.dev/v1/servers/search");
  });
});

describe("loadMpakServers caching", () => {
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
    await loadMpakServers("https://registry.example.test");
    await loadMpakServers("https://registry.example.test");
    await loadMpakServers("https://registry.example.test");
    expect(calls).toBe(1);
  });

  test("failed fetch is NOT cached — next call retries (no negative cache masks an outage)", async () => {
    let calls = 0;
    fetchMock = async () => {
      calls++;
      throw new TypeError("connection refused");
    };
    await expect(loadMpakServers("https://registry.example.test")).rejects.toThrow();
    await expect(loadMpakServers("https://registry.example.test")).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
