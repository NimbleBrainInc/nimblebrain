import { beforeEach, describe, expect, it } from "bun:test";
import {
  _clearAll,
  peekFlowOwner,
  register,
  rejectFlow,
  resolveWithCode,
} from "../../src/tools/oauth-flow-registry.ts";

const WS = { kind: "workspace", wsId: "ws_test" } as const;

describe("oauth-flow-registry", () => {
  beforeEach(() => {
    _clearAll();
  });

  it("resolves a registered flow with the provided code", async () => {
    const p = register("state-abc", WS, "srv");
    expect(resolveWithCode("state-abc", "the-code")).toBe(true);
    await expect(p).resolves.toBe("the-code");
  });

  it("returns false for unknown state on resolve", () => {
    expect(resolveWithCode("unknown-state", "code")).toBe(false);
  });

  it("peekFlowOwner reads a workspace flow's owner without resolving it", async () => {
    // The callback peeks the owner to build the return URL before it resolves
    // (which deletes the flow). Peek must be read-only: the subsequent resolve
    // still finds the flow.
    const p = register("state-peek", { kind: "workspace", wsId: "ws_acme" }, "srv");
    expect(peekFlowOwner("state-peek")).toEqual({ kind: "workspace", wsId: "ws_acme" });
    // Still resolvable — peek didn't consume the flow.
    expect(resolveWithCode("state-peek", "code")).toBe(true);
    await expect(p).resolves.toBe("code");
    // Gone after resolve.
    expect(peekFlowOwner("state-peek")).toBeNull();
  });

  it("peekFlowOwner reads a user (identity-owned) flow's owner", async () => {
    const p = register("state-user", { kind: "user", userId: "usr_alice" }, "granola");
    expect(peekFlowOwner("state-user")).toEqual({ kind: "user", userId: "usr_alice" });
    expect(resolveWithCode("state-user", "code")).toBe(true);
    await expect(p).resolves.toBe("code");
  });

  it("peekFlowOwner returns null for an unknown state", () => {
    expect(peekFlowOwner("never-registered")).toBeNull();
  });

  it("rejects a registered flow with the provided error", async () => {
    const p = register("state-xyz", WS, "srv");
    const rejected = rejectFlow("state-xyz", new Error("boom"));
    expect(rejected).toBe(true);
    await expect(p).rejects.toThrow("boom");
  });

  it("removes the flow after resolve (second resolve is a no-op)", () => {
    register("state-1", WS, "srv");
    expect(resolveWithCode("state-1", "a")).toBe(true);
    expect(resolveWithCode("state-1", "b")).toBe(false);
  });

  it("rejects with a timeout error when TTL elapses without a callback", async () => {
    // Intra-process leaks are the concern: an orphaned pending flow (tab
    // closed, network failure) would keep a promise alive forever without
    // a TTL. Use a tiny TTL to exercise the timer path quickly.
    const p = register("state-ttl", WS, "srv", 20);
    await expect(p).rejects.toThrow(/timed out/i);
  });

  it("clearTimeout on resolve prevents late timer from firing stale reject", async () => {
    // Resolve first, then wait past the TTL boundary. The timer must be
    // cleared on resolve or we'd get an unhandled rejection from a late
    // fire on an already-settled flow.
    const p = register("state-resolved", WS, "srv", 30);
    resolveWithCode("state-resolved", "ok");
    await expect(p).resolves.toBe("ok");
    await new Promise((r) => setTimeout(r, 60));
    // If the timer had fired, `p` would have been re-rejected — but a
    // Promise is immutable once settled, so a late reject would only show
    // as an unhandled rejection. Absence of one (no diagnostic below) is
    // our positive signal here.
  });
});
