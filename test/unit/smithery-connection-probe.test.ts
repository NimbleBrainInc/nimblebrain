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
import { brokeredRef } from "../../src/bundles/connection-probe.ts";
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
    smithery: {
      connectorId: "ai.bassethound/mcp",
      connectionId: "nb-x",
      namespace: "test-ns",
      baseUrl: "https://api.smithery.ai",
    },
  } as BundleRef;
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

describe("brokeredRef — catalog-id recovery", () => {
  // Every brokered install persists a per-install session URL, so a url→catalog
  // lookup misses and this stamped id is the only way back to the entry. Without
  // it the connector renders as the slug with a letter avatar and every
  // catalog-gated Configure section goes dark.
  it("recovers the catalog id from a smithery ref", () => {
    expect(brokeredRef(refWithMarker())?.connectorId).toBe("ai.bassethound/mcp");
  });

  it("recovers the catalog id from a composio ref (no regression)", () => {
    const composio = {
      url: "https://backend.composio.dev/v3/mcp/session-xyz",
      serverName: "com-google-gmail",
      composio: { connectorId: "com.google/gmail" },
    } as unknown as BundleRef;
    expect(brokeredRef(composio)?.connectorId).toBe("com.google/gmail");
  });

  it("returns undefined for a runtime-native ref — url match is its only path", () => {
    const dcr = { url: "https://mcp.notion.com/mcp", serverName: "com-notion-mcp" } as BundleRef;
    expect(brokeredRef(dcr)).toBeNull();
    expect(brokeredRef(undefined)).toBeNull();
  });
});

describe("brokeredRef — probe dispatch", () => {
  it("routes a smithery-marked ref to the smithery probe", () => {
    expect(brokeredRef(refWithMarker())?.providerId).toBe("smithery");
  });

  it("leaves an unmarked ref unowned", () => {
    expect(brokeredRef({ url: "https://x/mcp", serverName: "x" } as BundleRef)).toBeNull();
  });
});

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

  it("reports indeterminate for a ref carrying no smithery marker", async () => {
    const probe = new SmitheryConnectionProbe(OPTIONS);
    const bare = { url: "https://x/mcp", serverName: "x" } as BundleRef;
    expect(await probe.probe(targetOf(bare), new AbortController().signal)).toBe("indeterminate");
  });
});
