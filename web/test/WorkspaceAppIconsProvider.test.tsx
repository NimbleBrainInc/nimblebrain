import { beforeEach, describe, expect, it, mock } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import type { SseEventType } from "../src/types";
import { realClient } from "./setup";

// ---------------------------------------------------------------------------
// Mocks
//
// The provider fans out two dependencies we intercept:
//   1. api/client.getInstalledConnectors — the manage_connectors RPC we're
//      counting. Issue #317: each Install click fired this 4-7×, the surplus
//      coming from SSE-driven refetches racing the click.
//   2. api/sse.connectEvents — we capture its `onEvent` callback so the test
//      can fire SSE events synchronously and assert which ones refetch.
// ---------------------------------------------------------------------------

const mockGetInstalled = mock(() => Promise.resolve({ installed: [], errors: [] }));

// Capture the latest onEvent handler registered via connectEvents so tests can
// drive SSE events directly.
let capturedOnEvent: (<K extends SseEventType>(type: K, data: unknown) => void) | null = null;
const mockConnectEvents = mock((opts: { onEvent: typeof capturedOnEvent }) => {
  capturedOnEvent = opts.onEvent;
  return { close: () => {} };
});

mock.module("../src/api/client", () => ({
  ...realClient,
  // Provider calls getInstalledConnectors({ scope: "workspace" }); the mock
  // ignores args (we only count invocations), so call it bare rather than
  // spreading an unused arg list.
  getInstalledConnectors: () => mockGetInstalled(),
}));

mock.module("../src/api/sse", () => ({
  connectEvents: (opts: { onEvent: typeof capturedOnEvent }) => mockConnectEvents(opts),
}));

// Imported after the mocks are registered so the provider's dependency graph
// binds to the stubs.
const { WorkspaceAppIconsProvider } = await import("../src/context/WorkspaceAppIconsProvider");

function fire(type: SseEventType, data: Record<string, unknown> = {}) {
  if (!capturedOnEvent) throw new Error("connectEvents.onEvent was never registered");
  act(() => {
    capturedOnEvent?.(type, data);
  });
}

describe("WorkspaceAppIconsProvider — SSE refetch surface (#317)", () => {
  beforeEach(() => {
    mockGetInstalled.mockClear();
    mockConnectEvents.mockClear();
    capturedOnEvent = null;
  });

  it("does NOT refetch installed connectors on connection.state_changed", async () => {
    render(
      <WorkspaceAppIconsProvider token="tok" workspaceId="ws-1">
        <div />
      </WorkspaceAppIconsProvider>,
    );

    // Initial mount fetch (provider's own workspace effect).
    await waitFor(() => expect(mockGetInstalled).toHaveBeenCalledTimes(1));

    // A bundle install drives the connection through starting → pending_auth →
    // running. Icons resolve from catalog/mpak metadata available at
    // bundle.installed time and do NOT depend on connection state, so none of
    // these transitions should re-hit manage_connectors. Pre-fix the provider
    // wired onConnectionStateChanged → refresh(), turning one click into a
    // 3-call burst here.
    fire("connection.state_changed", { state: "starting" });
    fire("connection.state_changed", { state: "pending_auth" });
    fire("connection.state_changed", { state: "running" });

    expect(mockGetInstalled).toHaveBeenCalledTimes(1);
  });

  it("still refetches on bundle.installed / bundle.uninstalled", async () => {
    render(
      <WorkspaceAppIconsProvider token="tok" workspaceId="ws-1">
        <div />
      </WorkspaceAppIconsProvider>,
    );

    await waitFor(() => expect(mockGetInstalled).toHaveBeenCalledTimes(1));

    // These genuinely add/remove an app — the icon set must be refetched.
    fire("bundle.installed", {});
    await waitFor(() => expect(mockGetInstalled).toHaveBeenCalledTimes(2));

    fire("bundle.uninstalled", {});
    await waitFor(() => expect(mockGetInstalled).toHaveBeenCalledTimes(3));
  });
});
