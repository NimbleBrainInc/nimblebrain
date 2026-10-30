import { describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { ManagedConnectorProvider } from "../../../src/connectors/providers/managed-provider.ts";
import { ConnectorLifecycleManager } from "../../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import { stub } from "../../helpers/stub.ts";

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
function lifecycleWith(
  providers: Record<string, ManagedConnectorProvider>,
): ConnectorLifecycleManager {
  const lc = new ConnectorLifecycleManager(new NoopEventSink());
  lc.setManagedConnectorRegistry({
    get: (id: string) => providers[id],
    has: (id: string) => id in providers,
    list: () => Object.values(providers),
  });
  return lc;
}

describe("isDisconnectable", () => {
  const lc = lifecycleWith({
    reconnects: stub<ManagedConnectorProvider>({
      id: "reconnects",
      initiate: async () => ({
        redirectUrl: "https://auth.example.test/start",
        connectedAccountId: "ca_1",
      }),
    }),
    apikey: stub<ManagedConnectorProvider>({
      id: "apikey",
      connectApiKey: async () => ({ status: "ACTIVE" }),
    }),
    oneway: stub<ManagedConnectorProvider>({ id: "oneway" }),
  });

  test("an OAuth connection is: one with no transport auth", () => {
    expect(lc.isDisconnectable(ref())).toBe(true);
    expect(lc.isDisconnectable(ref({ transport: { type: "streamable-http" } }))).toBe(true);
  });

  test("a static credential, or none at all, is not: platform-minted, bearer, header or none", () => {
    const auths: TransportAuth[] = [
      { type: "provider", provider: "minted", config: {} },
      { type: "bearer", token: "t" },
      { type: "header", name: "x-key", value: "v" },
      { type: "none" },
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
