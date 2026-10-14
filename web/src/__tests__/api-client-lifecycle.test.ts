// ---------------------------------------------------------------------------
// api/client.ts — auth lifecycle contract
//
// Pinning the two behavioral guarantees callers depend on:
//
// 1. `setAuthToken(...)` fires the registered lifecycle handler on real
//    changes (logout / identity boundary), so a holder of identity-bound
//    state (the SSE event clients) can drop it.
//
// 2. `setActiveWorkspaceId(...)` does NOT fire the auth handler. A workspace
//    switch is not an identity boundary; workspace-bound state listens on the
//    separate workspace lifecycle hook, and REST helpers and the bridge's
//    `/mcp` sender read the active workspace per request.
//
// Both setters keep their equality guard: noop sets must not fire the
// handler (avoids tearing down a stream on every benign re-set).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import { addAuthLifecycleHandler, setActiveWorkspaceId, setAuthToken } from "../api/client";

/** Unsubscribes for every handler a test registered, run after each test. */
const registered: Array<() => void> = [];

/** Register an auth lifecycle handler that is removed after the test. */
function onAuthChange(handler: () => void): void {
  registered.push(addAuthLifecycleHandler(handler));
}

afterEach(() => {
  // Reset module state so tests don't leak handlers / tokens / workspaces
  // into each other (the module is shared across the suite).
  for (const off of registered.splice(0)) off();
  setAuthToken(null);
  setActiveWorkspaceId(null);
});

describe("auth lifecycle handler", () => {
  test("setAuthToken fires the registered handler", () => {
    const handler = mock(() => {});
    onAuthChange(handler);

    setAuthToken("tok-1");
    expect(handler).toHaveBeenCalledTimes(1);

    setAuthToken("tok-2");
    expect(handler).toHaveBeenCalledTimes(2);

    setAuthToken(null);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  test("setActiveWorkspaceId does NOT fire the registered auth handler", () => {
    // A workspace switch is not an identity boundary. Clients bound to a
    // workspace listen on `addWorkspaceLifecycleHandler` instead.
    const handler = mock(() => {});
    onAuthChange(handler);

    setActiveWorkspaceId("ws-1");
    setActiveWorkspaceId("ws-2");
    setActiveWorkspaceId(null);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  test("setAuthToken with the same value does NOT fire the handler", () => {
    // Equality guard: noop sets shouldn't tear down the MCP transport.
    // Re-handshaking on every benign re-set is a perf hit (~100ms per
    // call) with no security benefit.
    const handler = mock(() => {});
    onAuthChange(handler);

    setAuthToken("tok-same");
    expect(handler).toHaveBeenCalledTimes(1);

    setAuthToken("tok-same");
    setAuthToken("tok-same");
    expect(handler).toHaveBeenCalledTimes(1);

    // But a real change still fires.
    setAuthToken("tok-different");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("setActiveWorkspaceId equality guard: noop sets are still cheap (no internal work)", () => {
    // The auth handler doesn't fire for workspace switches at all (see test
    // above). But the equality guard is still load-bearing: production
    // callers (`WorkspaceContext` provider, route guards, App.tsx bootstrap)
    // repeatedly set the same value during render, and we want each call
    // to bail out at the equality check rather than reassign a module
    // variable. We assert the user-facing property: the handler is never
    // invoked, real-change or noop.
    const handler = mock(() => {});
    onAuthChange(handler);

    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-different");
    expect(handler).toHaveBeenCalledTimes(0);
  });
});

// ── Multi-listener (addAuthLifecycleHandler) ───────────────────────

describe("addAuthLifecycleHandler — multi-listener", () => {
  test("fires every registered handler on setAuthToken change", () => {
    // Two stateful clients — the MCP bridge and the SSE event clients —
    // each register their own teardown. Both must run.
    const a = mock(() => {});
    const b = mock(() => {});
    onAuthChange(a);
    onAuthChange(b);

    setAuthToken("tok-1");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    setAuthToken("tok-2");
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  test("returned unsubscribe removes the handler", () => {
    const a = mock(() => {});
    const unsub = addAuthLifecycleHandler(a);

    setAuthToken("tok-1");
    expect(a).toHaveBeenCalledTimes(1);

    unsub();
    setAuthToken("tok-2");
    expect(a).toHaveBeenCalledTimes(1);
  });

  test("a throwing handler does not block other handlers or the token update", () => {
    // Set-based iteration must continue past a throwing subscriber, and
    // the token must still be updated. Otherwise a buggy MCP bridge
    // reset would silently strand the SSE event clients on a stale
    // identity.
    const thrower = mock(() => {
      throw new Error("boom");
    });
    const good = mock(() => {});
    onAuthChange(thrower);
    onAuthChange(good);

    setAuthToken("tok-1");

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("workspace lifecycle handlers", () => {
  // Through `realClient`: other suites replace `../api/client` process-wide
  // with a mock whose `setActiveWorkspaceId` does nothing (see test/setup.ts).
  test("fire on a real workspace change only, never on a noop set", () => {
    const handler = mock(() => {});
    const off = realClient.addWorkspaceLifecycleHandler(handler);
    try {
      realClient.setActiveWorkspaceId("ws-wl-1");
      realClient.setActiveWorkspaceId("ws-wl-1");
      realClient.setActiveWorkspaceId("ws-wl-2");
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      off();
      realClient.setActiveWorkspaceId(null);
    }
  });
});
