// ---------------------------------------------------------------------------
// useEvents — hook wiring contract
//
// Pins the regression QA caught on the singleton landing PR: the hook
// must wire its `onReconnect` option through to the singleton's
// `onReconnect` channel. Without this, a watchdog/visibility-driven
// reconnect silently resumes the stream and any state derived from
// missed `bundle.installed` / `config.changed` events drifts.
//
// Same shape as the other hook tests in this directory — bun:test +
// react-dom/client + happy-dom (via web/test/setup.ts), no
// @testing-library/react.
//
// We drive the REAL events-client singleton and inject a fake connector
// via `__internal__.setConnectorForTest` — NOT `mock.module("../api/events-client")`.
// A module mock here is process-global and persistent across the whole
// `bun test` run; it merges over the real module, leaving `subscribe`
// stubbed for any file that loads after this one. `events-client.test.ts`
// then sees a no-op `subscribe` (connectCalls stays 0, every assertion
// fails) whenever bun's filesystem enumeration happens to run this file
// first — which it does on CI (Linux) but not locally (macOS). Injecting
// on the single shared module instance is deterministic regardless of
// load order and exercises the real hook → singleton → reconnect wiring.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { __internal__ } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The options the singleton handed to the connector on open. The
// connector-level `onReconnect` is the singleton's internal fan-out to
// every handler registered via `onReconnect(...)` — firing it is how we
// simulate a post-watchdog re-establishment.
let lastOptions: ConnectEventsOptions | null = null;

class FakeConnection implements EventConnection {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

function fakeConnectEvents(options: ConnectEventsOptions): EventConnection {
  lastOptions = options;
  return new FakeConnection();
}

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { useEvents } = await import("../hooks/useEvents");

function Probe(props: { onReconnect: () => void }): null {
  useEvents("tok", undefined, { onReconnect: props.onReconnect });
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

beforeEach(() => {
  lastOptions = null;
  __internal__.resetForTest();
  __internal__.setConnectorForTest(fakeConnectEvents);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  __internal__.resetForTest();
  __internal__.setConnectorForTest(null);
});

describe("useEvents", () => {
  test("subscribes through the shared singleton (one connection)", () => {
    const onReconnect = mock(() => {});
    act(() => {
      root.render(<Probe onReconnect={onReconnect} />);
    });

    // The hook opened exactly one underlying connection and registered
    // its subscriptions on the singleton: six event types + onReconnect.
    expect(__internal__.hasConnection()).toBe(true);
    expect(__internal__.subscriberCount()).toBe(7);
  });

  test("singleton reconnect fires the consumer's onReconnect, and unmount unregisters it", () => {
    const onReconnect = mock(() => {});
    act(() => {
      root.render(<Probe onReconnect={onReconnect} />);
    });
    expect(lastOptions!.onReconnect).toBeDefined();

    // Simulate the singleton firing reconnect (as it does after a
    // successful re-establishment post-watchdog / visibility resume).
    lastOptions?.onReconnect?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // Unmount removes the subscription — a later reconnect is a no-op.
    act(() => {
      root.unmount();
    });
    lastOptions?.onReconnect?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
