import { describe, expect, it } from "bun:test";
import {
  MINTED_UNAVAILABLE_REASON,
  resolveMintedTransport,
} from "../../../src/connectors/catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import { slugifyServerName } from "../../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";

/**
 * A minted fleet connector's credential settings are a catalog grant: they come
 * from the entry the installed ref binds to at every start, never from the copy
 * the install stored, and a ref the catalog no longer offers has none.
 */

const ID = "ai.example.alpha/mcp";
const SN = slugifyServerName(ID);
const URL_ = "http://mcp-alpha.fleet.svc.cluster.local/mcp";

function entry(over: Partial<ConnectorCatalogEntry> = {}): ConnectorCatalogEntry {
  return {
    id: ID,
    name: "Alpha",
    description: "",
    url: URL_,
    auth: "provider",
    providerAuth: { provider: "minted", config: { audience: "mcp-alpha", scope: "mcp:invoke" } },
    ...over,
  };
}

/** An install as it was stored: the shared audience, plus a workspace secret header. */
function installed(over: Partial<ConnectorRef> = {}): ConnectorRef {
  return {
    url: URL_,
    serverName: SN,
    transport: {
      type: "streamable-http",
      auth: {
        type: "provider",
        provider: "minted",
        config: { audience: "shared-audience", scope: "mcp:invoke" },
      },
      headers: { "x-alpha-key": { ref: "credential", key: "alpha-key" } },
    },
    ...over,
  } as ConnectorRef;
}

describe("resolveMintedTransport", () => {
  it("takes the credential settings from the bound catalog entry, not the stored copy", () => {
    const result = resolveMintedTransport(installed(), [entry()]);
    expect(result).toEqual({
      kind: "ok",
      transport: {
        type: "streamable-http",
        auth: {
          type: "provider",
          provider: "minted",
          config: { audience: "mcp-alpha", scope: "mcp:invoke" },
        },
        // The workspace's own secret header is the install's choice and stays.
        headers: { "x-alpha-key": { ref: "credential", key: "alpha-key" } },
      },
    });
  });

  it("follows a catalog edit to an existing install", () => {
    const edited = entry({
      providerAuth: { provider: "minted", config: { audience: "mcp-alpha-v2", scope: "read" } },
    });
    const result = resolveMintedTransport(installed(), [edited]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.transport?.auth).toEqual({
      type: "provider",
      provider: "minted",
      config: { audience: "mcp-alpha-v2", scope: "read" },
    });
  });

  it("does not let the result share the catalog entry's config object", () => {
    const e = entry();
    const result = resolveMintedTransport(installed(), [e]);
    if (result.kind !== "ok" || result.transport?.auth?.type !== "provider") {
      throw new Error("expected a provider transport");
    }
    expect(result.transport.auth.config).not.toBe(e.providerAuth?.config);
  });

  it("is unavailable when no entry carries the connector's name", () => {
    expect(resolveMintedTransport(installed(), [entry({ id: "ai.example.beta/mcp" })])).toEqual({
      kind: "unavailable",
      reason: MINTED_UNAVAILABLE_REASON,
    });
  });

  it("is unavailable when the entry by that name is at another URL", () => {
    const moved = entry({ url: "http://mcp-other.fleet.svc.cluster.local/mcp" });
    expect(resolveMintedTransport(installed(), [moved]).kind).toBe("unavailable");
  });

  it("is unavailable when the bound entry no longer grants minted auth", () => {
    expect(resolveMintedTransport(installed(), [entry({ auth: "dcr" })]).kind).toBe("unavailable");
    expect(resolveMintedTransport(installed(), [entry({ providerAuth: undefined })]).kind).toBe(
      "unavailable",
    );
    expect(
      resolveMintedTransport(installed(), [
        entry({ providerAuth: { provider: "other", config: {} } }),
      ]).kind,
    ).toBe("unavailable");
  });

  it("is unavailable when the catalog could not be read, never falling back to the stored copy", () => {
    expect(resolveMintedTransport(installed(), null)).toEqual({
      kind: "unavailable",
      reason: MINTED_UNAVAILABLE_REASON,
    });
  });

  it("returns any other connector's transport unchanged, whatever the catalog holds", () => {
    const bearer = installed({
      transport: { type: "streamable-http", auth: { type: "bearer", token: "t" } },
    });
    const brokered = installed({
      transport: {
        type: "streamable-http",
        auth: { type: "provider", provider: "composio", config: {} },
      },
    });
    for (const ref of [bearer, brokered, installed({ transport: undefined })]) {
      const result = resolveMintedTransport(ref, null);
      expect(result).toEqual({ kind: "ok", transport: ref.transport });
      if (result.kind === "ok") expect(result.transport).toBe(ref.transport);
    }
  });
});
