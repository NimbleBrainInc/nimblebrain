/**
 * What a persisted `ConnectorRef` resolves to at start: which transport config, and
 * whether it earns the in-cluster plain-HTTP exception.
 *
 * The `fleetInternal` derivation is a security control: `auth.type === "provider"`
 * does not mean "operator-vetted catalog entry", so only the `minted` rail earns it.
 */

import { describe, expect, it } from "bun:test";
import { resolveRefTransport } from "../../src/connectors/runtime/startup.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { validateConnectorUrl } from "../../src/connectors/runtime/url-validator.ts";

type UrlRef = Extract<ConnectorRef, { url: string }>;

const IN_CLUSTER = new URL("http://composio-session.mcp-shared.svc.cluster.local/mcp");

function ref(transport: UrlRef["transport"]): UrlRef {
  return { url: "https://composio.test/mcp", serverName: "gmail", transport } as UrlRef;
}

describe("transport: the persisted config, as written", () => {
  it("passes every shape through unchanged", () => {
    const provider = ref({
      type: "streamable-http",
      auth: { type: "provider", provider: "composio", config: {} },
    });
    const bearer = ref({ type: "streamable-http", auth: { type: "bearer", token: "t" } });
    expect(resolveRefTransport(provider).transportConfig).toBe(provider.transport);
    expect(resolveRefTransport(bearer).transportConfig).toBe(bearer.transport);
  });
});

describe("fleetInternal: only the minted rail earns the in-cluster exception", () => {
  it("grants it to a minted ref — and the URL gate then admits plain HTTP in-cluster", () => {
    const { fleetInternal } = resolveRefTransport(
      ref({ type: "streamable-http", auth: { type: "provider", provider: "minted", config: {} } }),
    );
    expect(fleetInternal).toBe(true);
    expect(() =>
      validateConnectorUrl(IN_CLUSTER, { allowInsecure: false, fleetInternal }),
    ).not.toThrow();
  });

  it("denies it to a brokered Composio ref — its URL comes from a vendor response", () => {
    // The regression this guards: keying on `auth.type === "provider"` would
    // grant the exception here, letting a hostile session URL reach an
    // in-cluster service over plain HTTP.
    const { fleetInternal } = resolveRefTransport(
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

  it("denies it to every non-provider shape", () => {
    for (const auth of [
      { type: "bearer", token: "t" },
      { type: "header", name: "x-other", value: "v" },
      { type: "none" },
    ] as const) {
      expect(resolveRefTransport(ref({ type: "streamable-http", auth })).fleetInternal).toBe(false);
    }
    expect(resolveRefTransport(ref(undefined)).fleetInternal).toBe(false);
  });
});
