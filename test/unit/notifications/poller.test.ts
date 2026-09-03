/**
 * The poller, against a real MCP server on a real transport.
 *
 * Every test drives `sweep()` by hand and moves the poller's clock by hand.
 * What is under test is what one pass decides; a test that waited on the
 * jittered timer would be testing `setTimeout`, and one that waited out a
 * two-minute backoff would take two minutes. So the cadence is asserted the
 * only way it is observable from outside — a source that is not due is one the
 * fixture's read log does not grow for.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { readCursor } from "../../../src/notifications/cursors.ts";
import { resolvePollConfig } from "../../../src/notifications/poll-config.ts";
import { NotificationPoller, type PollTarget } from "../../../src/notifications/poller.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  FIXTURE_OUTBOX_URI,
  fixtureEvent,
  makeOutboxFixture,
  type OutboxFixture,
} from "../../helpers/outbox-fixture.ts";

/** Longer than any backoff a default-configured source reaches. */
const PAST_ANY_BACKOFF_MS = 600_000;

let workDir: string;
let workspaceStore: WorkspaceStore;
let wsId: string;
/** The poller's clock, advanced by hand so a cadence is asserted in one tick. */
let clock: number;
const teardown: Array<() => Promise<void>> = [];

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-poller-"));
  workspaceStore = new WorkspaceStore(workDir);
  wsId = (await workspaceStore.create("Poller")).id;
  clock = 1_800_000_000_000;
});

afterEach(async () => {
  for (const stop of teardown.splice(0)) await stop();
  rmSync(workDir, { recursive: true, force: true });
});

/** Move the poller's clock forward. */
function advance(ms: number): void {
  clock += ms;
}

function storeFor(id: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId: id, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

async function fixture(options?: Parameters<typeof makeOutboxFixture>[0]): Promise<OutboxFixture> {
  const made = await makeOutboxFixture(options);
  teardown.push(() => made.stop());
  return made;
}

function targetFor(outbox: OutboxFixture, id = wsId): PollTarget {
  return {
    wsId: id,
    serverName: outbox.source.name,
    resource: FIXTURE_OUTBOX_URI,
    source: outbox.source,
  };
}

/** A poller over a fixed target list, with the config overrides a test needs. */
function pollerOver(
  targets: PollTarget[],
  overrides: Parameters<typeof resolvePollConfig>[0] = {},
): NotificationPoller {
  const poller = new NotificationPoller({
    targets: async () => targets,
    storeFor,
    workspaceStore,
    config: resolvePollConfig(overrides),
    now: () => clock,
  });
  teardown.push(async () => poller.stop());
  return poller;
}

async function storedCursor(connector = "fixture-outbox"): Promise<string | undefined> {
  const ws = await workspaceStore.get(wsId);
  return ws ? readCursor(ws, connector) : undefined;
}

function eventIds(): string[] {
  return storeFor(wsId)
    .list()
    .map((item) => item.envelope.eventId)
    .sort();
}

describe("a sweep", () => {
  test("bootstraps, then writes events and advances the cursor", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)]);

    // Events that predate the first read are NOT delivered: a read with no
    // cursor establishes a position and returns nothing, so an inbox never
    // opens with a connector's entire history.
    outbox.emit(fixtureEvent("evt_before"));
    await poller.sweep();
    expect(eventIds()).toEqual([]);
    expect(outbox.reads[0]?.cursor).toBeUndefined();
    const bootstrapped = await storedCursor();
    expect(bootstrapped).toBeDefined();

    outbox.emit(fixtureEvent("evt_1"), fixtureEvent("evt_2"));
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep();

    expect(eventIds()).toEqual(["evt_1", "evt_2"]);
    expect(storeFor(wsId).list()[0]?.source).toBe("fixture-outbox");
    // The cursor is the server's own token, handed back verbatim — the runtime
    // never derives, parses or compares positions inside it.
    expect(outbox.reads[1]?.cursor).toBe(bootstrapped);
    expect(await storedCursor()).not.toBe(bootstrapped);
  });

  test("sends maxEvents and the replay bound on every read", async () => {
    const outbox = await fixture();
    await pollerOver([targetFor(outbox)], { maxEvents: 7 }).sweep();

    expect(outbox.reads[0]?.maxEvents).toBe(7);
    expect(outbox.reads[0]?.maxAgeMs).toBeGreaterThan(0);
  });

  test("dedupes across two sweeps", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)]);
    await poller.sweep();

    outbox.emit(fixtureEvent("evt_dup"));
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep();
    expect(eventIds()).toEqual(["evt_dup"]);

    // Rewind the stored position to what the last read was issued with, so the
    // outbox serves the same event again. At-least-once delivery does exactly
    // this, and the store's dedupe on `(source, eventId)` is what absorbs it.
    const replayed = outbox.reads[1]?.cursor;
    expect(replayed).toBeDefined();
    await workspaceStore.update(wsId, {
      notifications: { cursors: { "fixture-outbox": replayed as string } },
    });
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep();

    expect(outbox.reads).toHaveLength(3);
    expect(eventIds()).toEqual(["evt_dup"]);
  });

  test("reads nothing for a source that is not a target", async () => {
    const outbox = await fixture();
    // A connection that is not `running` under the workspace principal never
    // becomes a target — `collectPollTargets` decides that, so what the poller
    // sees is an empty list and what it must not do is go looking.
    const poller = pollerOver([]);
    outbox.emit(fixtureEvent("evt_1"));
    await poller.sweep();

    expect(outbox.reads).toHaveLength(0);
    expect(eventIds()).toEqual([]);
  });
});

describe("cadence", () => {
  test("empty polls back off, and a non-empty one snaps back to the base", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)], { intervalMs: 60_000 });

    await poller.sweep(); // empty → next read at +120s
    advance(60_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(1);

    advance(60_000);
    await poller.sweep(); // empty again → next read at +240s
    expect(outbox.reads).toHaveLength(2);
    advance(120_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(2);

    outbox.emit(fixtureEvent("evt_1"));
    advance(120_000);
    await poller.sweep(); // non-empty → back to the 60s base
    expect(outbox.reads).toHaveLength(3);

    advance(60_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(4);
  });

  test("honours a nextPollMs inside the clamp", async () => {
    const outbox = await fixture({ nextPollMs: 20_000 });
    const poller = pollerOver([targetFor(outbox)], { intervalMs: 60_000 });

    await poller.sweep();
    advance(19_000);
    await poller.sweep();
    // The recommendation beat the 120s the empty-poll backoff would have set,
    // and it is not yet elapsed.
    expect(outbox.reads).toHaveLength(1);

    advance(1_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(2);
  });

  test("clamps a nextPollMs below the floor up to it", async () => {
    const outbox = await fixture({ nextPollMs: 10 });
    const poller = pollerOver([targetFor(outbox)], { intervalMs: 60_000 });

    await poller.sweep();
    advance(14_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(1);

    advance(1_000); // 15s: the floor
    await poller.sweep();
    expect(outbox.reads).toHaveLength(2);
  });

  test("clamps a nextPollMs above the ceiling down to it", async () => {
    const outbox = await fixture({ nextPollMs: 86_400_000 });
    const poller = pollerOver([targetFor(outbox)], { maxIntervalMs: 60_000 });

    await poller.sweep();
    advance(59_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(1);

    advance(1_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(2);
  });
});

describe("hasMore", () => {
  test("re-reads at once, and stops when the budget is spent", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)], { maxEvents: 1, budgetPerMinute: 2 });
    await poller.sweep(); // bootstrap

    outbox.emit(fixtureEvent("evt_1"), fixtureEvent("evt_2"), fixtureEvent("evt_3"));
    advance(PAST_ANY_BACKOFF_MS); // also rolls the budget window
    await poller.sweep();

    // Two reads, both chained on `hasMore`, and then the budget stops it with a
    // third event still outstanding.
    expect(outbox.reads).toHaveLength(3);
    expect(eventIds()).toEqual(["evt_1", "evt_2"]);
  });
});

describe("the budget", () => {
  test("defers the sources it cannot reach", async () => {
    const a = await fixture({ name: "outbox-a" });
    const b = await fixture({ name: "outbox-b" });
    const c = await fixture({ name: "outbox-c" });
    const poller = pollerOver([targetFor(a), targetFor(b), targetFor(c)], { budgetPerMinute: 2 });

    await poller.sweep();

    expect(a.reads).toHaveLength(1);
    expect(b.reads).toHaveLength(1);
    expect(c.reads).toHaveLength(0);
  });

  test("round-robins, so a deferred source is not starved", async () => {
    const a = await fixture({ name: "outbox-a" });
    const b = await fixture({ name: "outbox-b" });
    const c = await fixture({ name: "outbox-c" });
    const poller = pollerOver([targetFor(a), targetFor(b), targetFor(c)], { budgetPerMinute: 1 });

    await poller.sweep();
    expect([a.reads.length, b.reads.length, c.reads.length]).toEqual([1, 0, 0]);

    // A minute later the budget window rolls. Name order alone would read `a`
    // again; the recorded resume point starts the pass at `b` instead.
    advance(60_001);
    await poller.sweep();
    expect([a.reads.length, b.reads.length, c.reads.length]).toEqual([1, 1, 0]);

    advance(60_001);
    await poller.sweep();
    expect([a.reads.length, b.reads.length, c.reads.length]).toEqual([1, 1, 1]);
  });
});

describe("failures", () => {
  test("a malformed body does not escape the sweep, and holds the cursor", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)]);
    await poller.sweep();
    const bootstrapped = await storedCursor();

    outbox.emit(fixtureEvent("evt_1"));
    outbox.answerMalformed(1);
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep(); // resolves; a failed poll is not a thrown one

    expect(await storedCursor()).toBe(bootstrapped);
    expect(eventIds()).toEqual([]);

    // And the event is still there to be read once the server recovers.
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep();
    expect(eventIds()).toEqual(["evt_1"]);
  });

  test("the breaker opens after consecutive failures and half-opens on the ceiling", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)], {
      intervalMs: 15_000,
      maxIntervalMs: 300_000,
    });
    outbox.answerMalformed(20);

    await poller.sweep(); // failure 1 → due in 30s
    advance(30_000);
    await poller.sweep(); // failure 2 → due in 60s
    advance(60_000);
    await poller.sweep(); // failure 3 → breaker opens for 300s
    expect(outbox.reads).toHaveLength(3);

    // The failure backoff alone would allow a read here; the breaker does not.
    advance(120_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(3);

    // One ceiling later it half-opens: exactly one read, and since that one
    // also fails, the breaker re-opens for another ceiling.
    advance(180_001);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(4);
    advance(120_000);
    await poller.sweep();
    expect(outbox.reads).toHaveLength(4);
  });

  test("a failed inbox write holds the cursor", async () => {
    const outbox = await fixture();
    const poller = new NotificationPoller({
      targets: async () => [targetFor(outbox)],
      storeFor: (id) =>
        new Proxy(storeFor(id), {
          get(target, prop, receiver) {
            if (prop === "append") {
              return () => {
                throw new Error("disk is full");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
      workspaceStore,
      config: resolvePollConfig(),
      now: () => clock,
    });
    teardown.push(async () => poller.stop());

    await poller.sweep(); // the bootstrap writes nothing, so it succeeds
    const bootstrapped = await storedCursor();
    expect(bootstrapped).toBeDefined();

    outbox.emit(fixtureEvent("evt_1"));
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep();

    // The write failed, so the position must not move past the event it lost.
    expect(await storedCursor()).toBe(bootstrapped);
  });
});

describe("truncated", () => {
  test("keeps the events that did arrive and keeps going", async () => {
    const outbox = await fixture();
    const poller = pollerOver([targetFor(outbox)]);
    await poller.sweep();

    outbox.setTruncated(true);
    outbox.emit(fixtureEvent("evt_1"));
    advance(PAST_ANY_BACKOFF_MS);
    await poller.sweep();

    // The gap is unrecoverable either way, so refusing the events that did
    // arrive would turn a partial loss into a total one.
    expect(eventIds()).toEqual(["evt_1"]);
  });
});

describe("the update hint", () => {
  test("subscribes when the server serves subscriptions, and reads on the push", async () => {
    const outbox = await fixture({ supportsSubscribe: true });
    const poller = pollerOver([targetFor(outbox)]);

    await poller.sweep(); // bootstrap, and arrange the hint
    await Bun.sleep(20);
    expect(outbox.subscriptions).toEqual([FIXTURE_OUTBOX_URI]);

    // The source is deep in its empty-poll backoff, so only the push can
    // explain a read here.
    outbox.emit(fixtureEvent("evt_pushed"));
    outbox.pushUpdate();
    await Bun.sleep(50);

    expect(eventIds()).toEqual(["evt_pushed"]);
  });

  test("sends no subscribe to a server that does not advertise one", async () => {
    const outbox = await fixture({ supportsSubscribe: false });
    const poller = pollerOver([targetFor(outbox)]);

    await poller.sweep();
    await Bun.sleep(20);

    expect(outbox.subscriptions).toEqual([]);
  });
});
