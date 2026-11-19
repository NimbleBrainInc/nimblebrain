import { describe, expect, test } from "bun:test";
import { type ReturnedConnector, returnOutcome } from "./useConnectedNotice";

const granola = (state: ReturnedConnector["state"]): ReturnedConnector => ({
  serverName: "granola",
  displayName: "Granola",
  state,
});

describe("returnOutcome", () => {
  test("a connected connector is confirmed by its display name", () => {
    expect(returnOutcome("granola", [granola("connected")])).toEqual({
      kind: "connected",
      name: "Granola",
    });
  });

  test("waits while the token exchange is still settling", () => {
    expect(returnOutcome("granola", [granola("pending")])).toEqual({ kind: "wait" });
  });

  test("a connector that failed is reported, not confirmed", () => {
    expect(returnOutcome("granola", [granola("failed")])).toEqual({
      kind: "failed",
      name: "Granola",
    });
  });

  test("a name the page does not list announces nothing", () => {
    expect(returnOutcome("not-installed", [granola("connected")])).toEqual({ kind: "absent" });
  });

  test("falls back to the server name when there is no display name", () => {
    const bare = { serverName: "granola", displayName: "", state: "connected" as const };
    expect(returnOutcome("granola", [bare])).toEqual({ kind: "connected", name: "granola" });
  });
});
