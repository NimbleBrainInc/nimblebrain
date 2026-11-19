import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connectorReturnUrl } from "../../../src/api/routes/connectors-redirect.ts";

describe("connectorReturnUrl", () => {
  const ENV_KEYS = [
    "NB_WEB_URL",
    "NB_API_URL",
    "NB_CUSTOM_DOMAIN",
    "NB_PLATFORM_HOST",
    "NB_CUSTOM_DOMAIN_CANONICAL",
    "NB_PUBLIC_ORIGIN",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns to the workspace's Plugins page, stripping the ws_ prefix", () => {
    process.env.NB_WEB_URL = "https://app.example.com";
    expect(connectorReturnUrl("ws_000f7ed6658f9d30")).toBe(
      "https://app.example.com/w/000f7ed6658f9d30/plugins",
    );
  });

  it("returns to the profile's connectors when no workspace is named", () => {
    process.env.NB_WEB_URL = "https://app.example.com";
    expect(connectorReturnUrl(undefined)).toBe("https://app.example.com/profile/connectors");
  });

  it("names the connected server, encoded, and whose it is, so the page can confirm it", () => {
    process.env.NB_WEB_URL = "https://app.example.com";
    expect(
      connectorReturnUrl("ws_000f7ed6658f9d30", {
        serverName: "com-acme/notes",
        owner: "workspace",
      }),
    ).toBe(
      "https://app.example.com/w/000f7ed6658f9d30/plugins?connected=com-acme%2Fnotes&owner=workspace",
    );
    expect(connectorReturnUrl(undefined, { serverName: "granola", owner: "person" })).toBe(
      "https://app.example.com/profile/connectors?connected=granola&owner=person",
    );
  });

  it("uses webOrigin: NB_WEB_URL wins over the derived/legacy origin", () => {
    // No NB_WEB_URL → webOrigin() falls through to publicOrigin() (derived host).
    process.env.NB_PLATFORM_HOST = "api.example.com";
    expect(connectorReturnUrl("ws_008bd230f095f38a")).toBe(
      "https://api.example.com/w/008bd230f095f38a/plugins",
    );
    // NB_WEB_URL set → the user-facing SPA origin wins (the dev API/SPA-port split).
    process.env.NB_WEB_URL = "https://web.example.com";
    expect(connectorReturnUrl("ws_008bd230f095f38a")).toBe(
      "https://web.example.com/w/008bd230f095f38a/plugins",
    );
  });

  it("returns the custom domain when it is the canonical origin", () => {
    process.env.NB_PLATFORM_HOST = "acme.nb.example.com";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    expect(connectorReturnUrl("ws_008bd230f095f38a")).toBe(
      "https://brain.acme.com/w/008bd230f095f38a/plugins",
    );
  });

  it("falls back to the localhost dev origin when nothing is configured", () => {
    expect(connectorReturnUrl("ws_008bd230f095f38a")).toBe(
      "http://localhost:27247/w/008bd230f095f38a/plugins",
    );
  });

  it("trims a trailing slash on the base so the path isn't doubled", () => {
    process.env.NB_WEB_URL = "https://app.example.com/";
    expect(connectorReturnUrl("ws_008bd230f095f38a")).toBe(
      "https://app.example.com/w/008bd230f095f38a/plugins",
    );
  });

  it("throws (fail-closed) on a tampered non-http(s) web origin", () => {
    // A `javascript:`/`data:` NB_WEB_URL must never reach the redirect. The
    // origin seam asserts http(s) and throws at the boundary rather than degrade.
    process.env.NB_WEB_URL = "javascript:alert(1)";
    expect(() => connectorReturnUrl("ws_000f7ed6658f9d30")).toThrow();
  });
});
