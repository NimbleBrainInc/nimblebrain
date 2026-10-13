import { describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { ConnectorLifecycleManager } from "../../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";

// Disconnect revokes a credential a person authorized, so it can be redone. Whether a
// connection has one is decided here, once, for the web menu and the disconnect tool.

const URL = "https://mcp.example.test/mcp";
type TransportAuth = NonNullable<NonNullable<ConnectorRef["transport"]>["auth"]>;
const ref = (over: Partial<ConnectorRef> = {}): ConnectorRef => ({
  url: URL,
  serverName: "acme",
  ...over,
});

/** A lifecycle whose managed-connector registry holds exactly `providers`. */
function lifecycleWith(providers: Record<string, object>): ConnectorLifecycleManager {
  const lc = new ConnectorLifecycleManager(new NoopEventSink());
  lc.setManagedConnectorRegistry({
    get: (id: string) => providers[id],
    has: (id: string) => id in providers,
    list: () => Object.values(providers),
  } as never);
  return lc;
}

describe("isDisconnectable", () => {
  const lc = lifecycleWith({
    reconnects: { id: "reconnects", initiate: async () => ({}) },
    apikey: { id: "apikey", connectApiKey: async () => ({}) },
    oneway: { id: "oneway" },
  });

  test("an OAuth connection is, with no transport auth or with `none`", () => {
    expect(lc.isDisconnectable(ref())).toBe(true);
    expect(lc.isDisconnectable(ref({ transport: { type: "streamable-http" } }))).toBe(true);
    expect(
      lc.isDisconnectable(ref({ transport: { type: "streamable-http", auth: { type: "none" } } })),
    ).toBe(true);
  });

  test("a static credential is not: platform-minted, bearer or header", () => {
    const auths: TransportAuth[] = [
      { type: "provider", provider: "minted", config: {} },
      { type: "bearer", token: "t" },
      { type: "header", name: "x-key", value: "v" },
    ];
    for (const auth of auths) {
      expect(lc.isDisconnectable(ref({ transport: { type: "streamable-http", auth } }))).toBe(
        false,
      );
    }
  });

  test("a brokered connection is only when its broker can reconnect it", () => {
    const brokered = (provider: string) => ref({ brokered: { provider, connectorId: "c" } });
    expect(lc.isDisconnectable(brokered("reconnects"))).toBe(true);
    expect(lc.isDisconnectable(brokered("apikey"))).toBe(true);
    expect(lc.isDisconnectable(brokered("oneway"))).toBe(false);
    expect(lc.isDisconnectable(brokered("unregistered"))).toBe(false);
  });

  test("nothing without a URL ref", () => {
    expect(lc.isDisconnectable(undefined)).toBe(false);
  });
});
