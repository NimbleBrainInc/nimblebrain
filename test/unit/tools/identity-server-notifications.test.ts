/**
 * Relaying a person's own apps' notifications to that person.
 *
 * A kernel identity source is one in-process server shared by every user, and
 * sits in no workspace registry. Its notification carries no user, so the host
 * names one when it announces, and the identity relay stamps the notification
 * with that user. The chain here is real where the attribution could break: an
 * in-process source whose server sends `notifications/resources/list_changed`
 * over the linked transport pair, heard by the handler `McpSource` registers.
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { serverNotificationsRelayedTotal } from "../../../src/api/metrics.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { defineInProcessApp, type InProcessResource } from "../../../src/tools/in-process-app.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import {
  announceResourceListChangedFor,
  createIdentityServerNotificationRelay,
  RELAY_COALESCE_WINDOW_MS,
  RESOURCES_LIST_CHANGED,
  relayIdentitySourceNotifications,
  type ServerNotification,
} from "../../../src/tools/server-notifications.ts";

const LIST_CHANGED: ServerNotification = { method: RESOURCES_LIST_CHANGED };

/** Notifications cross the in-memory transport pair on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordingSink(): { sink: EventSink; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { sink: { emit: (event) => events.push(event) }, events };
}

async function unattributedCount(): Promise<number> {
  const metric = await serverNotificationsRelayedTotal.get();
  return metric.values.find((v) => v.labels.outcome === "unattributed")?.value ?? 0;
}

let sources: McpSource[] = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const source of sources) await source.stop();
  sources = [];
});

/** A started in-process source that serves one resource, so it advertises `listChanged`. */
async function source(name: string): Promise<McpSource> {
  const resources = new Map<string, InProcessResource>([[`${name}://list`, "[]"]]);
  const started = defineInProcessApp(
    { name, version: "1.0.0", tools: [], resources },
    new NoopEventSink(),
  );
  await started.start();
  sources.push(started);
  return started;
}

describe("relayIdentitySourceNotifications", () => {
  test("an announcement reaches the user it names, and names no workspace", async () => {
    const { sink, events } = recordingSink();
    const files = await source("files");
    relayIdentitySourceNotifications([files], sink);

    announceResourceListChangedFor("usr_a", files);
    await settle();

    expect(events).toEqual([
      {
        type: "server.notification",
        data: { server: "files", userId: "usr_a", method: RESOURCES_LIST_CHANGED },
      },
    ]);
  });

  test("announcements for two users in flight together are each attributed to their own", async () => {
    // Both cross the transport before either handler runs, so an attribution
    // read from anything shared — rather than from each announcement's own
    // async context — would stamp both with whichever came last.
    const { sink, events } = recordingSink();
    const files = await source("files");
    relayIdentitySourceNotifications([files], sink);

    announceResourceListChangedFor("usr_a", files);
    announceResourceListChangedFor("usr_b", files);
    await settle();

    expect(events.map((e) => e.data.userId)).toEqual(["usr_a", "usr_b"]);
  });

  test("a notification that names no user is dropped, and counted", async () => {
    const { sink, events } = recordingSink();
    const files = await source("files");
    relayIdentitySourceNotifications([files], sink);
    const before = await unattributedCount();

    files.notifyResourceListChanged();
    await settle();

    expect(events).toEqual([]);
    expect((await unattributedCount()) - before).toBe(1);
  });

  test("only the identity sources are relayed from here", async () => {
    // A platform source that is not identity-owned sits in every workspace
    // registry; naming a user must not give it a path around that.
    const { sink, events } = recordingSink();
    const home = await source("home");
    relayIdentitySourceNotifications([home], sink);

    announceResourceListChangedFor("usr_a", home);
    await settle();

    expect(events).toEqual([]);
  });
});

describe("createIdentityServerNotificationRelay — the host sets the rate, per person", () => {
  /** A stand-in source whose announcement reaches the relay synchronously. */
  function relayed(): { announce: (userId: string) => void; events: EngineEvent[] } {
    const { sink, events } = recordingSink();
    const relay = createIdentityServerNotificationRelay(sink);
    const stub = { notifyResourceListChanged: () => relay("files", LIST_CHANGED) };
    return { announce: (userId) => announceResourceListChangedFor(userId, stub), events };
  }

  test("one person's flood does not collapse another person's announcement", () => {
    jest.useFakeTimers();
    const { announce, events } = relayed();

    for (let i = 0; i < 20; i++) announce("usr_a");
    announce("usr_b");

    expect(events.map((e) => e.data.userId)).toEqual(["usr_a", "usr_b"]);
  });

  test("one person's own announcements coalesce into a leading and a trailing delivery", () => {
    jest.useFakeTimers();
    const { announce, events } = relayed();

    for (let i = 0; i < 20; i++) announce("usr_a");
    expect(events).toHaveLength(1);

    jest.advanceTimersByTime(RELAY_COALESCE_WINDOW_MS);
    expect(events).toHaveLength(2);
    expect(events[1]?.data).toEqual({
      server: "files",
      userId: "usr_a",
      method: RESOURCES_LIST_CHANGED,
    });
  });
});
