import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { workspaceConnectorsUrl } from "../../../src/api/routes/connectors-redirect.ts";

describe("workspaceConnectorsUrl", () => {
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

  it("builds the workspace-scoped connectors path, stripping the ws_ prefix", () => {
    // The whole point: connectors live at `/w/<slug>/settings/connectors`, NOT
    // the pre-scoping `/settings/workspace/connectors`. Slug = wsId minus `ws_`.
    process.env.NB_WEB_URL = "https://app.example.com";
    expect(workspaceConnectorsUrl("ws_acme")).toBe(
      "https://app.example.com/w/acme/settings/connectors",
    );
  });

  it("uses webOrigin: NB_WEB_URL wins over the derived/legacy origin", () => {
    // No NB_WEB_URL → webOrigin() falls through to publicOrigin() (legacy NB_API_URL here).
    process.env.NB_API_URL = "https://api.example.com";
    expect(workspaceConnectorsUrl("ws_x")).toBe("https://api.example.com/w/x/settings/connectors");
    // NB_WEB_URL set → the user-facing SPA origin wins (the dev API/SPA-port split).
    process.env.NB_WEB_URL = "https://web.example.com";
    expect(workspaceConnectorsUrl("ws_x")).toBe("https://web.example.com/w/x/settings/connectors");
  });

  it("returns the custom domain when it is the canonical origin", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    expect(workspaceConnectorsUrl("ws_x")).toBe("https://brain.acme.com/w/x/settings/connectors");
  });

  it("falls back to the localhost dev origin when nothing is configured", () => {
    expect(workspaceConnectorsUrl("ws_x")).toBe("http://localhost:27247/w/x/settings/connectors");
  });

  it("trims a trailing slash on the base so the path isn't doubled", () => {
    process.env.NB_WEB_URL = "https://app.example.com/";
    expect(workspaceConnectorsUrl("ws_x")).toBe("https://app.example.com/w/x/settings/connectors");
  });

  it("throws (fail-closed) on a tampered non-http(s) web origin", () => {
    // A `javascript:`/`data:` NB_WEB_URL must never reach the meta-refresh. The
    // origin seam asserts http(s) and throws at the boundary rather than degrade.
    process.env.NB_WEB_URL = "javascript:alert(1)";
    expect(() => workspaceConnectorsUrl("ws_acme")).toThrow();
  });
});
