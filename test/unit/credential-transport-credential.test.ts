/**
 * The `credential` transport credential — the shape that lets ONE catalog entry
 * point two workspaces at two different customer-owned secrets.
 *
 * `auth: provider` with `providerAuth: { provider: "credential", config: { key } }`
 * is copied verbatim into the `BundleRef` at install, so what is asserted here is
 * exactly what a persisted ref produces: a `fetch` that resolves the key at the
 * connection's own workspace on every request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTransportConfig } from "../../src/bundles/types.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { _resetCredentialProvidersForTest } from "../../src/tools/credential-provider.ts";
import {
  _resetCredentialStoreForTest,
  FileCredentialStore,
  setCredentialStore,
} from "../../src/tools/credential-store.ts";
import {
  CREDENTIAL_PROVIDER,
  credentialTransportCredentialProvider,
  registerCredentialTransportCredentialProvider,
} from "../../src/tools/credential-transport-credential.ts";
import { resolveTransportCredential } from "../../src/tools/remote-transport.ts";

let workDir: string;
let store: FileCredentialStore;
let events: EngineEvent[];

/** Capture the request a provider `fetch` would have made, without leaving the process. */
function captureFetch(): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Headers }>;
} {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const impl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-credprov-"));
  events = [];
  store = new FileCredentialStore(workDir, { eventSink: { emit: (e) => events.push(e) } });
  setCredentialStore(store);
  _resetCredentialProvidersForTest();
  registerCredentialTransportCredentialProvider();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetCredentialProvidersForTest();
  _resetCredentialStoreForTest();
  rmSync(workDir, { recursive: true, force: true });
});

function refFor(key: string, header?: string): RemoteTransportConfig {
  return {
    auth: {
      type: "provider",
      provider: CREDENTIAL_PROVIDER,
      config: { key, ...(header ? { header } : {}) },
    },
  };
}

describe("credentialFor", () => {
  test("returns a fetch, never a static header — the secret is not held on the transport", () => {
    const credential = credentialTransportCredentialProvider.credentialFor("ws_acme01", {
      key: "acme.db_url",
    });
    expect(credential.fetch).toBeDefined();
    expect(credential.headers).toBeUndefined();
  });

  test("a connection with no workspace is refused — it would resolve someone else's secret", () => {
    expect(() =>
      credentialTransportCredentialProvider.credentialFor(undefined, { key: "acme.db_url" }),
    ).toThrow(/workspaceId/);
  });

  test("a config with no key is refused at source start, not at the vendor", () => {
    expect(() =>
      credentialTransportCredentialProvider.credentialFor("ws_acme01", {}),
    ).toThrow(/string `key`/);
  });
});

describe("what reaches the wire", () => {
  test("the workspace's secret rides as a bearer token by default", async () => {
    await store.put({ kind: "workspace", wsId: "ws_acme01" }, "acme.db_url", "s3cret");
    const { fetch: spy, calls } = captureFetch();
    globalThis.fetch = spy;

    const { fetch: authed } = await resolveTransportCredential(refFor("acme.db_url"), "ws_acme01");
    await authed?.("https://svc.test/mcp", { method: "POST" });

    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer s3cret");
  });

  test("a named header carries the secret verbatim, with no Bearer prefix", async () => {
    await store.put({ kind: "workspace", wsId: "ws_acme01" }, "acme.db_url", "s3cret");
    const { fetch: spy, calls } = captureFetch();
    globalThis.fetch = spy;

    const { fetch: authed } = await resolveTransportCredential(
      refFor("acme.db_url", "x-api-key"),
      "ws_acme01",
    );
    await authed?.("https://svc.test/mcp", {});

    expect(calls[0]?.headers.get("x-api-key")).toBe("s3cret");
    expect(calls[0]?.headers.get("Authorization")).toBeNull();
  });

  test("the transport's own headers ride through untouched", async () => {
    await store.put({ kind: "workspace", wsId: "ws_acme01" }, "acme.db_url", "s3cret");
    const { fetch: spy, calls } = captureFetch();
    globalThis.fetch = spy;

    const { fetch: authed } = await resolveTransportCredential(refFor("acme.db_url"), "ws_acme01");
    await authed?.("https://svc.test/mcp", {
      headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
    });

    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("mcp-session-id")).toBe("sess-1");
  });

  test("one entry, two workspaces, two secrets — the headline case", async () => {
    await store.put({ kind: "workspace", wsId: "ws_tenanta" }, "acme.db_url", "a-secret");
    await store.put({ kind: "workspace", wsId: "ws_tenantb" }, "acme.db_url", "b-secret");
    const { fetch: spy, calls } = captureFetch();
    globalThis.fetch = spy;

    // The SAME config object, as an install into two workspaces would produce.
    const config = refFor("acme.db_url");
    const a = await resolveTransportCredential(config, "ws_tenanta");
    const b = await resolveTransportCredential(config, "ws_tenantb");
    await a.fetch?.("https://svc.test/mcp", {});
    await b.fetch?.("https://svc.test/mcp", {});

    expect(calls.map((c) => c.headers.get("Authorization"))).toEqual([
      "Bearer a-secret",
      "Bearer b-secret",
    ]);
  });

  test("rotation lands on the next request — the fetch resolves per call", async () => {
    const scope = { kind: "workspace", wsId: "ws_acme01" } as const;
    await store.put(scope, "acme.db_url", "v1");
    const { fetch: spy, calls } = captureFetch();
    globalThis.fetch = spy;

    const { fetch: authed } = await resolveTransportCredential(refFor("acme.db_url"), "ws_acme01");
    await authed?.("https://svc.test/mcp", {});
    await store.put(scope, "acme.db_url", "v2");
    await authed?.("https://svc.test/mcp", {});

    expect(calls.map((c) => c.headers.get("Authorization"))).toEqual(["Bearer v1", "Bearer v2"]);
  });

  test("a key deleted mid-connection fails the request naming the key", async () => {
    const { fetch: authed } = await resolveTransportCredential(refFor("acme.db_url"), "ws_acme01");
    await expect(authed?.("https://svc.test/mcp", {})).rejects.toThrow(
      /acme\.db_url.*workspace:ws_acme01/s,
    );
  });

  test("each request is audited once, without the value", async () => {
    await store.put({ kind: "workspace", wsId: "ws_acme01" }, "acme.db_url", "s3cret");
    const { fetch: spy } = captureFetch();
    globalThis.fetch = spy;

    const { fetch: authed } = await resolveTransportCredential(refFor("acme.db_url"), "ws_acme01");
    await authed?.("https://svc.test/mcp", {});
    await authed?.("https://svc.test/mcp", {});

    expect(events).toHaveLength(2);
    expect(events[0]?.data).toMatchObject({
      scope: "workspace:ws_acme01",
      key: "acme.db_url",
      caller: "transport:provider:credential",
    });
    expect(JSON.stringify(events)).not.toContain("s3cret");
  });
});
