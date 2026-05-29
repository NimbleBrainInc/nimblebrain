import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
// binds to the stubs. The events-client import is dynamic for the same reason:
// it must resolve to the SAME singleton the provider subscribes through (whose
// `connectEvents` binding is our mock), so `resetForTest()` drops the very
// connection + subscriber set the provider shares.
const { WorkspaceAppIconsProvider } = await import("../src/context/WorkspaceAppIconsProvider");
const { __internal__: eventsClient } = await import("../src/api/events-client");

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
    // The events-client transport is a tab-lifetime singleton: it invokes the
    // mocked connectEvents() once, on the first subscribe, then reuses that
    // connection for every later subscribe. Without a reset between tests only
    // the first test captures onEvent — every subsequent test mounts against
    // the already-open singleton, connectEvents never re-runs, and
    // capturedOnEvent stays null (its `fire` then throws). Resetting drops the
    // connection and the shared subscriber set so each test re-opens (and
    // re-captures onEvent) with only its own provider subscribed.
    eventsClient.resetForTest();
  });

  afterEach(() => {
    // Unmount the provider so its SSE subscription doesn't survive into the
    // next test and double-fire refresh() (inflating the manage_connectors
    // count the assertions depend on).
    cleanup();
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
