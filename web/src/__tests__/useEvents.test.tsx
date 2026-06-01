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
// @testing-library/react. We mock `../api/events-client` so the test
// drives the dispatch directly instead of trying to fake the SSE.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let reconnectHandler: (() => void) | null = null;
const subscribeMock = mock(() => () => {});
const onReconnectMock = mock((handler: () => void) => {
  reconnectHandler = handler;
  return () => {
    if (reconnectHandler === handler) reconnectHandler = null;
  };
});

mock.module("../api/events-client", () => ({
  subscribe: subscribeMock,
  onReconnect: onReconnectMock,
}));

const React = await import("react");
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
  reconnectHandler = null;
  subscribeMock.mockClear();
  onReconnectMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("useEvents", () => {
  test("registers an onReconnect subscription against the singleton", () => {
    const onReconnect = mock(() => {});
    act(() => {
      root.render(<Probe onReconnect={onReconnect} />);
    });

    expect(onReconnectMock).toHaveBeenCalledTimes(1);
    expect(reconnectHandler).not.toBeNull();
  });

  test("singleton onReconnect fires the consumer's onReconnect callback", () => {
    const onReconnect = mock(() => {});
    act(() => {
      root.render(<Probe onReconnect={onReconnect} />);
    });
    expect(reconnectHandler).not.toBeNull();

    // Simulate the singleton firing reconnect (as it does after a
    // successful re-establishment post-watchdog / visibility resume).
    reconnectHandler?.();

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
