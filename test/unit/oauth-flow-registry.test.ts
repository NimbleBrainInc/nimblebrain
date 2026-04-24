import { beforeEach, describe, expect, it } from "bun:test";
import {
  _clearAll,
  register,
  rejectFlow,
  resolveWithCode,
} from "../../src/tools/oauth-flow-registry.ts";

describe("oauth-flow-registry", () => {
  beforeEach(() => {
    _clearAll();
  });

  it("resolves a registered flow with the provided code", async () => {
    const p = register("state-abc", "ws_test", "srv");
    const matched = resolveWithCode("state-abc", "the-code");
    expect(matched).toBe(true);
    await expect(p).resolves.toBe("the-code");
  });

  it("returns false for unknown state on resolve", () => {
    const matched = resolveWithCode("unknown-state", "code");
    expect(matched).toBe(false);
  });

  it("rejects a registered flow with the provided error", async () => {
    const p = register("state-xyz", "ws_test", "srv");
    const rejected = rejectFlow("state-xyz", new Error("boom"));
    expect(rejected).toBe(true);
    await expect(p).rejects.toThrow("boom");
  });

  it("removes the flow after resolve (second resolve is a no-op)", () => {
    register("state-1", "ws_test", "srv");
    expect(resolveWithCode("state-1", "a")).toBe(true);
    expect(resolveWithCode("state-1", "b")).toBe(false);
  });

  it("rejects with a timeout error when TTL elapses without a callback", async () => {
    // Intra-process leaks are the concern: an orphaned pending flow (tab
    // closed, network failure) would keep a promise alive forever without
    // a TTL. Use a tiny TTL to exercise the timer path quickly.
    const p = register("state-ttl", "ws_test", "srv", 20);
    await expect(p).rejects.toThrow(/timed out/i);
  });

  it("clearTimeout on resolve prevents late timer from firing stale reject", async () => {
    // Resolve first, then wait past the TTL boundary. The timer must be
    // cleared on resolve or we'd get an unhandled rejection from a late
    // fire on an already-settled flow.
    const p = register("state-resolved", "ws_test", "srv", 30);
    resolveWithCode("state-resolved", "ok");
    await expect(p).resolves.toBe("ok");
    await new Promise((r) => setTimeout(r, 60));
    // If the timer had fired, `p` would have been re-rejected — but a
    // Promise is immutable once settled, so a late reject would only show
    // as an unhandled rejection. Absence of one (no diagnostic below) is
    // our positive signal here.
  });
});
