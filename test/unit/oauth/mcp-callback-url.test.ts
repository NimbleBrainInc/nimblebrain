import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { _resetBouncerModeForTest } from "../../../src/oauth/bouncer-config.ts";
import { mcpAuthCallbackUrl } from "../../../src/oauth/mcp-callback-url.ts";

// The single source of truth for the OAuth redirect_uri. Every provider
// path (initiate, boot-start, revocation) resolves through this. These cases
// pin that contract: bouncer mode wins; otherwise the tenant public origin
// (`publicOrigin()`, derived from the host facts); otherwise the localhost
// dev default.
const ENV_KEYS = [
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
  "NB_TENANT_ID",
  "NB_PUBLIC_ORIGIN",
  "NB_PLATFORM_HOST",
  "NB_CUSTOM_DOMAIN",
  "NB_CUSTOM_DOMAIN_CANONICAL",
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
    const bouncerCallback = "https://connect.example.com/v1/mcp-auth/callback";
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = bouncerCallback;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = randomBytes(32).toString("base64");
    process.env.NB_TENANT_ID = "tenant-a";
    // Even with a tenant-direct public origin set, bouncer wins — this is the
    // exact prod config where boot-start used to diverge onto the tenant host.
    process.env.NB_PLATFORM_HOST = "nb.example.com";
    _resetBouncerModeForTest();

    expect(mcpAuthCallbackUrl()).toBe(bouncerCallback);
  });

  it("falls back to the tenant public origin when not in bouncer mode", () => {
    process.env.NB_PLATFORM_HOST = "nb.example.com";
    expect(mcpAuthCallbackUrl()).toBe("https://nb.example.com/v1/mcp-auth/callback");
  });

  it("derives from the custom domain when canonical, even outside bouncer mode", () => {
    process.env.NB_PLATFORM_HOST = "nb.example.com";
    process.env.NB_CUSTOM_DOMAIN = "brain.tenant-a.com";
    expect(mcpAuthCallbackUrl()).toBe("https://brain.tenant-a.com/v1/mcp-auth/callback");
  });

  it("defaults to the localhost dev callback when neither bouncer nor host facts are set", () => {
    expect(mcpAuthCallbackUrl()).toBe("http://localhost:27247/v1/mcp-auth/callback");
  });
});
