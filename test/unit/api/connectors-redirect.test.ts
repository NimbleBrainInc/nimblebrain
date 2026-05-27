import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { workspaceConnectorsUrl } from "../../../src/api/routes/connectors-redirect.ts";

describe("workspaceConnectorsUrl", () => {
  const savedWeb = process.env.NB_WEB_URL;
  const savedApi = process.env.NB_API_URL;

  beforeEach(() => {
    delete process.env.NB_WEB_URL;
    delete process.env.NB_API_URL;
  });

  afterEach(() => {
    if (savedWeb === undefined) delete process.env.NB_WEB_URL;
    else process.env.NB_WEB_URL = savedWeb;
    if (savedApi === undefined) delete process.env.NB_API_URL;
    else process.env.NB_API_URL = savedApi;
  });

  it("builds the workspace-scoped connectors path, stripping the ws_ prefix", () => {
    // The whole point of this fix: connectors live at
    // `/w/<slug>/settings/connectors`, NOT the pre-scoping
    // `/settings/workspace/connectors`. Slug = wsId minus `ws_`.
    process.env.NB_WEB_URL = "https://app.example.com";
    expect(workspaceConnectorsUrl("ws_acme", "http://ignored/")).toBe(
      "https://app.example.com/w/acme/settings/connectors",
    );
  });

  it("prefers NB_WEB_URL over NB_API_URL over the request origin", () => {
    process.env.NB_API_URL = "https://api.example.com";
    // No NB_WEB_URL → falls through to NB_API_URL.
    expect(workspaceConnectorsUrl("ws_x", "http://origin.test/cb")).toBe(
      "https://api.example.com/w/x/settings/connectors",
    );
    process.env.NB_WEB_URL = "https://web.example.com";
    expect(workspaceConnectorsUrl("ws_x", "http://origin.test/cb")).toBe(
      "https://web.example.com/w/x/settings/connectors",
    );
  });

  it("falls back to the request origin when no env base is set", () => {
    expect(workspaceConnectorsUrl("ws_x", "http://localhost:27247/v1/mcp-auth/callback")).toBe(
      "http://localhost:27247/w/x/settings/connectors",
    );
  });

  it("trims a trailing slash on the base so the path isn't doubled", () => {
    process.env.NB_WEB_URL = "https://app.example.com/";
    expect(workspaceConnectorsUrl("ws_x", "http://ignored/")).toBe(
      "https://app.example.com/w/x/settings/connectors",
    );
  });

  it("returns a same-origin relative path when the base has a non-http(s) scheme", () => {
    // Defense-in-depth: a tampered NB_WEB_URL with a javascript:/data: scheme
    // must never survive into the meta-refresh. Degrade to a relative path.
    process.env.NB_WEB_URL = "javascript:alert(1)";
    expect(workspaceConnectorsUrl("ws_acme", "http://ignored/")).toBe(
      "/w/acme/settings/connectors",
    );
  });

  it("returns a relative path when there is no resolvable base at all", () => {
    // No env, unparseable request URL → no origin. The absolute string is
    // already relative, so URL parsing throws and we return the path.
    expect(workspaceConnectorsUrl("ws_acme", "not a url")).toBe("/w/acme/settings/connectors");
  });
});
