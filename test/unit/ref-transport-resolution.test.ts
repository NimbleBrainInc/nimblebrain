/**
 * What a persisted `ConnectorRef` resolves to at start: which transport config, and
 * whether it earns the in-cluster plain-HTTP exception.
 *
 * The `fleetInternal` derivation is a security control: `auth.type === "provider"`
 * does not mean "operator-vetted catalog entry", so only the `minted` rail earns it.
 */

import { describe, expect, it } from "bun:test";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import {
  FleetConnectorUnavailableError,
  resolveRefTransport,
} from "../../src/connectors/runtime/startup.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { validateConnectorUrl } from "../../src/connectors/runtime/url-validator.ts";

type UrlRef = Extract<ConnectorRef, { url: string }>;

const IN_CLUSTER = new URL("http://composio-session.mcp-shared.svc.cluster.local/mcp");

function ref(transport: UrlRef["transport"]): UrlRef {
  return { url: "https://composio.test/mcp", serverName: "gmail", transport } as UrlRef;
}

const FLEET_ID = "ai.example.alpha/mcp";
const FLEET_URL = "http://mcp-alpha.fleet.svc.cluster.local/mcp";

function mintedEntry(audience = "mcp-alpha"): ConnectorCatalogEntry {
  return {
    id: FLEET_ID,
    name: "Alpha",
    description: "",
    url: FLEET_URL,
    auth: "provider",
    providerAuth: { provider: "minted", config: { audience, scope: "mcp:invoke" } },
  };
}

function mintedRef(storedAudience: string): UrlRef {
  return {
    url: FLEET_URL,
    serverName: slugifyServerName(FLEET_ID),
    transport: {
      type: "streamable-http",
      auth: {
        type: "provider",
        provider: "minted",
        config: { audience: storedAudience, scope: "mcp:invoke" },
      },
    },
  } as UrlRef;
}

describe("transport: a minted ref's credential settings come from the catalog", () => {
  it("starts with the catalog entry's audience, not the one its install stored", async () => {
    const { transportConfig, fleetInternal } = await resolveRefTransport(
      mintedRef("shared-audience"),
      async () => [mintedEntry("mcp-alpha")],
    );
    expect(transportConfig?.auth).toEqual({
      type: "provider",
      provider: "minted",
      config: { audience: "mcp-alpha", scope: "mcp:invoke" },
    });
    expect(fleetInternal).toBe(true);
  });

  it("refuses to start a minted ref without the catalog, so no caller can skip it", async () => {
    await expect(resolveRefTransport(mintedRef("shared-audience"))).rejects.toThrow(
      /without the connector catalog/,
    );
  });

  it("does not start a minted ref the catalog no longer offers", async () => {
    const err = await resolveRefTransport(mintedRef("shared-audience"), async () => []).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FleetConnectorUnavailableError);
    expect((err as Error).message).toContain("not offered in this deployment's connector catalog");
  });

  it("fails closed when the catalog cannot be read", async () => {
    await expect(
      resolveRefTransport(mintedRef("shared-audience"), async () => {
        throw new Error("catalog mount missing");
      }),
    ).rejects.toBeInstanceOf(FleetConnectorUnavailableError);
  });

  it("never reads the catalog for any other connector", async () => {
    let reads = 0;
    await resolveRefTransport(
      ref({ type: "streamable-http", auth: { type: "none" } }),
      async () => {
        reads += 1;
        return [];
      },
    );
    expect(reads).toBe(0);
  });
});

describe("transport: the persisted config, as written, for every non-minted ref", () => {
  it("passes every shape through unchanged", async () => {
    const provider = ref({
      type: "streamable-http",
      auth: { type: "provider", provider: "composio", config: {} },
    });
    const bearer = ref({ type: "streamable-http", auth: { type: "bearer", token: "t" } });
    expect((await resolveRefTransport(provider)).transportConfig).toBe(provider.transport);
    expect((await resolveRefTransport(bearer)).transportConfig).toBe(bearer.transport);
  });
});

describe("fleetInternal: only the minted rail earns the in-cluster exception", () => {
  it("grants it to a minted ref — and the URL gate then admits plain HTTP in-cluster", async () => {
    const { fleetInternal } = await resolveRefTransport(mintedRef("stale"), async () => [
      mintedEntry(),
    ]);
    expect(fleetInternal).toBe(true);
    expect(() =>
      validateConnectorUrl(IN_CLUSTER, { allowInsecure: false, fleetInternal }),
    ).not.toThrow();
  });

  it("denies it to a brokered Composio ref — its URL comes from a vendor response", async () => {
    // The regression this guards: keying on `auth.type === "provider"` would
    // grant the exception here, letting a hostile session URL reach an
    // in-cluster service over plain HTTP.
    const { fleetInternal } = await resolveRefTransport(
      ref({
        type: "streamable-http",
        auth: { type: "provider", provider: "composio", config: {} },
      }),
    );
    expect(fleetInternal).toBe(false);
    expect(() =>
      validateConnectorUrl(IN_CLUSTER, { allowInsecure: false, fleetInternal }),
    ).toThrow();
  });

  it("denies it to every non-provider shape", async () => {
    for (const auth of [
      { type: "bearer", token: "t" },
      { type: "header", name: "x-other", value: "v" },
      { type: "none" },
    ] as const) {
      expect(
        (await resolveRefTransport(ref({ type: "streamable-http", auth }))).fleetInternal,
      ).toBe(false);
    }
    expect((await resolveRefTransport(ref(undefined))).fleetInternal).toBe(false);
  });
});
