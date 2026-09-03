/**
 * `brokeredRef` — the one accessor that answers "who brokered this install?".
 *
 * Two consumers need different halves of the same fact: the revalidator
 * dispatches on `provider`, while the connector read surfaces and the
 * skill-overlay reconcile resolve `connectorId` (every brokered install
 * persists a per-install session URL, so a url→catalog lookup misses and the
 * stamped id is the only way back to the entry). One accessor is what keeps a
 * third provider from being added to one of them and silently missing from the
 * other.
 */

import { describe, expect, it } from "bun:test";
import { brokeredRef } from "../../../src/bundles/brokered.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";

describe("brokeredRef", () => {
  it("reads the brokered block a current install persists", () => {
    const ref: BundleRef = {
      url: "https://broker.test/session/abc/mcp",
      serverName: "com-example-gmail",
      brokered: {
        provider: "example-broker",
        connectorId: "com.example/gmail",
        providerRef: { connectionId: "c_1", namespace: "ns" },
      },
    };
    expect(brokeredRef(ref)).toEqual({
      provider: "example-broker",
      connectorId: "com.example/gmail",
      providerRef: { connectionId: "c_1", namespace: "ns" },
    });
  });

  it("returns undefined for a runtime-native ref — url match is its only path", () => {
    expect(brokeredRef({ url: "https://mcp.notion.com/mcp", serverName: "com-notion-mcp" })).toBeUndefined();
    expect(brokeredRef(undefined)).toBeUndefined();
  });
});

// ── Read-side shim ──────────────────────────────────────────────────
//
// Refs persisted by a runtime that wrote per-vendor blocks are mapped forward on
// read, so an existing install survives a restart with no config edit and
// nothing rewrites what is on disk. Delete these with the shim, one release on.

describe("brokeredRef — legacy per-vendor blocks", () => {
  it("maps a legacy composio block forward", () => {
    const legacy = {
      url: "https://backend.composio.dev/v3/mcp/session-xyz",
      serverName: "com-google-gmail",
      composio: { connectorId: "com.google/gmail" },
    } as unknown as BundleRef;
    expect(brokeredRef(legacy)).toEqual({
      provider: "composio",
      connectorId: "com.google/gmail",
    });
  });

  it("maps a legacy smithery block forward, coordinates and all", () => {
    const legacy = {
      url: "https://api.smithery.ai/connect/test-ns/nb-x/mcp",
      serverName: "ai-bassethound-mcp",
      smithery: {
        connectorId: "ai.bassethound/mcp",
        connectionId: "nb-x",
        namespace: "test-ns",
        baseUrl: "https://api.smithery.ai",
      },
    } as unknown as BundleRef;
    expect(brokeredRef(legacy)).toEqual({
      provider: "smithery",
      connectorId: "ai.bassethound/mcp",
      providerRef: {
        connectionId: "nb-x",
        namespace: "test-ns",
        baseUrl: "https://api.smithery.ai",
      },
    });
  });

  it("prefers a written brokered block over a stale legacy one", () => {
    const both = {
      url: "https://broker.test/mcp",
      serverName: "x",
      brokered: { provider: "smithery", connectorId: "new.id/mcp" },
      composio: { connectorId: "old.id/mcp" },
    } as unknown as BundleRef;
    expect(brokeredRef(both)?.connectorId).toBe("new.id/mcp");
  });
});
