import { describe, expect, test } from "bun:test";
import { bundleHasStaticAuth } from "../../src/bundles/bundle-auth.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../src/bundles/connection.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import type { ManagedConnectorProvider } from "../../src/connectors/providers/managed-provider.ts";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

class NoopSink implements EventSink {
  emit(_event: EngineEvent): void {}
}

function providerRef(): BundleRef {
  return {
    url: "https://web.svc.test/mcp",
    serverName: "web",
    transport: {
      type: "streamable-http",
      auth: { type: "provider", provider: "minted", config: { audience: "mcp-fleet", scope: "mcp:invoke" } },
    },
  };
}

describe("bundleHasStaticAuth", () => {
  test("provider-auth url bundle has static auth", () => {
    expect(bundleHasStaticAuth(providerRef())).toBe(true);
  });

  test("bearer and header url bundles have static auth", () => {
    expect(
      bundleHasStaticAuth({ url: "u", transport: { auth: { type: "bearer", token: "t" } } }),
    ).toBe(true);
    expect(
      bundleHasStaticAuth({
        url: "u",
        transport: { auth: { type: "header", name: "X-Key", value: "v" } },
      }),
    ).toBe(true);
  });

  test("auth:none and no-auth url bundles are NOT static (they take the OAuth path)", () => {
    expect(bundleHasStaticAuth({ url: "u", transport: { auth: { type: "none" } } })).toBe(false);
    expect(bundleHasStaticAuth({ url: "u" })).toBe(false);
  });

  test("named and local-path bundles are not static-auth url sources", () => {
    expect(bundleHasStaticAuth({ name: "n" })).toBe(false);
    expect(bundleHasStaticAuth({ path: "/p" })).toBe(false);
  });
});

describe("seedInstance — provider-auth fleet source", () => {
  // Regression: a provider-auth source mints on demand and has no persisted OAuth
  // tokens, so the OAuth-centric boot gate seeded it `not_authenticated` — the
  // agent never saw its tools, and the UI showed a "Connect" button that would
  // spin a bogus OAuth flow against a server with no OAuth. It must seed
  // `running` (auto-connected) instead.
  test("seeds running, not not_authenticated", () => {
    const lifecycle = new BundleLifecycleManager(new NoopSink(), undefined);
    lifecycle.seedInstance("web", "https://web.svc.test/mcp", providerRef(), undefined, "ws_test");

    const conn = lifecycle.getInstance("web", "ws_test")?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("running");
    expect(conn?.state).not.toBe("not_authenticated");
  });

  // Regression guard for the asymmetry that bit the first cut of this fix: a
  // brokered bundle ALSO carries static transport auth, so `bundleHasStaticAuth`
  // is true for it — but its broker may still need a per-owner connect. The gate
  // must ask the PROVIDER first. An unconnected brokered connector must seed
  // `not_authenticated`, not `running`, or the UI loses its Connect button and
  // every tool call fails "not connected".
  //
  // Tested through a fake provider, not a vendor: the kernel's contract is
  // "ask whoever owns this ref", and that is what must hold for provider #3.
  test("an unconnected brokered connector seeds not_authenticated (the provider's verdict wins over static-auth)", () => {
    const lifecycle = new BundleLifecycleManager(new NoopSink(), undefined);
    lifecycle.setManagedConnectorRegistry(
      managedConnectorRegistryOf([exampleBroker({ connected: false })]),
    );
    lifecycle.seedInstance("gmail", brokeredRef().url ?? "", brokeredRef(), undefined, "ws_test");

    const conn = lifecycle.getInstance("gmail", "ws_test")?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("not_authenticated");
  });

  test("a connected brokered connector seeds running", () => {
    const lifecycle = new BundleLifecycleManager(new NoopSink(), undefined);
    lifecycle.setManagedConnectorRegistry(
      managedConnectorRegistryOf([exampleBroker({ connected: true })]),
    );
    lifecycle.seedInstance("gmail", brokeredRef().url ?? "", brokeredRef(), undefined, "ws_test");

    const conn = lifecycle.getInstance("gmail", "ws_test")?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("running");
  });

  // A provider with nothing to connect per-owner omits `hasConnection`, and the
  // generic static-auth check answers — the Smithery shape.
  test("a brokered connector whose provider has no hasConnection falls back to static-auth", () => {
    const lifecycle = new BundleLifecycleManager(new NoopSink(), undefined);
    lifecycle.setManagedConnectorRegistry(managedConnectorRegistryOf([exampleBroker({})]));
    lifecycle.seedInstance("gmail", brokeredRef().url ?? "", brokeredRef(), undefined, "ws_test");

    const conn = lifecycle.getInstance("gmail", "ws_test")?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("running");
  });
});

/** A brokered ref carrying static transport auth — the shape the gate must not mistake for "ready". */
function brokeredRef(): BundleRef {
  return {
    url: "https://broker.test/session/abc/mcp",
    serverName: "gmail",
    transport: {
      type: "streamable-http",
      auth: { type: "header", name: "x-api-key", value: "k" },
    },
    brokered: { provider: "example-broker", connectorId: "com.example/gmail" },
  };
}

/** A fake brokered provider. `connected` undefined ⇒ the provider omits `hasConnection`. */
function exampleBroker(opts: { connected?: boolean }): ManagedConnectorProvider {
  return {
    id: "example-broker",
    userId: (owner) => (owner.type === "workspace" ? owner.wsId : owner.userId),
    createSession: async () => ({ type: "http", url: "https://broker.test/session/abc/mcp" }),
    ...(opts.connected === undefined ? {} : { hasConnection: () => opts.connected === true }),
  };
}
