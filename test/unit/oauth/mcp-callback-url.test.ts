import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetBouncerModeForTest } from "../../../src/oauth/bouncer-config.ts";
import { mcpAuthCallbackUrl } from "../../../src/oauth/mcp-callback-url.ts";

// The single source of truth for the OAuth redirect_uri. Every provider
// path (initiate, boot-start, revocation) resolves through this, so the
// DCR drift check never fires on our own inconsistency. These cases pin
// that contract: bouncer mode wins; otherwise NB_API_URL; otherwise the
// localhost dev default.
const ENV_KEYS = [
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
  "NB_TENANT_ID",
  "NB_API_URL",
] as const;

describe("mcpAuthCallbackUrl — single callback-URL authority", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    _resetBouncerModeForTest();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetBouncerModeForTest();
  });

  it("returns the bouncer callback when bouncer mode is enabled (its presence is the mode signal)", () => {
    const bouncerCallback = "https://connect.nimblebrain.ai/v1/mcp-auth/callback";
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = bouncerCallback;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = randomBytes(32).toString("base64");
    process.env.NB_TENANT_ID = "tenant-a";
    // Even with a tenant-direct NB_API_URL set, bouncer wins — this is the
    // exact prod config where boot-start used to diverge onto NB_API_URL.
    process.env.NB_API_URL = "https://hq.platform.nimblebrain.ai";
    _resetBouncerModeForTest();

    expect(mcpAuthCallbackUrl()).toBe(bouncerCallback);
  });

  it("falls back to NB_API_URL when not in bouncer mode", () => {
    process.env.NB_API_URL = "https://hq.platform.nimblebrain.ai";
    expect(mcpAuthCallbackUrl()).toBe("https://hq.platform.nimblebrain.ai/v1/mcp-auth/callback");
  });

  it("trims a trailing slash on NB_API_URL so the path isn't doubled", () => {
    process.env.NB_API_URL = "https://hq.platform.nimblebrain.ai/";
    expect(mcpAuthCallbackUrl()).toBe("https://hq.platform.nimblebrain.ai/v1/mcp-auth/callback");
  });

  it("defaults to the localhost dev callback when neither bouncer nor NB_API_URL is set", () => {
    expect(mcpAuthCallbackUrl()).toBe("http://localhost:27247/v1/mcp-auth/callback");
  });
});
