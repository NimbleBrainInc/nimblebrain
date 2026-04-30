import { describe, expect, test } from "bun:test";
import { buildPlatformEnv, resolvePublicOrigin } from "../../../src/bundles/startup.ts";

describe("buildPlatformEnv", () => {
  test("sets NB_WORKSPACE_ID when wsId is provided", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      serverName: "my-server",
      manifestMeta: undefined,
      publicOrigin: "",
    });
    expect(env.NB_WORKSPACE_ID).toBe("ws_test");
  });

  test("omits NB_WORKSPACE_ID when wsId is undefined", () => {
    const env = buildPlatformEnv({
      workspaceId: undefined,
      serverName: "my-server",
      manifestMeta: undefined,
      publicOrigin: "",
    });
    expect(env.NB_WORKSPACE_ID).toBeUndefined();
  });

  test("sets NB_PROXY_PREFIX when manifest declares http-proxy and wsId is provided", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_nimblebrain_shared",
      serverName: "synapse-astro-editor",
      manifestMeta: {
        "ai.nimblebrain/http-proxy": { target: "http://127.0.0.1:4321", mount: "preview" },
      },
      publicOrigin: "",
    });
    expect(env.NB_PROXY_PREFIX).toBe(
      "/v1/ws/ws_nimblebrain_shared/apps/synapse-astro-editor/preview",
    );
  });

  test("strips leading and trailing slashes from declared mount", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      serverName: "srv",
      manifestMeta: {
        "ai.nimblebrain/http-proxy": { mount: "/preview/" },
      },
      publicOrigin: "",
    });
    expect(env.NB_PROXY_PREFIX).toBe("/v1/ws/ws_test/apps/srv/preview");
  });

  test("omits NB_PROXY_PREFIX when wsId is missing (declaration alone is not enough)", () => {
    const env = buildPlatformEnv({
      workspaceId: undefined,
      serverName: "srv",
      manifestMeta: {
        "ai.nimblebrain/http-proxy": { mount: "preview" },
      },
      publicOrigin: "",
    });
    expect(env.NB_PROXY_PREFIX).toBeUndefined();
  });

  test("omits NB_PROXY_PREFIX when manifest does not declare http-proxy", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      serverName: "srv",
      manifestMeta: { "some.other/meta": { foo: "bar" } },
      publicOrigin: "",
    });
    expect(env.NB_PROXY_PREFIX).toBeUndefined();
  });

  test("rejects mount with embedded path separators (single segment only)", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      serverName: "srv",
      manifestMeta: {
        "ai.nimblebrain/http-proxy": { mount: "preview/deep" },
      },
      publicOrigin: "",
    });
    expect(env.NB_PROXY_PREFIX).toBeUndefined();
  });

  test("sets NB_PUBLIC_ORIGIN when provided", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      serverName: "srv",
      manifestMeta: undefined,
      publicOrigin: "https://hq.platform.nimblebrain.ai",
    });
    expect(env.NB_PUBLIC_ORIGIN).toBe("https://hq.platform.nimblebrain.ai");
  });

  test("omits NB_PUBLIC_ORIGIN when publicOrigin is empty", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      serverName: "srv",
      manifestMeta: undefined,
      publicOrigin: "",
    });
    expect(env.NB_PUBLIC_ORIGIN).toBeUndefined();
  });

  // Regression: the original bug was that the registry spawn path in
  // startup.ts did not call this helper, so registry-installed bundles
  // (synapse-astro-editor in tenant-hq, ws_nimblebrain_shared) silently
  // never received NB_PROXY_PREFIX. The UI showed "No preview URL — check
  // that the http-proxy declaration is wired" even though the manifest
  // was correct. Both spawn paths now call buildPlatformEnv with the
  // bundle's _meta; this test pins the produced contract for that scenario.
  test("regression: full contract for a registry bundle declaring http-proxy", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_nimblebrain_shared",
      serverName: "synapse-astro-editor",
      manifestMeta: {
        "ai.nimblebrain/http-proxy": {
          target: "http://127.0.0.1:4321",
          mount: "preview",
          websocket: true,
        },
      },
      publicOrigin: "https://hq.platform.nimblebrain.ai",
    });
    expect(env).toEqual({
      NB_WORKSPACE_ID: "ws_nimblebrain_shared",
      NB_PROXY_PREFIX: "/v1/ws/ws_nimblebrain_shared/apps/synapse-astro-editor/preview",
      NB_PUBLIC_ORIGIN: "https://hq.platform.nimblebrain.ai",
    });
  });
});

describe("resolvePublicOrigin", () => {
  test("prefers NB_PUBLIC_ORIGIN", () => {
    const env = { NB_PUBLIC_ORIGIN: "https://primary.example", ALLOWED_ORIGINS: "https://b.example" };
    expect(resolvePublicOrigin(env)).toBe("https://primary.example");
  });

  test("falls back to first entry of ALLOWED_ORIGINS", () => {
    const env = { ALLOWED_ORIGINS: "https://a.example,https://b.example" };
    expect(resolvePublicOrigin(env)).toBe("https://a.example");
  });

  test("trims whitespace around ALLOWED_ORIGINS entry", () => {
    const env = { ALLOWED_ORIGINS: "  https://a.example  ,https://b.example" };
    expect(resolvePublicOrigin(env)).toBe("https://a.example");
  });

  test("returns empty string when neither is set", () => {
    expect(resolvePublicOrigin({})).toBe("");
  });
});
