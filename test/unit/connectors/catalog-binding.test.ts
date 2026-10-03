import { describe, expect, it } from "bun:test";
import { bindCatalogEntry, sameRemoteUrl } from "../../../src/connectors/catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import { slugifyServerName } from "../../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";

/**
 * A catalog entry's grants apply to an installed ref only when the ref IS the
 * entry's server: its name and its URL, or for a brokered ref its name and the
 * provider and catalog id the broker stamped.
 */

const ID = "ai.example/crm";
const SN = slugifyServerName(ID);
const URL_ = "https://crm.example.test/mcp";

function entry(over: Partial<ConnectorCatalogEntry> = {}): ConnectorCatalogEntry {
  return { id: ID, name: "CRM", description: "", url: URL_, auth: "dcr", ...over };
}

describe("bindCatalogEntry", () => {
  it("binds a ref at the entry's URL", () => {
    const e = entry();
    expect(bindCatalogEntry({ url: URL_, serverName: SN }, [e])).toEqual({
      kind: "bound",
      entry: e,
    });
  });

  it("refuses a ref with the entry's name at another URL", () => {
    const e = entry();
    expect(bindCatalogEntry({ url: "https://other.test/mcp", serverName: SN }, [e])).toEqual({
      kind: "mismatch",
      entry: e,
    });
  });

  it("refuses a ref whose name is derived from a foreign URL's last segment", () => {
    // No `serverName`: the legacy fallback derives one from the URL path.
    const ref: ConnectorRef = { url: `https://other.test/${SN}` };
    expect(bindCatalogEntry(ref, [entry()]).kind).toBe("mismatch");
  });

  it("names nothing for a ref no entry carries the name of", () => {
    expect(bindCatalogEntry({ url: URL_, serverName: "elsewhere" }, [entry()])).toEqual({
      kind: "uncatalogued",
    });
  });

  it("binds a brokered ref by the provider and catalog id its broker stamped", () => {
    const e = entry({ auth: "composio" });
    const ref: ConnectorRef = {
      url: "https://broker.test/session/123",
      serverName: SN,
      brokered: { provider: "composio", connectorId: ID },
    };
    expect(bindCatalogEntry(ref, [e]).kind).toBe("bound");
  });

  it("refuses a brokered ref stamped with another provider or another id", () => {
    const e = entry({ auth: "composio" });
    const base = { url: "https://broker.test/session/123", serverName: SN };
    expect(
      bindCatalogEntry({ ...base, brokered: { provider: "smithery", connectorId: ID } }, [e]).kind,
    ).toBe("mismatch");
    expect(
      bindCatalogEntry({ ...base, brokered: { provider: "composio", connectorId: "a/b" } }, [e])
        .kind,
    ).toBe("mismatch");
  });

  it("refuses a brokered ref against a runtime-native entry, even at the entry's URL", () => {
    const ref: ConnectorRef = {
      url: URL_,
      serverName: SN,
      brokered: { provider: "composio", connectorId: ID },
    };
    expect(bindCatalogEntry(ref, [entry()]).kind).toBe("mismatch");
  });
});

describe("sameRemoteUrl", () => {
  it("ignores scheme and host case, one trailing slash, and the default port", () => {
    expect(sameRemoteUrl("HTTPS://CRM.Example.TEST/mcp/", URL_)).toBe(true);
    expect(sameRemoteUrl("https://crm.example.test:443/mcp", URL_)).toBe(true);
    expect(sameRemoteUrl("https://crm.example.test", "https://crm.example.test/")).toBe(true);
  });

  it("tells apart path case, another port, another scheme, and a query", () => {
    expect(sameRemoteUrl("https://crm.example.test/MCP", URL_)).toBe(false);
    expect(sameRemoteUrl("https://crm.example.test:8443/mcp", URL_)).toBe(false);
    expect(sameRemoteUrl("http://crm.example.test/mcp", URL_)).toBe(false);
    expect(sameRemoteUrl(`${URL_}?tenant=a`, URL_)).toBe(false);
  });

  it("matches nothing it cannot parse", () => {
    expect(sameRemoteUrl("not a url", "not a url")).toBe(false);
    expect(sameRemoteUrl(undefined, undefined)).toBe(false);
  });
});
