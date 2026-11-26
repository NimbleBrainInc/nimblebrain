import { beforeEach, describe, expect, it } from "bun:test";
import {
  _clearAllConnectFlows,
  type ConnectFlow,
  consumeConnectFlow,
  peekConnectFlow,
  registerConnectFlow,
} from "../../src/connectors/providers/composio/connect-flow-registry.ts";

const WS = { type: "workspace", wsId: "ws_0076759dbbe19fcc" } as const;
const USR = { type: "user", userId: "usr_test" } as const;
const BINDING = "a".repeat(64);

function flow(owner: ConnectFlow["owner"], connectorId: string): ConnectFlow {
  return { owner, connectorId, connectedAccountId: "ca_linked", bindingHash: BINDING };
}

describe("composio connect-flow-registry", () => {
  beforeEach(() => {
    _clearAllConnectFlows();
  });

  it("consumes a registered flow, returning what its initiate recorded", () => {
    registerConnectFlow("nonce-a", flow(WS, "com.google/gmail"));
    expect(consumeConnectFlow("nonce-a")).toEqual({
      owner: WS,
      connectorId: "com.google/gmail",
      connectedAccountId: "ca_linked",
      bindingHash: BINDING,
    });
  });

  it("preserves a user owner and its return target verbatim", () => {
    registerConnectFlow("nonce-u", {
      ...flow(USR, "com.slack/slack"),
      returnWsId: WS.wsId,
      returnConversationId: "conv_00000000000000a1",
    });
    expect(consumeConnectFlow("nonce-u")).toMatchObject({
      owner: USR,
      connectorId: "com.slack/slack",
      returnWsId: WS.wsId,
      returnConversationId: "conv_00000000000000a1",
    });
  });

  it("peek reads a flow without consuming it", () => {
    registerConnectFlow("nonce-p", flow(WS, "com.google/gmail"));
    expect(peekConnectFlow("nonce-p")?.bindingHash).toBe(BINDING);
    expect(consumeConnectFlow("nonce-p")).not.toBeNull();
    expect(peekConnectFlow("nonce-p")).toBeNull();
  });

  it("returns null for an unknown nonce (the anti-forgery gate)", () => {
    expect(consumeConnectFlow("never-registered")).toBeNull();
  });

  it("is one-shot: a second consume of the same nonce returns null", () => {
    registerConnectFlow("nonce-b", flow(WS, "com.google/gmail"));
    expect(consumeConnectFlow("nonce-b")).not.toBeNull();
    expect(consumeConnectFlow("nonce-b")).toBeNull();
  });

  it("does not resolve one nonce's record under a different nonce", () => {
    registerConnectFlow("nonce-c", flow(WS, "com.google/gmail"));
    expect(consumeConnectFlow("nonce-c-other")).toBeNull();
    // The real record is still intact for its own nonce.
    expect(consumeConnectFlow("nonce-c")).not.toBeNull();
  });

  it("reclaims a flow once its TTL fires — a slow return leg is then rejected", async () => {
    registerConnectFlow("nonce-ttl", flow(WS, "com.google/gmail"), { ttlMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(consumeConnectFlow("nonce-ttl")).toBeNull();
  });

  it("_clearAllConnectFlows drops every pending flow", () => {
    registerConnectFlow("n1", flow(WS, "com.google/gmail"));
    registerConnectFlow("n2", flow(USR, "com.slack/slack"));
    _clearAllConnectFlows();
    expect(consumeConnectFlow("n1")).toBeNull();
    expect(consumeConnectFlow("n2")).toBeNull();
  });
});
