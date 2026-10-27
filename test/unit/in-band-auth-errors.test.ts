import { afterEach, describe, expect, it } from "bun:test";
import {
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import {
  inBandAuthErrorsFor,
  setInBandAuthErrorsCatalog,
} from "../../src/connectors/runtime/in-band-auth-errors.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";

/**
 * A catalog entry's `inBandAuthErrors` reaches only the connections that are
 * that entry's server, and the catalog check refuses wording too short to be
 * the server's own. What the transport does with it:
 * `test/integration/mcp-source-in-band-auth.test.ts`.
 */

const PHRASE = "authentication token has expired or is invalid";

describe("in-band auth errors bind from the catalog entry the ref is", () => {
  const entry: ConnectorCatalogEntry = {
    id: "com.example/mcp",
    name: "Example",
    description: "",
    url: "https://mcp.example.com/mcp",
    auth: "static",
    inBandAuthErrors: [PHRASE],
  };
  const ref = (url: string): ConnectorRef => ({ url, serverName: "com-example-mcp" });

  afterEach(() => setInBandAuthErrorsCatalog(null));

  it("test_in_band_auth_errors_reach_a_ref_bound_to_the_entry", async () => {
    setInBandAuthErrorsCatalog(async () => [entry]);
    expect(await inBandAuthErrorsFor(ref("https://mcp.example.com/mcp"))).toEqual([PHRASE]);
  });

  it("test_in_band_auth_errors_never_reach_another_server_under_the_name", async () => {
    setInBandAuthErrorsCatalog(async () => [entry]);
    expect(await inBandAuthErrorsFor(ref("https://evil.example.net/mcp"))).toBeUndefined();
  });

  it("test_in_band_auth_errors_unset_catalog_reaches_nothing", async () => {
    expect(await inBandAuthErrorsFor(ref("https://mcp.example.com/mcp"))).toBeUndefined();
  });
});

describe("catalog entries declare in-band auth errors", () => {
  const detail = (inBandAuthErrors: unknown): ServerDetail =>
    ({
      name: "com.example/mcp",
      description: "",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
      _meta: { "ai.nimblebrain/connector": { inBandAuthErrors } },
    }) as ServerDetail;

  it("test_in_band_auth_errors_project_onto_the_catalog_entry", () => {
    expect(validateServerDetailSafety(detail([PHRASE]))).toBeNull();
    expect(serverDetailToCatalogEntry(detail([PHRASE]))?.inBandAuthErrors).toEqual([PHRASE]);
  });

  it("test_in_band_auth_errors_short_fragment_drops_the_entry", () => {
    expect(validateServerDetailSafety(detail(["token"]))).toMatch(/inBandAuthErrors/);
  });

  it("test_in_band_auth_errors_not_a_list_drops_the_entry", () => {
    expect(validateServerDetailSafety(detail(PHRASE))).toMatch(/inBandAuthErrors/);
  });
});
