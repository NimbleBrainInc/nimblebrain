/**
 * The route dispatcher — matching, delivery, the ledger and the retry bound.
 *
 * Everything here runs against a real `NotificationStore` on a real temp
 * directory, because the ledger IS the retry state: a test that held it in
 * memory would prove nothing about the restart this slice promises. The
 * unattended door is a recording stub — what is under test is what this module
 * does with the door's answers, and re-deriving that split here rather than
 * reading it is the mistake the tests exist to catch.
 *
 * The clock is moved by hand. A test that waited out the five-minute retry
 * bound would take five minutes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import type {
  UnattendedDispatchOptions,
  UnattendedDispatchResult,
} from "../../../src/orchestrator/unattended-dispatch.ts";
import { parseNotificationEnvelope } from "../../../src/notifications/envelope.ts";
import {
  RouteDispatcher,
  type RouteDispatcherDeps,
  RETRY_TICK_MS,
} from "../../../src/notifications/routes.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import { clampLevel, type Notification } from "../../../src/notifications/types.ts";
import type {
  DeliveryRecord,
  NotificationLevel,
} from "../../../src/tools/platform/schemas/notifications.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

const SOURCE = "precision-outbound";
const AUTHOR = "usr_admin";
const TOOL = "slack__send_message";

let workDir: string;
let workspaceStore: WorkspaceStore;
let wsId: string;
let clock: number;
/** Every call the dispatcher made through the unattended door, in order. */
let calls: UnattendedDispatchOptions[];
/** Answers the stub returns, oldest first; the last one repeats. */
let answers: UnattendedDispatchResult[];
let events: EngineEvent[];
const teardown: Array<() => void> = [];

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-routes-"));
  workspaceStore = new WorkspaceStore(workDir);
  wsId = (await workspaceStore.create("Routes")).id;
  clock = 1_800_000_000_000;
  calls = [];
  answers = [{ outcome: "ok" }];
  events = [];
});

afterEach(() => {
  for (const stop of teardown.splice(0)) stop();
  rmSync(workDir, { recursive: true, force: true });
});

function advance(ms: number): void {
  clock += ms;
}

const recordingSink: EventSink = {
  emit: (event) => {
    events.push(event);
  },
};

function storeFor(id: string): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId: id, workDir }), {
    eventSink: new NoopEventSink(),
  });
}

function dispatcher(overrides: Partial<RouteDispatcherDeps> = {}): RouteDispatcher {
  const made = new RouteDispatcher({
    workspaceStore,
    storeFor,
    workspaceIds: async () => (await workspaceStore.list()).map((ws) => ws.id),
    eventSink: recordingSink,
    now: () => clock,
    dispatch: async (opts) => {
      calls.push(opts);
      return answers.length > 1 ? (answers.shift() as UnattendedDispatchResult) : answers[0]!;
    },
    ...overrides,
  });
  teardown.push(() => made.stop());
  return made;
}

/** Write the workspace's notifications block: ceilings and routes. */
async function configure(block: Record<string, unknown>): Promise<void> {
  await workspaceStore.update(wsId, { notifications: block } as never);
}

/** One route delivering to `TOOL`, with the match and input a test needs. */
function toolRoute(
  match: Record<string, unknown> = {},
  input: Record<string, unknown> = { channel: "#outbound", text: "{{title}}" },
  id = "rt_slack",
): Record<string, unknown> {
  return { id, createdBy: AUTHOR, match, deliver: [{ kind: "tool", tool: TOOL, input }] };
}

/** Put one envelope in the inbox at the level the workspace's ceiling allows. */
function seed(
  name = "domain.active",
  level: NotificationLevel = "attention",
  eventId = `evt_${name}_${level}`,
): Notification {
  const envelope = parseNotificationEnvelope({
    eventId,
    name,
    timestamp: "2026-09-01T18:42:10Z",
    data: { domain: "acme-outreach.com" },
    _meta: {
      "ai.nimblebrain/notification": { level, title: "acme-outreach.com is active" },
    },
  });
  if (!envelope) throw new Error("fixture did not parse");
  return storeFor(wsId).append(SOURCE, envelope).item;
}

/**
 * Seed an item whose stored effective level is the workspace ceiling applied
 * to `level` — the poller's job, done here so a ledger assertion reads against
 * the same number the poller would have stamped.
 */
async function seedClamped(level: NotificationLevel, name = "domain.active"): Promise<Notification> {
  const ws = await workspaceStore.get(wsId);
  const ceiling =
    ((ws?.notifications as { sources?: Record<string, { maxLevel: NotificationLevel }> } | undefined)
      ?.sources?.[SOURCE]?.maxLevel as NotificationLevel | undefined) ?? "info";
  const envelope = parseNotificationEnvelope({
    eventId: `evt_${name}_${level}`,
    name,
    timestamp: "2026-09-01T18:42:10Z",
    data: {},
    _meta: { "ai.nimblebrain/notification": { level, title: "t" } },
  });
  if (!envelope) throw new Error("fixture did not parse");
  return storeFor(wsId).append(SOURCE, envelope, clampLevel(level, ceiling)).item;
}

/** The ledger on one item, re-read from disk. */
function ledger(item: Notification): DeliveryRecord[] {
  return storeFor(wsId).get(item.source, item.envelope.eventId)?.deliveries ?? [];
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return events.filter((e) => e.type === type).map((e) => e.data as Record<string, unknown>);
}

// -- matching --------------------------------------------------------------

describe("matching", () => {
  test("an empty match takes everything, and the ledger says it delivered", async () => {
    await configure({ routes: [toolRoute({})] });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls).toHaveLength(1);
    expect(ledger(item)).toEqual([
      {
        routeId: "rt_slack",
        target: TOOL,
        index: 0,
        kind: "tool",
        attempts: 1,
        outcome: "delivered",
        updatedAt: new Date(clock).toISOString(),
      },
    ]);
  });

  test("`source` is exact and `name` is a glob", async () => {
    await configure({
      routes: [toolRoute({ source: "other", name: "**" }, undefined, "rt_wrong_source")],
    });
    await dispatcher().onItem(wsId, seed("domain.active"));
    expect(calls).toHaveLength(0);

    await configure({ routes: [toolRoute({ source: SOURCE, name: "domain.*" })] });
    await dispatcher().onItem(wsId, seed("domain.dns.ready", "attention", "evt_deep"));
    expect(calls).toHaveLength(0);

    await dispatcher().onItem(wsId, seed("domain.active", "attention", "evt_shallow"));
    expect(calls).toHaveLength(1);
  });

  test("every matching route fires, in the order the workspace lists them", async () => {
    await configure({
      routes: [
        toolRoute({ name: "domain.*" }, { text: "first" }, "rt_a"),
        toolRoute({}, { text: "second" }, "rt_b"),
      ],
    });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls.map((c) => c.input.text)).toEqual(["first", "second"]);
    expect(ledger(item).map((row) => row.routeId)).toEqual(["rt_a", "rt_b"]);
  });

  test("nothing is written when no route matches — an empty ledger stays empty", async () => {
    await configure({ routes: [toolRoute({ name: "reply.*" })] });
    const item = seed();
    await dispatcher().onItem(wsId, item);
    expect(calls).toHaveLength(0);
    expect(ledger(item)).toEqual([]);
  });
});

// -- the ceiling -----------------------------------------------------------

describe("the source ceiling", () => {
  test("clamps a route out, and the ledger says so by staying empty", async () => {
    // The connector called it urgent; this workspace holds the source to
    // `info`, so a route asking for `attention` never sees it.
    await configure({
      sources: { [SOURCE]: { maxLevel: "info" } },
      routes: [toolRoute({ level: "attention" })],
    });
    const item = await seedClamped("urgent");

    expect(item.effectiveLevel).toBe("info");
    await dispatcher().onItem(wsId, item);
    expect(calls).toHaveLength(0);
    expect(ledger(item)).toEqual([]);
  });

  test("a raised ceiling lets the same route through", async () => {
    await configure({
      sources: { [SOURCE]: { maxLevel: "urgent" } },
      routes: [toolRoute({ level: "attention" })],
    });
    const item = await seedClamped("urgent");

    // Nothing was clamped, so nothing is stamped: the connector's level is the
    // effective one and a second copy of it could only disagree.
    expect(item.effectiveLevel).toBeUndefined();
    await dispatcher().onItem(wsId, item);
    expect(calls).toHaveLength(1);
  });

  test("`level` is a minimum, so a higher item matches a lower route", async () => {
    await configure({
      sources: { [SOURCE]: { maxLevel: "urgent" } },
      routes: [toolRoute({ level: "info" })],
    });
    await dispatcher().onItem(wsId, await seedClamped("urgent"));
    expect(calls).toHaveLength(1);
  });
});

// -- the dispatch ----------------------------------------------------------

describe("the call the route makes", () => {
  test("runs as the route's author, with the template rendered and a route reason", async () => {
    await configure({ routes: [toolRoute({}, { channel: "#outbound", text: "{{title}}" })] });
    await dispatcher().onItem(wsId, seed());

    expect(calls[0]).toEqual({
      principalId: AUTHOR,
      workspaceId: wsId,
      tool: TOOL,
      input: { channel: "#outbound", text: "acme-outreach.com is active" },
      reason: "route:rt_slack",
    });
  });

  test("an unresolvable placeholder renders empty rather than shipping braces", async () => {
    await configure({ routes: [toolRoute({}, { text: "a{{data.domain}}b" })] });
    await dispatcher().onItem(wsId, seed());
    expect(calls[0]?.input.text).toBe("ab");
  });
});

// -- outcomes --------------------------------------------------------------

describe("each dispatch outcome maps to a ledger row and an event", () => {
  async function deliverWith(result: UnattendedDispatchResult): Promise<DeliveryRecord> {
    answers = [result];
    await configure({ routes: [toolRoute({})] });
    const item = seed();
    await dispatcher().onItem(wsId, item);
    return ledger(item)[0] as DeliveryRecord;
  }

  test("`ok` is delivered, and announces itself so an open inbox updates", async () => {
    const row = await deliverWith({ outcome: "ok" });
    expect(row.outcome).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(eventsOfType("notification.delivered")).toHaveLength(1);
    expect(eventsOfType("notification.delivery_failed")).toHaveLength(0);
  });

  test("`denied` is terminal at one attempt — retrying changes nothing", async () => {
    const row = await deliverWith({
      outcome: "denied",
      classification: "tool_permission_denied",
      error: "not allowed",
    });
    expect(row).toMatchObject({
      outcome: "denied",
      attempts: 1,
      classification: "tool_permission_denied",
      lastError: "not allowed",
    });
    expect(row.nextAttemptAt).toBeUndefined();
    expect(eventsOfType("notification.delivery_failed")[0]).toMatchObject({
      routeId: "rt_slack",
      target: TOOL,
      outcome: "denied",
    });
  });

  test("`skipped/owner_not_member` is terminal and does not retry", async () => {
    const row = await deliverWith({
      outcome: "skipped",
      classification: "owner_not_member",
      error: "not a member",
    });
    expect(row).toMatchObject({ outcome: "skipped", attempts: 1, classification: "owner_not_member" });
    expect(row.nextAttemptAt).toBeUndefined();
  });

  test("`error` leaves the row pending with the next attempt on it", async () => {
    const row = await deliverWith({
      outcome: "error",
      classification: "timeout",
      error: "took too long",
    });
    expect(row).toMatchObject({ outcome: "pending", attempts: 1, classification: "timeout" });
    expect(row.nextAttemptAt).toBe(new Date(clock + 60_000).toISOString());
    // Not a failure yet, so nothing is announced as one.
    expect(eventsOfType("notification.delivery_failed")).toHaveLength(0);
  });

  test("a route naming a tool the door refuses is denied by the door, not by this module", async () => {
    // `automations__create` is barred by the unattended policy. This module
    // does not know that and must not: it makes the call and reads the answer.
    answers = [
      { outcome: "denied", classification: "tool_not_allowed", error: "not available unattended" },
    ];
    await configure({
      routes: [
        {
          id: "rt_auto",
          createdBy: AUTHOR,
          match: {},
          deliver: [{ kind: "tool", tool: "automations__create", input: {} }],
        },
      ],
    });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls[0]?.tool).toBe("automations__create");
    expect(ledger(item)[0]).toMatchObject({ outcome: "denied", classification: "tool_not_allowed" });
  });
});

// -- independence ----------------------------------------------------------

describe("targets are independent", () => {
  test("a failing target does not stop the ones after it", async () => {
    answers = [{ outcome: "denied", classification: "tool_not_allowed" }, { outcome: "ok" }];
    await configure({
      routes: [
        toolRoute({}, { text: "first" }, "rt_a"),
        toolRoute({}, { text: "second" }, "rt_b"),
      ],
    });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls).toHaveLength(2);
    expect(ledger(item).map((row) => row.outcome)).toEqual(["denied", "delivered"]);
  });
});

// -- the author's membership ----------------------------------------------

describe("an author who is no longer a member", () => {
  const notMember: UnattendedDispatchResult = {
    outcome: "skipped",
    classification: "owner_not_member",
    error: "not a member",
  };

  async function storedRoute(): Promise<Record<string, unknown> | undefined> {
    const ws = await workspaceStore.get(wsId);
    const routes = (ws?.notifications as { routes?: Array<Record<string, unknown>> } | undefined)
      ?.routes;
    return routes?.[0];
  }

  test("disables the route on the workspace record, with a reason the editor shows", async () => {
    answers = [notMember];
    await configure({ routes: [toolRoute({})] });
    await dispatcher().onItem(wsId, seed());

    const disabled = (await storedRoute())?.disabled as { reason: string; at: string } | undefined;
    expect(disabled?.reason).toContain("no longer a member");
    expect(disabled?.at).toBe(new Date(clock).toISOString());
  });

  test("re-membership clears it on the next evaluation, with nobody touching settings", async () => {
    answers = [notMember];
    await configure({ routes: [toolRoute({})] });
    await dispatcher().onItem(wsId, seed("domain.active", "attention", "evt_one"));
    expect((await storedRoute())?.disabled).toBeDefined();

    answers = [{ outcome: "ok" }];
    await dispatcher().onItem(wsId, seed("domain.active", "attention", "evt_two"));
    expect((await storedRoute())?.disabled).toBeUndefined();
  });
});

// -- retry -----------------------------------------------------------------

describe("the retry bound", () => {
  const failing: UnattendedDispatchResult = {
    outcome: "error",
    classification: "tool_error",
    error: "channel is archived",
  };

  test("three attempts across five minutes, then failed", async () => {
    answers = [failing];
    await configure({ routes: [toolRoute({})] });
    const item = seed();
    const disp = dispatcher();
    await disp.onItem(wsId, item);
    expect(calls).toHaveLength(1);

    // Not yet due: a sweep before the delay elapses changes nothing.
    advance(59_000);
    await disp.sweepRetries();
    expect(calls).toHaveLength(1);

    advance(2_000);
    await disp.sweepRetries();
    expect(calls).toHaveLength(2);
    expect(ledger(item)[0]).toMatchObject({ outcome: "pending", attempts: 2 });

    advance(240_000);
    await disp.sweepRetries();
    expect(calls).toHaveLength(3);
    expect(ledger(item)[0]).toMatchObject({
      outcome: "failed",
      attempts: 3,
      lastError: "channel is archived",
    });

    // Spent. Nothing schedules a fourth.
    advance(3_600_000);
    await disp.sweepRetries();
    expect(calls).toHaveLength(3);
    expect(eventsOfType("notification.delivery_failed")).toHaveLength(1);
  });

  test("a retry that succeeds stops the ladder", async () => {
    answers = [failing, { outcome: "ok" }];
    await configure({ routes: [toolRoute({})] });
    const item = seed();
    const disp = dispatcher();
    await disp.onItem(wsId, item);

    advance(61_000);
    await disp.sweepRetries();
    expect(ledger(item)[0]).toMatchObject({ outcome: "delivered", attempts: 2 });

    advance(3_600_000);
    await disp.sweepRetries();
    expect(calls).toHaveLength(2);
  });

  test("a route deleted between attempts is not fired again", async () => {
    answers = [failing];
    await configure({ routes: [toolRoute({})] });
    const item = seed();
    const disp = dispatcher();
    await disp.onItem(wsId, item);

    await configure({ routes: [] });
    advance(61_000);
    await disp.sweepRetries();

    expect(calls).toHaveLength(1);
    expect(ledger(item)[0]).toMatchObject({ outcome: "failed", classification: "route_changed" });
  });
});

describe("a retry whose attempt cannot even start", () => {
  /**
   * `sweepRetries` takes the entry out of the index before the attempt runs,
   * and `#attempt` is what normally puts a fresh one back — so a throw on the
   * way there is the one path that can lose the row from memory while it is
   * still `pending` on disk. Nothing else in this file reaches it, which is
   * why it went unnoticed for two rounds.
   */
  test("is re-queued rather than stranded until the next boot", async () => {
    answers = [{ outcome: "error", classification: "tool_error", error: "down" }];
    await configure({ routes: [toolRoute({})] });
    const item = seed();

    let broken = false;
    const disp = dispatcher({
      workspaceStore: {
        ...workspaceStore,
        get: async (id: string) => {
          if (broken) throw new Error("workspace record is unreadable");
          return workspaceStore.get(id);
        },
      } as unknown as typeof workspaceStore,
    });
    await disp.onItem(wsId, item);
    expect(ledger(item)[0]).toMatchObject({ outcome: "pending", attempts: 1 });

    // The store breaks before the retry lands.
    broken = true;
    advance(61_000);
    await disp.sweepRetries();
    expect(calls).toHaveLength(1);

    // Still pending on disk, and still held in memory — so the recovery is the
    // next tick, not the next boot. It is also not due immediately: re-queuing
    // an unreachable store as already-due would retry it at tick rate.
    expect(ledger(item)[0]).toMatchObject({ outcome: "pending", attempts: 1 });
    await disp.sweepRetries();
    expect(calls).toHaveLength(1);

    broken = false;
    advance(61_000);
    await disp.sweepRetries();

    // The outage spent no attempt: this is the second, not the third.
    expect(calls).toHaveLength(2);
    expect(ledger(item)[0]).toMatchObject({ attempts: 2 });
  });
});

// -- restart ---------------------------------------------------------------

describe("restart", () => {
  test("resumes a pending row and does not re-send a delivered one", async () => {
    answers = [
      { outcome: "error", classification: "tool_error", error: "down" },
      { outcome: "ok" },
    ];
    await configure({
      routes: [
        toolRoute({}, { text: "will retry" }, "rt_retry"),
        toolRoute({}, { text: "already done" }, "rt_done"),
      ],
    });
    const item = seed();
    const first = dispatcher();
    await first.onItem(wsId, item);
    expect(ledger(item).map((row) => row.outcome)).toEqual(["pending", "delivered"]);
    first.stop();

    // A new process. It knows nothing but what is on disk.
    calls = [];
    answers = [{ outcome: "ok" }];
    const second = dispatcher();
    await second.resume();

    advance(61_000);
    await second.sweepRetries();

    expect(calls.map((c) => c.input.text)).toEqual(["will retry"]);
    expect(ledger(item).map((row) => row.outcome)).toEqual(["delivered", "delivered"]);
  });

  test("a resumed row keeps its attempt count, so the bound is not restarted", async () => {
    answers = [{ outcome: "error", classification: "tool_error", error: "down" }];
    await configure({ routes: [toolRoute({})] });
    const item = seed();
    const first = dispatcher();
    await first.onItem(wsId, item);
    advance(61_000);
    await first.sweepRetries();
    expect(ledger(item)[0]?.attempts).toBe(2);
    first.stop();

    const second = dispatcher();
    await second.resume();
    advance(241_000);
    await second.sweepRetries();

    expect(ledger(item)[0]).toMatchObject({ outcome: "failed", attempts: 3 });
  });
});

// -- agent targets ---------------------------------------------------------

describe("a route naming one tool twice", () => {
  /**
   * "Post to #outbound and to #alerts" is one route with two targets that
   * happen to share a tool. They are two deliveries and they fail
   * independently, so a ledger keyed on the tool NAME would let the second
   * overwrite the first — reporting a message that never landed as delivered,
   * and losing its retry on the next restart.
   */
  function twoChannels(): Record<string, unknown> {
    return {
      id: "rt_fanout",
      createdBy: AUTHOR,
      match: {},
      deliver: [
        { kind: "tool", tool: TOOL, input: { channel: "#outbound" } },
        { kind: "tool", tool: TOOL, input: { channel: "#alerts" } },
      ],
    };
  }

  test("keeps a row per slot, so one failure is not hidden by the other's success", async () => {
    answers = [
      { outcome: "error", classification: "tool_error", error: "outbound is archived" },
      { outcome: "ok" },
    ];
    await configure({ routes: [twoChannels()] });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls.map((c) => c.input.channel)).toEqual(["#outbound", "#alerts"]);
    expect(ledger(item)).toHaveLength(2);
    expect(ledger(item)[0]).toMatchObject({ index: 0, outcome: "pending", attempts: 1 });
    expect(ledger(item)[1]).toMatchObject({ index: 1, outcome: "delivered" });
  });

  test("the failed slot is on disk, so a restart resumes exactly it", async () => {
    answers = [
      { outcome: "error", classification: "tool_error", error: "outbound is archived" },
      { outcome: "ok" },
    ];
    await configure({ routes: [twoChannels()] });
    const item = seed();
    const first = dispatcher();
    await first.onItem(wsId, item);
    first.stop();

    calls = [];
    answers = [{ outcome: "ok" }];
    const second = dispatcher();
    await second.resume();
    advance(61_000);
    await second.sweepRetries();

    expect(calls.map((c) => c.input.channel)).toEqual(["#outbound"]);
    expect(ledger(item).map((row) => row.outcome)).toEqual(["delivered", "delivered"]);
  });

  test("a slot that now holds a different tool is closed, not fired", async () => {
    answers = [{ outcome: "error", classification: "tool_error", error: "down" }];
    await configure({ routes: [twoChannels()] });
    const item = seed();
    const disp = dispatcher();
    await disp.onItem(wsId, item);

    // The admin rewrote the route: slot 0 now names something else entirely.
    await configure({
      routes: [
        {
          id: "rt_fanout",
          createdBy: AUTHOR,
          match: {},
          deliver: [{ kind: "tool", tool: "mail__send", input: {} }],
        },
      ],
    });
    calls = [];
    advance(61_000);
    await disp.sweepRetries();

    expect(calls).toHaveLength(0);
    expect(ledger(item)[0]).toMatchObject({ outcome: "failed", classification: "route_changed" });
  });
});

describe("an agent target", () => {
  test("records deferred/awaiting_wake and calls nothing", async () => {
    await configure({
      routes: [
        {
          id: "rt_triage",
          createdBy: AUTHOR,
          match: {},
          deliver: [{ kind: "agent", automation: "auto_triage" }],
        },
      ],
    });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls).toHaveLength(0);
    expect(ledger(item)).toEqual([
      {
        routeId: "rt_triage",
        target: "auto_triage",
        index: 0,
        kind: "agent",
        attempts: 0,
        outcome: "deferred",
        classification: "awaiting_wake",
        updatedAt: new Date(clock).toISOString(),
      },
    ]);
    // Not a failure: nothing gave up, and an operator watching for one should
    // not be told a route broke because the next slice is unbuilt.
    expect(eventsOfType("notification.delivery_failed")).toHaveLength(0);
  });

  test("does not stop a tool target on the same route", async () => {
    await configure({
      routes: [
        {
          id: "rt_both",
          createdBy: AUTHOR,
          match: {},
          deliver: [
            { kind: "agent", automation: "auto_triage" },
            { kind: "tool", tool: TOOL, input: { text: "{{title}}" } },
          ],
        },
      ],
    });
    const item = seed();
    await dispatcher().onItem(wsId, item);

    expect(calls).toHaveLength(1);
    expect(ledger(item).map((row) => row.outcome)).toEqual(["deferred", "delivered"]);
  });

  test("is never resumed as pending work on a restart", async () => {
    await configure({
      routes: [
        {
          id: "rt_triage",
          createdBy: AUTHOR,
          match: {},
          deliver: [{ kind: "agent", automation: "auto_triage" }],
        },
      ],
    });
    await dispatcher().onItem(wsId, seed());

    const second = dispatcher();
    await second.resume();
    advance(RETRY_TICK_MS * 10);
    await second.sweepRetries();
    expect(calls).toHaveLength(0);
  });
});
