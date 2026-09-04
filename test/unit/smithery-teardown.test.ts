/**
 * `cleanupSmitheryBundle` — the only teardown Smithery has.
 *
 * It runs on uninstall and is what keeps a brokered connection (and, for any
 * OAuth-backed Smithery connector, the user's upstream grant that Smithery
 * holds) from living forever at the broker. The end-to-end suite exercises it
 * against the real API but is `skipIf` without credentials, so it runs in no
 * pipeline — this is the CI-executed cover.
 *
 * Stubbed at `fetch`: what matters is which namespace the DELETE targets, and
 * that a failure is reported rather than swallowed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import {
  _resetSmitheryConfigForTest,
  validateSmitheryConfig,
} from "../../src/connectors/providers/smithery/config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import {
  cleanupSmitheryBundle,
  createSmitheryProvider,
} from "../../src/connectors/providers/smithery/provider.ts";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";

const ENV_KEYS = ["SMITHERY_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

/** Capture the DELETE the teardown issues. */
function stubDelete(status: number): { calls: Array<{ url: string; method?: string }> } {
  const calls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(status === 204 ? null : JSON.stringify({ error: "nope" }), { status });
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  _resetSmitheryConfigForTest();
  _resetConnectorsConfigForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetSmitheryConfigForTest();
  _resetConnectorsConfigForTest();
  globalThis.fetch = realFetch;
});

function configure(namespace = "current-ns"): void {
  process.env.SMITHERY_API_KEY = "sk_test";
  setConnectorsConfig({ providers: { smithery: { namespace } } });
  _resetSmitheryConfigForTest();
}

describe("cleanupSmitheryBundle", () => {
  it("deletes in the namespace recorded on the ref, not the current config", async () => {
    configure("current-ns");
    const { calls } = stubDelete(204);

    const result = await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "install-time-ns",
      baseUrl: "https://api.smithery.ai",
    });

    expect(result.upstreamDeleted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    // Repointing the declared namespace must not make teardown delete a DIFFERENT
    // tenant's connection, or miss this one entirely.
    expect(calls[0]?.url).toContain("/connect/install-time-ns/nb-abc");
    expect(calls[0]?.url).not.toContain("current-ns");
  });

  it("deletes at the host recorded on the ref, not a repointed one", async () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "current-ns", baseUrl: "https://repointed.example" } } });
    _resetSmitheryConfigForTest();
    const { calls } = stubDelete(204);

    await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "install-time-ns",
      baseUrl: "https://api.smithery.ai",
    });

    // A repoint leaves the persisted session URL on the OLD host, so deleting
    // against the new one 404s — and a 404 reads as "already gone", reporting
    // success while the real connection survives at the broker.
    expect(calls[0]?.url).toContain("https://api.smithery.ai/connect/install-time-ns/nb-abc");
    expect(calls[0]?.url).not.toContain("repointed.example");
  });

  it("treats an already-gone connection (404) as success", async () => {
    configure();
    stubDelete(404);

    const result = await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "current-ns",
      baseUrl: "https://api.smithery.ai",
    });
    expect(result.upstreamDeleted).toBe(true);
    expect(result.lastError).toBeUndefined();
  });

  it("reports a rejected delete instead of swallowing it", async () => {
    configure();
    stubDelete(403);

    // A revoked platform key would otherwise leave the connection — and any
    // upstream grant behind it — alive at the broker with no log line anywhere.
    const result = await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "current-ns",
      baseUrl: "https://api.smithery.ai",
    });
    expect(result.upstreamDeleted).toBe(false);
    expect(result.lastError).toContain("403");
  });

  it("reports a broker outage instead of swallowing it", async () => {
    configure();
    stubDelete(500);

    const result = await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "current-ns",
      baseUrl: "https://api.smithery.ai",
    });
    expect(result.upstreamDeleted).toBe(false);
    expect(result.lastError).toContain("500");
  });

  it("reports a transport failure and never throws", async () => {
    configure();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const result = await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "current-ns",
      baseUrl: "https://api.smithery.ai",
    });
    expect(result.upstreamDeleted).toBe(false);
    expect(result.lastError).toContain("network down");
  });

  it("reports unconfigured rather than attempting a delete", async () => {
    // No credential — nothing to authenticate with.
    const { calls } = stubDelete(204);

    const result = await cleanupSmitheryBundle({
      connectionId: "nb-abc",
      namespace: "current-ns",
      baseUrl: "https://api.smithery.ai",
    });
    expect(result.upstreamDeleted).toBe(false);
    expect(result.lastError).toContain("not configured");
    expect(calls).toHaveLength(0);
    expect(validateSmitheryConfig().apiKey).toBe("");
  });
});

describe("uninstall → broker teardown wiring", () => {
  /**
   * The half `cleanupSmitheryBundle`'s own tests cannot reach: that uninstall
   * actually CALLS it. Without this the connection — and, for any OAuth-backed
   * Smithery connector, the user's upstream grant — is orphaned at the broker,
   * which is the failure three review rounds chased.
   */
  it("issues a DELETE in the ref's namespace when a smithery bundle is uninstalled", async () => {
    configure("current-ns");
    const { calls } = stubDelete(204);

    const workDir = mkdtempSync(join(tmpdir(), "nb-smithery-uninstall-"));
    try {
      const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
      lifecycle.setManagedConnectorRegistry(managedConnectorRegistryOf([createSmitheryProvider()]));
      const ref: BundleRef = {
        url: "https://api.smithery.ai/connect/install-time-ns/nb-abc/mcp",
        serverName: "ai-bassethound-mcp",
        oauthScope: "workspace",
        brokered: {
          provider: "smithery",
          connectorId: "ai.bassethound/mcp",
          providerRef: {
            connectionId: "nb-abc",
            namespace: "install-time-ns",
            baseUrl: "https://api.smithery.ai",
          },
        },
      };
      await lifecycle.seedInstance(
        "ai-bassethound-mcp",
        ref.url,
        ref,
        undefined,
        "ws_test",
        workDir,
      );

      await lifecycle.uninstall("ai-bassethound-mcp", new ToolRegistry(), "ws_test");

      const deletes = calls.filter((c) => c.method === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.url).toContain("/connect/install-time-ns/nb-abc");
      expect(deletes[0]?.url).not.toContain("current-ns");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
