/**
 * Relaying an app server's own notifications to that server's views.
 *
 * The server end is real where it matters: an in-process source whose MCP
 * server sends `notifications/resources/list_changed` over the linked transport
 * pair, so the handler under test is the one `McpSource` registers on its SDK
 * client. From there the chain is `McpSource` → `ToolRegistry` → the workspace
 * registry's relay → `server.notification` on the sink, which `SseEventManager`
 * delivers to the workspace's members (see `SSE_ROUTES`).
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { RESOURCE_SOURCE_META_KEY as RUNTIME_META_KEY } from "../../../src/api/mcp-server.ts";
import { serverNotificationsRelayedTotal } from "../../../src/api/metrics.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { createWorkspaceRegistry } from "../../../src/runtime/workspace-runtime.ts";
import { defineInProcessApp, type InProcessResource } from "../../../src/tools/in-process-app.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import { SharedSourceRef, ToolRegistry } from "../../../src/tools/registry.ts";
import {
  createServerNotificationRelay,
  MAX_RELAYED_PARAMS_BYTES,
  RELAY_COALESCE_WINDOW_MS,
  RELAYED_SERVER_NOTIFICATIONS,
  RESOURCES_LIST_CHANGED,
  relayableParams,
  type ServerNotification,
} from "../../../src/tools/server-notifications.ts";
import { RESOURCE_SOURCE_META_KEY as BRIDGE_META_KEY } from "../../../web/src/bridge/bridge.ts";
import {
  RELAYED_TO_VIEWS,
  serverCapabilities,
} from "../../../web/src/bridge/relayed-notifications.ts";

const WS = "ws_0123456789abcdef";
const OTHER_WS = "ws_fedcba9876543210";
const LIST_CHANGED: ServerNotification = { method: RESOURCES_LIST_CHANGED };

/** An in-process source that serves one resource, so it advertises `listChanged`. */
async function startResourceSource(name: string): Promise<McpSource> {
  const resources = new Map<string, InProcessResource>([["notes://list", "[]"]]);
  const source = defineInProcessApp(
    { name, version: "1.0.0", tools: [], resources },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

/** Notifications cross the in-memory transport pair on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordingSink(): { sink: EventSink; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { sink: { emit: (event) => events.push(event) }, events };
}

async function relayedCount(outcome: "forwarded" | "coalesced"): Promise<number> {
  const metric = await serverNotificationsRelayedTotal.get();
  return metric.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}

let sources: McpSource[] = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const source of sources) await source.stop();
  sources = [];
});

async function source(name: string): Promise<McpSource> {
  const started = await startResourceSource(name);
  sources.push(started);
  return started;
}

describe("the allowlist has one home", () => {
  test("the web shell relays exactly the methods the runtime relays", () => {
    expect([...RELAYED_TO_VIEWS].sort()).toEqual(Object.keys(RELAYED_SERVER_NOTIFICATIONS).sort());
  });

  test("the bridge advertises listChanged for each relayed method, and no other", () => {
    expect(serverCapabilities()).toEqual({
      serverTools: {},
      serverResources: { listChanged: true },
    });
  });

  test("the bridge and /mcp agree on the key that scopes a listing to one source", () => {
    expect(BRIDGE_META_KEY).toBe(RUNTIME_META_KEY);
  });
});

describe("relayableParams", () => {
  test("an object within the cap passes", () => {
    expect(relayableParams({ _meta: { a: 1 } })).toEqual({ _meta: { a: 1 } });
  });

  test("anything that is not an object is dropped", () => {
    for (const params of [undefined, null, "x", 3, ["a"]]) {
      expect(relayableParams(params)).toBeUndefined();
    }
  });

  test("an object over the cap is dropped", () => {
    expect(relayableParams({ blob: "x".repeat(MAX_RELAYED_PARAMS_BYTES) })).toBeUndefined();
  });
});

describe("McpSource — relayed server notifications", () => {
  test("a server-pushed list_changed reaches every subscriber, as the method it is", async () => {
    const notes = await source("notes");
    const heard: ServerNotification[] = [];
    notes.subscribeServerNotifications((n) => heard.push(n));

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual([LIST_CHANGED]);
  });

  test("an unsubscribed listener hears nothing more", async () => {
    const notes = await source("notes");
    let heard = 0;
    const unsubscribe = notes.subscribeServerNotifications(() => heard++);
    unsubscribe();

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(0);
  });

  test("the handlers are re-registered on the next Client, so a restart does not go quiet", async () => {
    // Handler tables live on the SDK Client and do not carry across instances.
    const notes = await source("notes");
    let heard = 0;
    notes.subscribeServerNotifications(() => heard++);

    await notes.stop();
    await notes.start();
    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(1);
  });

  test("a listener that throws does not stop the others", async () => {
    const notes = await source("notes");
    let heard = 0;
    notes.subscribeServerNotifications(() => {
      throw new Error("boom");
    });
    notes.subscribeServerNotifications(() => heard++);

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(1);
  });
});

describe("ToolRegistry — relayed server notifications", () => {
  test("reports the source's name and the notification to the registry listener", async () => {
    const registry = new ToolRegistry();
    const heard: Array<[string, ServerNotification]> = [];
    registry.setServerNotificationListener((name, n) => heard.push([name, n]));
    registry.addSource(await source("notes"));

    sources[0]?.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual([["notes", LIST_CHANGED]]);
  });

  test("a listener set after the source was added still hears it", async () => {
    const registry = new ToolRegistry();
    registry.addSource(await source("notes"));
    const heard: string[] = [];
    registry.setServerNotificationListener((name) => heard.push(name));

    sources[0]?.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual(["notes"]);
  });

  test("a removed source is detached", async () => {
    const registry = new ToolRegistry();
    const heard: string[] = [];
    registry.setServerNotificationListener((name) => heard.push(name));
    const notes = await source("notes");
    registry.addSource(notes);
    await registry.removeSource("notes");

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual([]);
  });

  test("a source added as shared is not relayed", async () => {
    const registry = new ToolRegistry();
    const heard: string[] = [];
    registry.setServerNotificationListener((name) => heard.push(name));
    registry.addSource(await source("notes"), { shared: true });

    sources[0]?.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual([]);
  });

  test("a SharedSourceRef is not relayed: it belongs to no one workspace", async () => {
    const registry = new ToolRegistry();
    const heard: string[] = [];
    registry.setServerNotificationListener((name) => heard.push(name));
    const notes = await source("notes");
    registry.addSource(new SharedSourceRef(notes));

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual([]);
  });
});

describe("createWorkspaceRegistry — the relay", () => {
  test("a workspace's own source is relayed as server.notification, stamped with the workspace", async () => {
    const { sink, events } = recordingSink();
    const registry = createWorkspaceRegistry(WS, [], null, sink);
    registry.addSource(await source("notes"));
    events.length = 0;

    sources[0]?.notifyResourceListChanged();
    await settle();

    expect(events).toEqual([
      {
        type: "server.notification",
        data: { server: "notes", workspaceId: WS, method: RESOURCES_LIST_CHANGED },
      },
    ]);
  });

  test("a platform source shared by every workspace reaches no workspace", async () => {
    // One source object sits in every workspace registry, and its notification
    // cannot say which workspace it concerns — so none of them relays it.
    const { sink, events } = recordingSink();
    const shared = await source("notes");
    createWorkspaceRegistry(WS, [shared], null, sink);
    createWorkspaceRegistry(OTHER_WS, [shared], null, sink);
    events.length = 0;

    shared.notifyResourceListChanged();
    await settle();

    expect(events).toEqual([]);
  });
});

describe("createServerNotificationRelay — the host sets the rate", () => {
  function relayInto(): { relay: ReturnType<typeof createServerNotificationRelay>; events: EngineEvent[] } {
    const { sink, events } = recordingSink();
    return { relay: createServerNotificationRelay(WS, sink), events };
  }

  test("the first notification is delivered at once", () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();

    relay("notes", LIST_CHANGED);

    expect(events).toHaveLength(1);
  });

  test("a flood inside one window is one leading and one trailing delivery", async () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();
    const forwardedBefore = await relayedCount("forwarded");
    const coalescedBefore = await relayedCount("coalesced");

    for (let i = 0; i < 50; i++) relay("notes", LIST_CHANGED);
    expect(events).toHaveLength(1);

    jest.advanceTimersByTime(RELAY_COALESCE_WINDOW_MS);
    expect(events).toHaveLength(2);

    jest.advanceTimersByTime(RELAY_COALESCE_WINDOW_MS * 4);
    expect(events).toHaveLength(2);
    expect((await relayedCount("forwarded")) - forwardedBefore).toBe(2);
    expect((await relayedCount("coalesced")) - coalescedBefore).toBe(49);
  });

  test("a server still announcing gets one delivery per window, for as long as it keeps on", () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();

    relay("notes", LIST_CHANGED);
    for (let window = 0; window < 3; window++) {
      relay("notes", LIST_CHANGED);
      jest.advanceTimersByTime(RELAY_COALESCE_WINDOW_MS);
    }

    expect(events).toHaveLength(4);
  });

  test("a single announcement opens a window that closes quietly", () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();

    relay("notes", LIST_CHANGED);
    jest.advanceTimersByTime(RELAY_COALESCE_WINDOW_MS);
    relay("notes", LIST_CHANGED);

    expect(events).toHaveLength(2);
  });

  test("windows are per server: one server's flood does not hold back another's", () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();

    relay("notes", LIST_CHANGED);
    relay("tasks", LIST_CHANGED);

    expect(events.map((e) => e.data.server)).toEqual(["notes", "tasks"]);
  });

  test("nothing is relayed for a server that can have no views", () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();

    relay("nb", LIST_CHANGED);
    relay("my_gmail", LIST_CHANGED);

    expect(events).toEqual([]);
  });

  test("the trailing delivery carries the latest params", () => {
    jest.useFakeTimers();
    const { relay, events } = relayInto();

    relay("notes", LIST_CHANGED);
    relay("notes", { method: RESOURCES_LIST_CHANGED, params: { _meta: { n: 1 } } });
    relay("notes", { method: RESOURCES_LIST_CHANGED, params: { _meta: { n: 2 } } });
    jest.advanceTimersByTime(RELAY_COALESCE_WINDOW_MS);

    expect(events[1]?.data.params).toEqual({ _meta: { n: 2 } });
  });
});
