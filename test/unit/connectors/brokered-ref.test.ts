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
import { brokeredRef } from "../../../src/connectors/runtime/brokered.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";

describe("brokeredRef", () => {
  it("reads the brokered block a current install persists", () => {
    const ref: ConnectorRef = {
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
    expect(
      brokeredRef({ url: "https://mcp.notion.com/mcp", serverName: "com-notion-mcp" }),
    ).toBeUndefined();
    expect(brokeredRef(undefined)).toBeUndefined();
  });
});
