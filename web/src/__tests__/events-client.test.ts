// ---------------------------------------------------------------------------
// events-client.ts — workspace event stream singleton
//
// Injects a fake connector via `__internal__.setConnectorForTest` so tests
// don't touch the network. The fake exposes hooks to drive events / reconnects
// into the singleton and to count real `connectEvents` invocations, which is
// the property the whole refactor exists to enforce: N subscribers → 1
// connection.
//
// Why injection and not `mock.module("../api/sse")`: module mocks are
// process-global and only intercept the singleton's static `connectEvents`
// import if they register before events-client.ts is first evaluated. Another
// file importing events-client first (e.g. via a hook) leaves the mock a
// silent no-op — subscribe() then calls the real connector, connectCalls stays
// 0, and every assertion here fails. That ordering tracks filesystem
// enumeration order, so it flaked only on CI. Injecting on the one real module
// instance the test imports is deterministic regardless of load order.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setAuthLifecycleHandler, setAuthToken } from "../api/client";
import { __internal__, closeEventsClient, onReconnect, subscribe } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";

let connectCalls = 0;
let closeCalls = 0;
let lastOptions: ConnectEventsOptions | null = null;

class FakeConnection implements EventConnection {
  closed = false;
  close(): void {
    this.closed = true;
    closeCalls += 1;
  }
}

const liveConnections: FakeConnection[] = [];

function fakeConnectEvents(options: ConnectEventsOptions): EventConnection {
  connectCalls += 1;
  lastOptions = options;
  const conn = new FakeConnection();
  liveConnections.push(conn);
  // Fire onOpen async to mimic the real flow where onOpen runs after
  // headers come back. Tests that need open-state assert on this.
  queueMicrotask(() => {
    if (!conn.closed) options.onOpen?.();
  });
  return conn;
}

function resetCounters(): void {
  connectCalls = 0;
  closeCalls = 0;
  lastOptions = null;
  liveConnections.length = 0;
}

beforeEach(() => {
  resetCounters();
  setAuthLifecycleHandler(null);
  setAuthToken("tok-initial");
  __internal__.resetForTest();
  __internal__.setConnectorForTest(fakeConnectEvents);
});

afterEach(() => {
  __internal__.resetForTest();
  __internal__.setConnectorForTest(null);
  setAuthLifecycleHandler(null);
  setAuthToken(null);
});

describe("events-client — singleton transport", () => {
  test("first subscribe opens exactly one underlying connection", () => {
    subscribe("data.changed", () => {});
    expect(connectCalls).toBe(1);
    expect(__internal__.hasConnection()).toBe(true);
  });

  test("N subscribes across types share the same connection", () => {
    subscribe("data.changed", () => {});
    subscribe("config.changed", () => {});
    subscribe("bundle.installed", () => {});
    subscribe("data.changed", () => {}); // second handler for same type
    expect(connectCalls).toBe(1);
    expect(__internal__.subscriberCount()).toBe(4);
  });

  test("unsubscribe removes the handler but keeps the connection alive", () => {
    const unsub = subscribe("data.changed", () => {});
    expect(__internal__.hasConnection()).toBe(true);
    expect(__internal__.subscriberCount()).toBe(1);

    unsub();
    expect(__internal__.subscriberCount()).toBe(0);
    // Connection stays open — workspace stream is tab-life. The
    // alternative (close-on-zero) thrashes under StrictMode.
    expect(__internal__.hasConnection()).toBe(true);
    expect(closeCalls).toBe(0);
  });
});

describe("events-client — event routing", () => {
  test("event dispatch fans out to every subscriber of that type", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    const c = mock(() => {});
    subscribe("data.changed", a);
    subscribe("data.changed", b);
    subscribe("config.changed", c);

    // Drive an event through the fake's captured onEvent.
    lastOptions!.onEvent("data.changed", { server: "x", tool: "y" });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(0);
  });

  test("a throwing handler does not block other handlers for the same event", () => {
    const thrower = mock(() => {
      throw new Error("boom");
    });
    const good = mock(() => {});
    subscribe("data.changed", thrower);
    subscribe("data.changed", good);

    lastOptions!.onEvent("data.changed", { server: "x" });

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  test("events for types with no subscribers are dropped without error", () => {
    subscribe("data.changed", () => {});
    expect(() => lastOptions!.onEvent("skill.created", { id: "x" })).not.toThrow();
  });
});

describe("events-client — onReconnect", () => {
  test("fires every registered reconnect handler", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    subscribe("data.changed", () => {}); // ensure connection
    onReconnect(a);
    onReconnect(b);

    lastOptions!.onReconnect?.();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("unsubscribed reconnect handler does not fire", () => {
    const a = mock(() => {});
    subscribe("data.changed", () => {});
    const unsub = onReconnect(a);

    unsub();
    lastOptions!.onReconnect?.();

    expect(a).toHaveBeenCalledTimes(0);
  });
});

describe("events-client — auth lifecycle", () => {
  test("auth-lifecycle fire closes the existing connection", () => {
    subscribe("data.changed", () => {});
    expect(__internal__.hasConnection()).toBe(true);
    const initialConn = liveConnections[0];

    // setAuthToken(null) clears auth + fires the lifecycle. With no
    // token, the re-open guard skips reopening.
    setAuthToken(null);

    expect(initialConn?.closed).toBe(true);
    expect(__internal__.hasConnection()).toBe(false);
  });

  test("auth-lifecycle re-opens when subscribers remain AND token is present", () => {
    subscribe("data.changed", () => {});
    expect(connectCalls).toBe(1);

    // Rotate to a different non-null token — close + re-open under the
    // new identity. This is the post-refresh path.
    setAuthToken("tok-rotated");
    expect(connectCalls).toBe(2);
    expect(__internal__.hasConnection()).toBe(true);
    // The new fetch reads the rotated token.
    expect(lastOptions?.token).toBe("tok-rotated");
  });

  test("auth-lifecycle does NOT re-open after logout (token is null)", () => {
    subscribe("data.changed", () => {});
    expect(connectCalls).toBe(1);

    setAuthToken(null);
    expect(connectCalls).toBe(1);
    expect(__internal__.hasConnection()).toBe(false);
  });
});

describe("events-client — explicit close", () => {
  test("closeEventsClient drops the connection without removing subscribers", () => {
    subscribe("data.changed", () => {});
    expect(__internal__.subscriberCount()).toBe(1);
    expect(__internal__.hasConnection()).toBe(true);

    closeEventsClient();

    expect(__internal__.hasConnection()).toBe(false);
    expect(__internal__.subscriberCount()).toBe(1);
  });

  test("closeEventsClient is idempotent (safe with no connection)", () => {
    expect(() => closeEventsClient()).not.toThrow();
    expect(() => closeEventsClient()).not.toThrow();
    expect(closeCalls).toBe(0);
  });
});
