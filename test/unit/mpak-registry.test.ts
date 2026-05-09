import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bundleToServerDetail,
  mechanicalReverseDnsName,
  MpakRegistry,
} from "../../src/registries/mpak-registry.ts";
import type { RegistryConfig } from "../../src/registries/types.ts";

describe("mechanicalReverseDnsName", () => {
  test("scoped npm name → dev.mpak.<scope>/<name> (per spec §1.1)", () => {
    expect(mechanicalReverseDnsName("@nimblebraininc/echo")).toBe("dev.mpak.nimblebraininc/echo");
    expect(mechanicalReverseDnsName("@acme-corp/my-tool")).toBe("dev.mpak.acme-corp/my-tool");
  });

  test("lowercases the scope and name parts", () => {
    expect(mechanicalReverseDnsName("@FooBar/QuxQuux")).toBe("dev.mpak.foobar/quxquux");
  });

  test("non-scoped fallback puts the name under dev.mpak/", () => {
    expect(mechanicalReverseDnsName("plain-name")).toBe("dev.mpak/plain-name");
  });
});

describe("bundleToServerDetail", () => {
  function bundle(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "@nimblebraininc/echo",
      display_name: "Echo",
      description: "Echo MCP server for testing",
      latest_version: "0.1.6",
      icon: "https://static.nimblebrain.ai/icons/echo.png",
      downloads: 100,
      published_at: "2026-01-01T00:00:00Z",
      certification_level: 1,
      provenance: { schema_version: 1, provider: "github_oidc", repository: "NimbleBrainInc/mcp-echo" },
      ...over,
    };
  }

  test("projects a complete bundle to ServerDetail with mpak meta", () => {
    const detail = bundleToServerDetail(bundle());
    expect(detail).not.toBeNull();
    expect(detail?.name).toBe("dev.mpak.nimblebraininc/echo");
    expect(detail?.title).toBe("Echo");
    expect(detail?.description).toBe("Echo MCP server for testing");
    expect(detail?.version).toBe("0.1.6");
    expect(detail?.icons?.[0]?.src).toBe("https://static.nimblebrain.ai/icons/echo.png");
    expect(detail?.repository?.url).toBe("https://github.com/NimbleBrainInc/mcp-echo");
    expect(detail?.repository?.source).toBe("github");
    expect(detail?.packages?.[0]).toEqual({
      registryType: "mpak",
      identifier: "@nimblebraininc/echo",
      version: "0.1.6",
      transport: { type: "stdio" },
    });
    const mpakMeta = (detail?._meta?.["dev.mpak/registry"] ?? {}) as Record<string, unknown>;
    expect(mpakMeta.npmName).toBe("@nimblebraininc/echo");
    expect(mpakMeta.downloads).toBe(100);
    expect(mpakMeta.published_at).toBe("2026-01-01T00:00:00Z");
    expect(mpakMeta.certification).toEqual({ level: 1 });
  });

  test("falls back to title-cased unscoped name when display_name is null", () => {
    expect(bundleToServerDetail(bundle({ display_name: null }))?.title).toBe("Echo");
    expect(
      bundleToServerDetail(bundle({ name: "@x/national-parks", display_name: null }))?.title,
    ).toBe("National Parks");
  });

  test("drops icon when scheme is non-http(s) — no XSS via mpak-served icon URL", () => {
    expect(bundleToServerDetail(bundle({ icon: "javascript:alert(1)" }))?.icons).toBeUndefined();
    expect(
      bundleToServerDetail(bundle({ icon: "data:image/svg+xml;<script>alert(1)</script>" }))?.icons,
    ).toBeUndefined();
    expect(bundleToServerDetail(bundle({ icon: "file:///etc/passwd" }))?.icons).toBeUndefined();
    // http(s) icons survive.
    expect(bundleToServerDetail(bundle({ icon: "https://x.test/i.svg" }))?.icons?.[0]?.src).toBe(
      "https://x.test/i.svg",
    );
  });

  test("composed ServerDetail validates against the upstream ajv schema (carries dev.mpak/registry meta)", async () => {
    const { validateServerDetail } = await import("../../src/connectors/server-detail.ts");
    const detail = bundleToServerDetail(bundle());
    expect(detail).not.toBeNull();
    const result = validateServerDetail(detail);
    expect(result.valid).toBe(true);
    // The mpak-side enrichment block survives the ajv pass — `_meta`
    // accepts arbitrary reverse-DNS keys per spec §1.2.
    expect(detail?._meta?.["dev.mpak/registry"]).toBeDefined();
  });

  test("returns null when required fields are missing (mpak-side bug)", () => {
    expect(bundleToServerDetail({})).toBeNull();
    expect(bundleToServerDetail(bundle({ name: undefined }))).toBeNull();
    expect(bundleToServerDetail(bundle({ description: undefined }))).toBeNull();
    expect(bundleToServerDetail(bundle({ latest_version: undefined }))).toBeNull();
  });

  test("truncates descriptions over 100 chars to satisfy upstream cap", () => {
    const detail = bundleToServerDetail(bundle({ description: "x".repeat(150) }));
    expect(detail?.description.length).toBe(100);
    expect(detail?.description.endsWith("…")).toBe(true);
  });

  test("omits icons when bundle.icon is null", () => {
    const detail = bundleToServerDetail(bundle({ icon: null }));
    expect(detail?.icons).toBeUndefined();
  });
});

describe("MpakRegistry.listEntries", () => {
  const cfg: RegistryConfig = {
    id: "mpak",
    name: "mpak.dev",
    type: "mpak",
    enabled: true,
    url: "https://registry.example.test",
  };

  // Save and restore the global fetch so the mock doesn't leak across
  // tests in the same process.
  const originalFetch = globalThis.fetch;
  let fetchMock: ((input: unknown, init?: unknown) => Promise<Response>) | null = null;
  beforeEach(() => {
    fetchMock = null;
    globalThis.fetch = ((input: unknown, init?: unknown) =>
      fetchMock
        ? fetchMock(input, init)
        : Promise.reject(new Error("fetch not stubbed"))) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("projects each bundle in the search response to a DirectoryEntry", async () => {
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          bundles: [
            {
              name: "@nimblebraininc/echo",
              description: "Echo bundle",
              latest_version: "1.0.0",
              icon: "https://x.test/echo.svg",
            },
            {
              name: "@nimblebraininc/ipinfo",
              description: "IP intel",
              latest_version: "0.3.0",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const reg = new MpakRegistry(cfg);
    const entries = await reg.listEntries();
    expect(entries.length).toBe(2);
    expect(entries[0]?.id).toBe("dev.mpak.nimblebraininc/echo");
    expect(entries[0]?.install.kind).toBe("mpak-bundle");
  });

  test("throws on HTTP 5xx so the aggregator records a per-registry error", async () => {
    fetchMock = async () => new Response("nope", { status: 503 });
    const reg = new MpakRegistry(cfg);
    await expect(reg.listEntries()).rejects.toThrow(/HTTP 503/);
  });

  test("throws on network failure (signal aborted, host unreachable)", async () => {
    fetchMock = async () => {
      throw new TypeError("fetch failed");
    };
    const reg = new MpakRegistry(cfg);
    await expect(reg.listEntries()).rejects.toThrow(/mpak registry fetch failed/);
  });

  test("malformed payload (no `bundles` array) yields zero entries, no throw", async () => {
    fetchMock = async () =>
      new Response(JSON.stringify({ wrong: "shape" }), { status: 200 });
    const reg = new MpakRegistry(cfg);
    const entries = await reg.listEntries();
    expect(entries).toEqual([]);
  });

  test("drops individual entries that fail ServerDetail validation, keeps the rest", async () => {
    fetchMock = async () =>
      new Response(
        JSON.stringify({
          bundles: [
            { name: "@x/ok", description: "fine", latest_version: "1.0.0" },
            { description: "missing name" },
            { name: "@x/no-desc", latest_version: "1.0.0" },
          ],
        }),
        { status: 200 },
      );
    const reg = new MpakRegistry(cfg);
    const entries = await reg.listEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("dev.mpak.x/ok");
  });
});
