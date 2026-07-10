import { beforeEach, describe, expect, it } from "bun:test";
import {
  _clearAllConnectFlows,
  consumeConnectFlow,
  registerConnectFlow,
} from "../../src/composio/connect-flow-registry.ts";

const WS = { type: "workspace", wsId: "ws_test" } as const;
const USR = { type: "user", userId: "usr_test" } as const;

describe("composio connect-flow-registry", () => {
  beforeEach(() => {
    _clearAllConnectFlows();
  });

  it("consumes a registered flow, returning its trusted owner + connectorId", () => {
    registerConnectFlow("nonce-a", WS, "com.google/gmail");
    expect(consumeConnectFlow("nonce-a")).toEqual({
      owner: WS,
      connectorId: "com.google/gmail",
    });
  });

  it("preserves a user owner verbatim", () => {
    registerConnectFlow("nonce-u", USR, "com.slack/slack");
    expect(consumeConnectFlow("nonce-u")).toEqual({
      owner: USR,
      connectorId: "com.slack/slack",
    });
  });

  it("returns null for an unknown nonce (the anti-forgery gate)", () => {
    expect(consumeConnectFlow("never-registered")).toBeNull();
  });

  it("is one-shot: a second consume of the same nonce returns null", () => {
    registerConnectFlow("nonce-b", WS, "com.google/gmail");
    expect(consumeConnectFlow("nonce-b")).not.toBeNull();
    expect(consumeConnectFlow("nonce-b")).toBeNull();
  });

  it("does not resolve one nonce's record under a different nonce", () => {
    registerConnectFlow("nonce-c", WS, "com.google/gmail");
    expect(consumeConnectFlow("nonce-c-other")).toBeNull();
    // The real record is still intact for its own nonce.
    expect(consumeConnectFlow("nonce-c")).not.toBeNull();
  });

  it("reclaims a flow once its TTL fires — a slow return leg is then rejected", async () => {
    registerConnectFlow("nonce-ttl", WS, "com.google/gmail", 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(consumeConnectFlow("nonce-ttl")).toBeNull();
  });

  it("_clearAllConnectFlows drops every pending flow", () => {
    registerConnectFlow("n1", WS, "com.google/gmail");
    registerConnectFlow("n2", USR, "com.slack/slack");
    _clearAllConnectFlows();
    expect(consumeConnectFlow("n1")).toBeNull();
    expect(consumeConnectFlow("n2")).toBeNull();
  });
});
