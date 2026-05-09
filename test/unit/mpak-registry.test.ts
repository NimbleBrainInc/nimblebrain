import { describe, expect, test } from "bun:test";
import {
  bundleToServerDetail,
  mechanicalReverseDnsName,
} from "../../src/registries/mpak-registry.ts";

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

  test("falls back to unscoped name when display_name is null", () => {
    const detail = bundleToServerDetail(bundle({ display_name: null }));
    expect(detail?.title).toBe("echo");
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
