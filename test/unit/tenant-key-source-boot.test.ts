import { describe, expect, test } from "bun:test";
import { bundleHasStaticAuth } from "../../src/bundles/bundle-auth.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../src/bundles/connection.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

class NoopSink implements EventSink {
  emit(_event: EngineEvent): void {}
}

function tenantKeyRef(): BundleRef {
  return {
    url: "https://web.svc.test/mcp",
    serverName: "web",
    transport: {
      type: "streamable-http",
      auth: { type: "tenant-key", audience: "mcp-fleet", scope: "mcp:invoke" },
    },
  };
}

describe("bundleHasStaticAuth", () => {
  test("tenant-key url bundle has static auth", () => {
    expect(bundleHasStaticAuth(tenantKeyRef())).toBe(true);
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

describe("seedInstance — tenant-key fleet source", () => {
  // Regression: a tenant-key source mints on demand and has no persisted OAuth
  // tokens, so the OAuth-centric boot gate seeded it `not_authenticated` — the
  // agent never saw its tools, and the UI showed a "Connect" button that would
  // spin a bogus OAuth flow against a server with no OAuth. It must seed
  // `running` (auto-connected) instead.
  test("seeds running, not not_authenticated", () => {
    const lifecycle = new BundleLifecycleManager(new NoopSink(), undefined);
    lifecycle.seedInstance("web", "https://web.svc.test/mcp", tenantKeyRef(), undefined, "ws_test");

    const conn = lifecycle.getInstance("web", "ws_test")?.connections.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("running");
    expect(conn?.state).not.toBe("not_authenticated");
  });
});
