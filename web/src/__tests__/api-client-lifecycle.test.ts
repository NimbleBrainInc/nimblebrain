// ---------------------------------------------------------------------------
// api/client.ts — auth lifecycle contract
//
// Pinning the only behavioral guarantee callers depend on: every
// `setAuthToken(...)` and `setActiveWorkspaceId(...)` fires the registered
// lifecycle handler. That contract is what `mcp-bridge-client.ts` relies on
// to drop its workspace-bound MCP session when the user switches workspaces
// or logs out — without it, the next iframe call would dispatch against
// the previous tenant's session.
//
// We don't test the wiring at module-load time (mcp-bridge-client's call
// to `setAuthLifecycleHandler(resetMcpBridgeClient)`) because mocking that
// reliably across the full test suite means fighting Bun's module cache.
// The wiring is one line and trivially verifiable by code review; the
// contract this file pins is the much more important property — that
// when production code calls `setAuthToken`, the handler runs.
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

  test("setActiveWorkspaceId fires the registered handler", () => {
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setActiveWorkspaceId("ws-1");
    expect(handler).toHaveBeenCalledTimes(1);

    setActiveWorkspaceId("ws-2");
    expect(handler).toHaveBeenCalledTimes(2);

    setActiveWorkspaceId(null);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  test("setAuthLifecycleHandler(null) silences subsequent setter calls", () => {
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setAuthToken("tok-a");
    expect(handler).toHaveBeenCalledTimes(1);

    setAuthLifecycleHandler(null);

    setAuthToken("tok-b");
    setActiveWorkspaceId("ws-x");
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

  test("setActiveWorkspaceId with the same value does NOT fire the handler", () => {
    const handler = mock(() => {});
    setAuthLifecycleHandler(handler);

    setActiveWorkspaceId("ws-same");
    expect(handler).toHaveBeenCalledTimes(1);

    setActiveWorkspaceId("ws-same");
    setActiveWorkspaceId("ws-same");
    expect(handler).toHaveBeenCalledTimes(1);

    setActiveWorkspaceId("ws-different");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
