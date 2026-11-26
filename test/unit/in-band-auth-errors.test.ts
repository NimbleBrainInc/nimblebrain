import { afterEach, describe, expect, it } from "bun:test";
import {
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import {
  catalogTransportOptions,
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

describe("an OAuth-only connection requires a credential", () => {
  const URL_ = "https://mcp.example.com/mcp";
  const entry = (fields: Partial<ConnectorCatalogEntry>): ConnectorCatalogEntry => ({
    id: "com.example/mcp",
    name: "Example",
    description: "",
    url: URL_,
    auth: "dcr",
    ...fields,
  });
  const ref = (fields: Partial<ConnectorRef> = {}): ConnectorRef => ({
    url: URL_,
    serverName: "com-example-mcp",
    ...fields,
  });
  const requires = async (r: ConnectorRef, entries: ConnectorCatalogEntry[] = []) => {
    setInBandAuthErrorsCatalog(async () => entries);
    return (await catalogTransportOptions(r)).requireCredential === true;
  };
  const oauthClient = { clientId: "client-1" };
  const declaredStatic = entry({ auth: "static", authDeclared: true });

  afterEach(() => setInBandAuthErrorsCatalog(null));

  it("test_require_credential_for_a_ref_naming_its_own_oauth_client", async () => {
    expect(await requires(ref({ oauthClient }))).toBe(true);
  });

  it("test_require_credential_for_an_entry_declaring_static_auth", async () => {
    expect(await requires(ref(), [declaredStatic])).toBe(true);
  });

  it("test_require_credential_for_an_entry_declaring_dcr_auth", async () => {
    expect(await requires(ref(), [entry({ auth: "dcr", authDeclared: true })])).toBe(true);
  });

  it("test_no_credential_required_for_an_entry_whose_auth_is_the_default", async () => {
    expect(await requires(ref(), [entry({ auth: "dcr" })])).toBe(false);
  });

  it("test_no_credential_required_for_an_entry_binding_secret_headers", async () => {
    const secretHeaders = { "X-Api-Key": { ref: "credential" as const, key: "example_key" } };
    expect(await requires(ref(), [{ ...declaredStatic, secretHeaders }])).toBe(false);
  });

  it("test_no_credential_required_for_an_uncatalogued_or_mismatched_url", async () => {
    expect(await requires(ref({ serverName: "elsewhere" }), [declaredStatic])).toBe(false);
    expect(await requires(ref({ url: "https://other.example.net/mcp" }), [declaredStatic])).toBe(
      false,
    );
  });

  it("test_no_credential_required_with_static_transport_auth_or_headers", async () => {
    const headers = { transport: { headers: { "X-Key": "k" } } };
    const auth = { transport: { auth: { type: "none" as const } } };
    expect(await requires(ref({ oauthClient, ...headers }), [declaredStatic])).toBe(false);
    expect(await requires(ref({ oauthClient, ...auth }), [declaredStatic])).toBe(false);
  });

  it("test_auth_declared_projects_only_when_the_meta_names_auth", () => {
    const detail = (meta: Record<string, unknown>): ServerDetail =>
      ({
        name: "com.example/mcp",
        description: "",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: URL_ }],
        _meta: { "ai.nimblebrain/connector": meta },
      }) as ServerDetail;
    expect(serverDetailToCatalogEntry(detail({ auth: "dcr" }))?.authDeclared).toBe(true);
    expect(serverDetailToCatalogEntry(detail({}))?.authDeclared).toBeUndefined();
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
