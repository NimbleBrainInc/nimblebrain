import { describe, expect, test } from "bun:test";
import { buildPlatformEnv, resolvePublicOrigin } from "../../../src/bundles/startup.ts";

describe("buildPlatformEnv", () => {
  test("sets NB_WORKSPACE_ID when wsId is provided", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      publicOrigin: "",
    });
    expect(env.NB_WORKSPACE_ID).toBe("ws_test");
  });

  test("omits NB_WORKSPACE_ID when wsId is undefined", () => {
    const env = buildPlatformEnv({
      workspaceId: undefined,
      publicOrigin: "",
    });
    expect(env.NB_WORKSPACE_ID).toBeUndefined();
  });

  test("sets NB_PUBLIC_ORIGIN when provided", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      publicOrigin: "https://hq.platform.nimblebrain.ai",
    });
    expect(env.NB_PUBLIC_ORIGIN).toBe("https://hq.platform.nimblebrain.ai");
  });

  test("omits NB_PUBLIC_ORIGIN when publicOrigin is empty", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_test",
      publicOrigin: "",
    });
    expect(env.NB_PUBLIC_ORIGIN).toBeUndefined();
  });

  test("full contract: both NB_WORKSPACE_ID and NB_PUBLIC_ORIGIN", () => {
    const env = buildPlatformEnv({
      workspaceId: "ws_nimblebrain_shared",
      publicOrigin: "https://hq.platform.nimblebrain.ai",
    });
    expect(env).toEqual({
      NB_WORKSPACE_ID: "ws_nimblebrain_shared",
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
