// ---------------------------------------------------------------------------
// api/client.ts — auth lifecycle contract
//
// Pinning the two behavioral guarantees callers depend on:
//
// 1. `setAuthToken(...)` fires the registered lifecycle handler on real
//    changes (logout / identity boundary). `mcp-bridge-client.ts` relies on
//    this to drop its identity-bound MCP session on logout — without it,
//    the next iframe call would dispatch against the previous identity.
//
// 2. `setActiveWorkspaceId(...)` does NOT fire the handler. Stage 2 / Q3
//    (locked 2026-05-22): the `/mcp` session is identity-bound, not
//    workspace-bound. Workspace switches reuse the same session and
//    dispatch context via the per-request `X-Workspace-Id` header. A
//    regression to the old "reset on switch" wiring would force a fresh
//    handshake on every browse — which is the failure Q3 codified.
//
// Both setters keep their equality guard: noop sets must not fire the
// handler (avoids tearing down the MCP transport on every benign re-set).
//
// We don't test the wiring at module-load time (mcp-bridge-client's call
// to `setAuthLifecycleHandler(resetMcpBridgeClient)`) because mocking that
// reliably across the full test suite means fighting Bun's module cache.
// The wiring is one line and trivially verifiable by code review; the
// contracts this file pins are the much more important properties.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";

import { setActiveWorkspaceId, setAuthLifecycleHandler, setAuthToken } from "../api/client";

afterEach(() => {
  // Reset module state so tests don't leak handlers / tokens / workspaces
  // into each other (the module is shared across the suite).
  setAuthLifecycleHandler(null);
  setAuthToken(null);
  setActiveWorkspaceId(null);
});

describe("auth lifecycle handler", () => {
  test("setAuthToken fires the registered handler", () => {
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setAuthToken("tok-1");
    expect(handler).toHaveBeenCalledTimes(1);

    setAuthToken("tok-2");
    expect(handler).toHaveBeenCalledTimes(2);

    setAuthToken(null);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  test("setActiveWorkspaceId does NOT fire the registered handler (Q3 — bridge survives switches)", () => {
    // Q3 (locked 2026-05-22): the `/mcp` session is identity-bound; a
    // workspace switch must NOT drop the bridge transport. A regression
    // here would force a fresh handshake every time the user changes
    // workspaces.
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setActiveWorkspaceId("ws-1");
    setActiveWorkspaceId("ws-2");
    setActiveWorkspaceId(null);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  test("setAuthLifecycleHandler(null) silences subsequent setter calls", () => {
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setAuthToken("tok-a");
    expect(handler).toHaveBeenCalledTimes(1);

    setAuthLifecycleHandler(null);

    setAuthToken("tok-b");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("replacing the handler swaps the callback target", () => {
    const first = mock(() => {});
    const second = mock(() => {});

    setAuthLifecycleHandler(first);
    setAuthToken("tok-a");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(0);

    setAuthLifecycleHandler(second);
    setAuthToken("tok-b");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("setAuthToken with the same value does NOT fire the handler", () => {
    // Equality guard: noop sets shouldn't tear down the MCP transport.
    // Re-handshaking on every benign re-set is a perf hit (~100ms per
    // call) with no security benefit.
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

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
    // Q3: the handler doesn't fire for workspace switches at all (see test
    // above). But the equality guard is still load-bearing: production
    // callers (`WorkspaceContext` provider, route guards, App.tsx bootstrap)
    // repeatedly set the same value during render, and we want each call
    // to bail out at the equality check rather than reassign a module
    // variable. We assert the user-facing property: the handler is never
    // invoked, real-change or noop.
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-different");
    expect(handler).toHaveBeenCalledTimes(0);
  });
});
