/**
 * `SmitheryProvider` — provider #2 for the `ManagedConnectorProvider` seam.
 *
 * The point of this suite is the *shape* of the provider, not Smithery's HTTP
 * wire: it asserts that a genuinely different broker registers through the same
 * registry as Composio while implementing a strict SUBSET of the interface. If
 * the seam were secretly Composio-shaped, these assertions could not hold.
 *
 * Per the seam's target test model, session behavior is exercised through a
 * registered fake provider (mock the seam, not the vendor). The one place a
 * network shape is asserted — `createSession` status handling — stubs
 * `globalThis.fetch`, because that IS the behavior under test and Smithery has
 * no SDK to mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";
import type { ManagedConnectorProvider } from "../../src/connectors/providers/managed-provider.ts";
import { smitheryConnectionId, smitheryMcpUrl } from "../../src/connectors/providers/smithery/client.ts";
import { _resetSmitheryConfigForTest } from "../../src/connectors/providers/smithery/config.ts";
import { createSmitheryProvider, smitheryUserId } from "../../src/connectors/providers/smithery/provider.ts";
import { setConnectorsConfig } from "../../src/connectors/providers/config.ts";

const ENV_KEYS = [
  "SMITHERY_API_KEY",
  "SMITHERY_NAMESPACE",
  "SMITHERY_API_BASE_URL",
  "NB_TENANT_ID",
] as const;
let saved: Record<string, string | undefined>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetSmitheryConfigForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetSmitheryConfigForTest();
  globalThis.fetch = realFetch;
});

function configure(): void {
  process.env.SMITHERY_API_KEY = "sk_test";
  setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });
  _resetSmitheryConfigForTest();
}

/** Stub `fetch` with a single JSON response, capturing the request for assertions. */
function stubFetch(status: number, body: unknown): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

describe("SmitheryProvider — the interface subset (what validates the seam)", () => {
  beforeEach(configure);

  it("implements createSession + probe, and NONE of the auth-broker or teardown arms", () => {
    const provider = createSmitheryProvider();

    expect(provider.id).toBe("smithery");
    expect(typeof provider.userId).toBe("function");
    expect(typeof provider.createSession).toBe("function");
    expect(typeof provider.probe).toBe("function");

    // The asymmetry with Composio IS the validation: Smithery brokers OAuth
    // through its own hosted setup page, so it contributes no initiate arm and
    // no callback routes. An interface that required these would be
    // Composio-specific.
    expect(provider.initiate).toBeUndefined();
    expect(provider.routes).toBeUndefined();
    // Blocked on the OPTION SHAPE, not the vendor: both opts carry
    // `authConfigId` but not `toolkit`, so neither can name a Smithery
    // connector. See the seam findings.
    expect(provider.connectApiKey).toBeUndefined();
    expect(provider.findActive).toBeUndefined();
    // Teardown is lifecycle-driven (`cleanupSmitheryBundle`, on uninstall) and
    // needs the ref's namespace, which `delete(id)` cannot carry — a provider
    // arm here would be a second, namespace-blind copy nothing calls.
    expect(provider.delete).toBeUndefined();
  });

  it("registers alongside Composio in one registry, keyed by auth-kind", () => {
    const composioFake: ManagedConnectorProvider = {
      id: "composio",
      userId: () => "u",
      createSession: async () => ({ type: "http", url: "https://composio.test/mcp" }),
      initiate: async () => ({ redirectUrl: "https://composio.test/auth", connectedAccountId: "ca_1" }),
    };
    const registry = managedConnectorRegistryOf([composioFake, createSmitheryProvider()]);

    expect(registry.get("composio")?.id).toBe("composio");
    expect(registry.get("smithery")?.id).toBe("smithery");
    expect(registry.list().map((p) => p.id).sort()).toEqual(["composio", "smithery"]);

    // Dispatch is by kind — the registry never branches on vendor.
    expect(registry.get("smithery")?.initiate).toBeUndefined();
    expect(registry.get("composio")?.initiate).toBeDefined();
  });
});

describe("smitheryUserId — owner namespacing (vendor-free)", () => {
  it("uses the bare workspace id when no tenant is stamped", () => {
    expect(smitheryUserId({ type: "workspace", wsId: "ws_01abc" })).toBe("ws_01abc");
  });

  it("prefixes the tenant id so workspace ids don't collide across tenants", () => {
    process.env.NB_TENANT_ID = "tenant-a";
    expect(smitheryUserId({ type: "workspace", wsId: "ws_01abc" })).toBe("tenant-a:ws_01abc");
  });

  it("namespaces identity owners distinctly from workspaces", () => {
    expect(smitheryUserId({ type: "user", userId: "u_1" })).toBe("user:u_1");
  });
});

describe("smitheryConnectionId — deterministic, path-safe, collision-free", () => {
  it("is stable for the same (owner, server) pair", () => {
    const a = smitheryConnectionId("tenant-a:ws_01abc", "nimblebrain/bassethound");
    const b = smitheryConnectionId("tenant-a:ws_01abc", "nimblebrain/bassethound");
    expect(a).toBe(b);
  });

  it("contains only path-safe characters even when the owner id does not", () => {
    // The Composio-style owner id carries a colon, which is not path-safe.
    const id = smitheryConnectionId("tenant-a:ws_01abc", "nimblebrain/bassethound");
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it("separates owners that slugify identically (why the digest exists)", () => {
    // `a:b` and `a-b` fold to the same slug; only the digest keeps them apart.
    const one = smitheryConnectionId("a:b", "nimblebrain/bassethound");
    const two = smitheryConnectionId("a-b", "nimblebrain/bassethound");
    expect(one).not.toBe(two);
  });

  it("separates a shifted boundary between owner and server", () => {
    // Without the length prefix, `a:b` + `c` and `a` + `b:c` hash the same
    // concatenation AND slugify identically — one owner's connection would be
    // adopted by another's install.
    expect(smitheryConnectionId("a:b", "c")).not.toBe(smitheryConnectionId("a", "b:c"));
  });

  it("separates different servers for the same owner", () => {
    const one = smitheryConnectionId("ws_1", "nimblebrain/bassethound");
    const two = smitheryConnectionId("ws_1", "nimblebrain/other");
    expect(one).not.toBe(two);
  });
});

describe("SmitheryProvider.createSession", () => {
  beforeEach(configure);

  it("upserts the connection by registry qualified name and returns the hosted MCP session", async () => {
    const { calls } = stubFetch(200, {
      connectionId: "ignored-by-us",
      status: { state: "connected" },
      serverInfo: { name: "bassethound", version: "1.0.0" },
    });

    const session = await createSmitheryProvider().createSession({
      userId: "ws_01abc",
      toolkit: "nimblebrain/bassethound",
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.init?.method).toBe("PUT");
    expect(call?.url).toContain("/connect/test-ns/");

    // The catalog names a registry server; the runtime never invents an endpoint.
    const body = JSON.parse(String(call?.init?.body));
    expect(body.server).toBe("nimblebrain/bassethound");
    expect(body.metadata.userId).toBe("ws_01abc");

    const expectedId = smitheryConnectionId("ws_01abc", "nimblebrain/bassethound");
    expect(session.type).toBe("http");
    expect(session.url).toBe(
      smitheryMcpUrl(
        { apiKey: "sk_test", baseUrl: "https://api.smithery.ai", namespace: "test-ns" },
        expectedId,
      ),
    );
    // No headers: the bearer's one home is the credential provider.
    expect(session.headers).toBeUndefined();

    // The coordinates travel on the session itself, so no caller has to parse
    // the broker's id format back out of the URL.
    expect(session.providerRef).toEqual({
      connectionId: expectedId,
      namespace: "test-ns",
      baseUrl: "https://api.smithery.ai",
    });
  });

  it("treats `disconnected` as usable — Smithery re-establishes the upstream leg on demand", async () => {
    stubFetch(200, { connectionId: "c", status: { state: "disconnected" } });
    const session = await createSmitheryProvider().createSession({
      userId: "ws_01abc",
      toolkit: "nimblebrain/bassethound",
    });
    expect(session.url).toContain("/mcp");
  });

  it("surfaces `auth_required` with the hosted setup URL rather than a half-wired session", async () => {
    stubFetch(200, {
      connectionId: "c",
      status: { state: "auth_required", setupUrl: "https://auth.smithery.ai/xyz" },
    });

    const promise = createSmitheryProvider().createSession({
      userId: "ws_01abc",
      toolkit: "nimblebrain/needs-oauth",
    });
    await expect(promise).rejects.toThrow(/needs authorization.*auth\.smithery\.ai\/xyz/);
  });

  it("surfaces `input_required` with the hosted setup URL", async () => {
    stubFetch(200, {
      connectionId: "c",
      status: {
        state: "input_required",
        setupUrl: "https://smithery.ai/setup/xyz",
        http: { headers: {}, query: {} },
        missing: { headers: ["apiKey"], query: [] },
      },
    });

    const promise = createSmitheryProvider().createSession({
      userId: "ws_01abc",
      toolkit: "nimblebrain/needs-config",
    });
    await expect(promise).rejects.toThrow(/needs configuration/);
  });

  it("surfaces the broker's message on an `error` state", async () => {
    stubFetch(200, {
      connectionId: "c",
      status: { state: "error", message: "upstream refused the handshake" },
    });

    const promise = createSmitheryProvider().createSession({
      userId: "ws_01abc",
      toolkit: "nimblebrain/broken",
    });
    await expect(promise).rejects.toThrow(/upstream refused the handshake/);
  });

  it("surfaces a non-2xx from the Connect API", async () => {
    stubFetch(404, { error: "not_found", message: "Namespace not found or access denied" });

    const promise = createSmitheryProvider().createSession({
      userId: "ws_01abc",
      toolkit: "nimblebrain/bassethound",
    });
    await expect(promise).rejects.toThrow(/404/);
  });
});
