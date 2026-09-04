/**
 * `SmitheryConnectionProbe` — the second `ConnectionHealthProbe`.
 *
 * The kernel counts `credential_lost` toward flipping a connector to
 * `reauth_required`, so the anti-flap mapping is the behavior worth pinning. The
 * rule itself is stated once, with the code that implements it — see the header
 * of `src/connectors/providers/smithery/connection-probe.ts`. Each case below
 * pins one arm of it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ProbeTarget } from "../../src/bundles/connection-probe.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { SmitheryConnectionProbe } from "../../src/connectors/providers/smithery/connection-probe.ts";

const OPTIONS = { apiKey: "sk_test", baseUrl: "https://api.smithery.ai", namespace: "test-ns" };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function refWithMarker(): BundleRef {
  return {
    url: "https://api.smithery.ai/connect/test-ns/nb-x/mcp",
    serverName: "ai-bassethound-mcp",
    oauthScope: "workspace",
    brokered: {
      provider: "smithery",
      connectorId: "ai.bassethound/mcp",
      providerRef: {
        connectionId: "nb-x",
        namespace: "test-ns",
        baseUrl: "https://api.smithery.ai",
      },
    },
  };
}

/** The pre-`brokered` shape still on disk for an install made by an older runtime. */
function legacyRefWithMarker(): BundleRef {
  return {
    url: "https://api.smithery.ai/connect/test-ns/nb-x/mcp",
    serverName: "ai-bassethound-mcp",
    oauthScope: "workspace",
    smithery: {
      connectorId: "ai.bassethound/mcp",
      connectionId: "nb-x",
      namespace: "test-ns",
      baseUrl: "https://api.smithery.ai",
    },
  } as unknown as BundleRef;
}

function targetOf(ref: BundleRef): ProbeTarget {
  return { serverName: "ai-bassethound-mcp", wsId: "ws_01abc", principalId: "u_1", ref };
}

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(status === 404 ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

async function verdictFor(status: number, body: unknown) {
  stubFetch(status, body);
  return new SmitheryConnectionProbe(OPTIONS).probe(targetOf(refWithMarker()), new AbortController().signal);
}

describe("SmitheryConnectionProbe — liveness mapping", () => {
  it("reports live for a connected connection", async () => {
    expect(await verdictFor(200, { connectionId: "nb-x", status: { state: "connected" } })).toBe("live");
  });

  it("reports live for a disconnected connection — the broker reconnects on demand", async () => {
    expect(await verdictFor(200, { connectionId: "nb-x", status: { state: "disconnected" } })).toBe(
      "live",
    );
  });

  it("reports indeterminate on auth_required — the product has no reconnect to offer", async () => {
    // Flipping to reauth_required would give the user a Reconnect button that
    // headlessly restarts the still-valid static header, reads `running`, and
    // flips back next sweep. Smithery's remedy is its hosted setup page, which
    // a ConnectionLiveness verdict cannot carry.
    expect(
      await verdictFor(200, {
        connectionId: "nb-x",
        status: { state: "auth_required", setupUrl: "https://auth.smithery.ai/x" },
      }),
    ).toBe("indeterminate");
  });

  it("reports indeterminate when required config went missing", async () => {
    expect(
      await verdictFor(200, {
        connectionId: "nb-x",
        status: { state: "input_required", http: {}, missing: { headers: [], query: [] } },
      }),
    ).toBe("indeterminate");
  });

  it("reports credential_lost when the connection is gone at the broker (404)", async () => {
    expect(await verdictFor(404, null)).toBe("credential_lost");
  });

  it("reports indeterminate on a generic error state (anti-flap)", async () => {
    // Smithery reports transient upstream failures here too — flipping a
    // working connector to reauth_required on this would be a false positive.
    expect(
      await verdictFor(200, { connectionId: "nb-x", status: { state: "error", message: "timeout" } }),
    ).toBe("indeterminate");
  });

  it("reports indeterminate on an API failure", async () => {
    expect(await verdictFor(500, { error: "server_error", message: "boom" })).toBe("indeterminate");
  });

  it("reports indeterminate when the transport throws, and never propagates", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const probe = new SmitheryConnectionProbe(OPTIONS);
    expect(await probe.probe(targetOf(refWithMarker()), new AbortController().signal)).toBe(
      "indeterminate",
    );
  });

  it("probes the namespace the connection was CREATED in, not current config", async () => {
    // A repointed declared namespace must not make the probe look in the new
    // namespace: the ref's session URL still targets the old one and works, so
    // a config-read would 404 and false-flip a healthy connector.
    let requested = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ connectionId: "nb-x", status: { state: "connected" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const probe = new SmitheryConnectionProbe({ ...OPTIONS, namespace: "repointed-ns" });
    const verdict = await probe.probe(targetOf(refWithMarker()), new AbortController().signal);

    expect(verdict).toBe("live");
    expect(requested).toContain("/connect/test-ns/");
    expect(requested).not.toContain("repointed-ns");
  });

  it("probes the host recorded on the ref, not a repointed one", async () => {
    let requested = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ connectionId: "nb-x", status: { state: "connected" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const probe = new SmitheryConnectionProbe({ ...OPTIONS, baseUrl: "https://repointed.example" });
    const verdict = await probe.probe(targetOf(refWithMarker()), new AbortController().signal);

    expect(verdict).toBe("live");
    expect(requested).toContain("https://api.smithery.ai/connect/test-ns/nb-x");
    expect(requested).not.toContain("repointed.example");
  });

  it("reports indeterminate for a ref carrying no brokered marker", async () => {
    const probe = new SmitheryConnectionProbe(OPTIONS);
    const bare = { url: "https://x/mcp", serverName: "x" } as BundleRef;
    expect(await probe.probe(targetOf(bare), new AbortController().signal)).toBe("indeterminate");
  });

  // The read-side shim: an install made before refs shared one shape keeps
  // probing, with no config edit and no rewrite of what is on disk.
  it("probes a legacy per-vendor ref through the shim", async () => {
    let requested = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ connectionId: "nb-x", status: { state: "connected" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const probe = new SmitheryConnectionProbe(OPTIONS);
    const verdict = await probe.probe(
      targetOf(legacyRefWithMarker()),
      new AbortController().signal,
    );

    expect(verdict).toBe("live");
    expect(requested).toContain("https://api.smithery.ai/connect/test-ns/nb-x");
  });
});
