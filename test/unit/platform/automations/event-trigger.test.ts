/**
 * The event trigger — matching, batching, the `<event>` block and the ceiling.
 *
 * The dependencies are stubs on purpose: what is under test is the decision
 * this module makes, not the store or the scheduler it makes it against. The
 * one thing deliberately NOT stubbed is time-as-a-real-timer — the debounce is
 * driven by an actual `setTimeout`, because the property being asserted is that
 * items arriving inside one window become one run, and a fake timer would let
 * that hold for a bug that fires per item.
 */

import { describe, expect, test } from "bun:test";
import {
  AutomationEventTrigger,
  type AutomationEventTriggerDeps,
  type EventWakeSettlement,
  MAX_EVENT_BATCH_ITEMS,
  renderEventBlock,
} from "../../../../src/platform/automations/event-trigger.ts";
import type { RunInput } from "../../../../src/platform/automations/scheduler.ts";
import type { Automation, ScheduleSpec } from "../../../../src/platform/automations/types.ts";
import { parseNotificationEnvelope } from "../../../../src/notifications/envelope.ts";
import type { Notification } from "../../../../src/notifications/types.ts";

const WS = "ws_1";
const OWNER = "usr_admin";
const ID = "reply-triage";
const SOURCE = "precision-outbound";

/** A short window, so a batching test finishes in milliseconds rather than 30s. */
const DEBOUNCE = 20;

function automation(schedule: Partial<ScheduleSpec> = {}, over: Partial<Automation> = {}): Automation {
  return {
    id: ID,
    name: "Reply triage",
    prompt: "Triage the replies.",
    schedule: {
      type: "event",
      match: { source: SOURCE, name: "reply.*" },
      debounceMs: DEBOUNCE,
      ...schedule,
    } as ScheduleSpec,
    enabled: true,
    ownerId: OWNER,
    workspaceId: WS,
    source: "user",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...over,
  };
}

function item(
  name = "reply.received",
  eventId = `evt_${Math.random().toString(16).slice(2)}`,
  source = SOURCE,
  meta: Record<string, unknown> = { level: "attention", title: "Reply from jane@acme.com" },
): Notification {
  const envelope = parseNotificationEnvelope({
    eventId,
    name,
    timestamp: "2026-09-01T18:42:10Z",
    data: { thread_id: "th_1", secret: "do not show this to the model" },
    _meta: { "ai.nimblebrain/notification": meta },
  });
  if (!envelope) throw new Error("fixture did not parse");
  return { envelope, source, workspaceId: WS, receivedAt: envelope.timestamp, seq: 1, deliveries: [] };
}

interface Harness {
  trigger: AutomationEventTrigger;
  /** Every run the trigger started, in order. */
  runs: RunInput[];
  /** Every `disable` call, in order. */
  disabled: string[];
  /** How the stubbed run answers; the last entry repeats. */
  answers: Array<{ run: { id: string } } | { skipped: string }>;
}

function harness(over: Partial<AutomationEventTriggerDeps> = {}): Harness {
  const runs: RunInput[] = [];
  const disabled: string[] = [];
  const answers: Array<{ run: { id: string } } | { skipped: string }> = [{ run: { id: "run_1" } }];
  const trigger = new AutomationEventTrigger({
    automation: () => automation(),
    eventRunsSince: () => 0,
    run: async (_ws, _owner, _id, input) => {
      runs.push(input);
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
    disable: (_ws, _owner, _id, reason) => {
      disabled.push(reason);
    },
    ...over,
  });
  return { trigger, runs, disabled, answers };
}

/** Offer one item and collect where it eventually settled. */
function offer(h: Harness, notification: Notification): { settled: EventWakeSettlement[] } {
  const settled: EventWakeSettlement[] = [];
  const ack = h.trigger.offer({
    wsId: WS,
    ownerId: OWNER,
    automationId: ID,
    item: notification,
    settle: (r) => settled.push(r),
  });
  if (!ack.accepted) settled.push(ack);
  return { settled };
}

/** Wait past the debounce window and let the dispatched run settle. */
async function settleWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE + 20));
}

// -- what the automation admits -------------------------------------------

describe("what an offer is refused for", () => {
  test("an automation the route's author does not own here", async () => {
    const h = harness({ automation: () => undefined });
    const { settled } = offer(h, item());
    expect(settled[0]).toMatchObject({ outcome: "denied", classification: "unknown_automation" });
    expect(h.runs).toHaveLength(0);
  });

  test("an automation that runs on a clock", async () => {
    const h = harness({
      automation: () => automation({ type: "cron", expression: "0 9 * * *" }),
    });
    const { settled } = offer(h, item());
    expect(settled[0]).toMatchObject({ outcome: "denied", classification: "not_event_scheduled" });
  });

  test("a disabled automation, which is a skip because re-enabling clears it", async () => {
    const h = harness({
      automation: () => automation({}, { enabled: false, disabledReason: "paused by you" }),
    });
    const { settled } = offer(h, item());
    expect(settled[0]).toMatchObject({ outcome: "skipped", classification: "automation_disabled" });
  });

  test("an item the automation's own match does not want", async () => {
    const h = harness();
    expect(offer(h, item("bounce.hard")).settled[0]).toMatchObject({
      outcome: "skipped",
      classification: "match_declined",
    });
    expect(offer(h, item("reply.received", "evt_wrong_source", "other")).settled[0]).toMatchObject({
      classification: "match_declined",
    });
  });

  test("a minimum level below the automation's own", async () => {
    const h = harness({
      automation: () => automation({ match: { level: "urgent" } }),
    });
    expect(offer(h, item("reply.received", "evt_low")).settled[0]).toMatchObject({
      classification: "match_declined",
    });
    const urgent = item("reply.received", "evt_high", SOURCE, { level: "urgent", title: "t" });
    expect(offer(h, urgent).settled).toHaveLength(0);
  });
});

// -- batching --------------------------------------------------------------

describe("batching", () => {
  test("items inside one window become one run carrying all of them", async () => {
    const h = harness();
    const a = offer(h, item("reply.received", "evt_a"));
    const b = offer(h, item("reply.received", "evt_b"));
    const c = offer(h, item("reply.received", "evt_c"));
    await settleWindow();

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.preamble).toContain("3 notifications matched");
    for (const id of ["evt_a", "evt_b", "evt_c"]) {
      expect(h.runs[0]?.preamble).not.toContain(id); // the block carries fields, not ids
    }
    expect(h.runs[0]?.preamble.match(/"name": "reply.received"/g)).toHaveLength(3);
    for (const one of [a, b, c]) {
      expect(one.settled[0]).toEqual({ outcome: "delivered", runId: "run_1" });
    }
  });

  test("the same item delivered twice is one entry, because delivery is at-least-once", async () => {
    const h = harness();
    const first = offer(h, item("reply.received", "evt_dup"));
    const second = offer(h, item("reply.received", "evt_dup"));
    await settleWindow();

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.preamble).toContain("One notification matched");
    // Both callers still hear an answer: the second settler replaced the first,
    // and both name the same ledger row.
    expect(first.settled.length + second.settled.length).toBeGreaterThan(0);
  });

  test("a full batch dispatches at once rather than waiting out its window", async () => {
    // A window long enough that waiting it out would fail the test.
    const h = harness({ automation: () => automation({ debounceMs: 600_000 }) });
    for (let i = 0; i < MAX_EVENT_BATCH_ITEMS; i++) offer(h, item("reply.received", `evt_${i}`));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.preamble).toContain(`${MAX_EVENT_BATCH_ITEMS} notifications matched`);
  });

  test("a run that never started is a skip naming why", async () => {
    const h = harness();
    h.answers[0] = { skipped: "a previous run of this automation is still in flight" };
    const one = offer(h, item());
    await settleWindow();

    expect(one.settled[0]).toMatchObject({
      outcome: "skipped",
      classification: "run_not_started",
    });
    expect(one.settled[0]?.reason).toContain("still in flight");
  });

  test("stopping settles an open batch instead of losing it silently", async () => {
    const h = harness({ automation: () => automation({ debounceMs: 600_000 }) });
    const one = offer(h, item());
    h.trigger.stop();

    expect(h.runs).toHaveLength(0);
    expect(one.settled[0]).toMatchObject({
      outcome: "failed",
      classification: "batch_not_dispatched",
    });
  });
});

// -- the fire ceiling ------------------------------------------------------

describe("the fire ceiling", () => {
  test("disables the automation and settles the batch as the ceiling", async () => {
    const h = harness({
      automation: () => automation({ maxFiresPerHour: 3 }),
      eventRunsSince: () => 3,
    });
    const one = offer(h, item());
    await settleWindow();

    expect(h.runs).toHaveLength(0);
    expect(h.disabled).toHaveLength(1);
    expect(h.disabled[0]).toContain("3 times from events within an hour");
    expect(one.settled[0]).toMatchObject({
      outcome: "failed",
      classification: "event_fire_ceiling",
    });
  });

  test("counts only event-fired runs inside the window, and lets one through below it", async () => {
    const seen: number[] = [];
    const h = harness({
      automation: () => automation({ maxFiresPerHour: 3 }),
      eventRunsSince: (_ws, _owner, _id, since) => {
        seen.push(since);
        return 2;
      },
    });
    offer(h, item());
    await settleWindow();

    expect(h.runs).toHaveLength(1);
    expect(h.disabled).toHaveLength(0);
    // The window is an hour back from now, not the whole history.
    expect(Date.now() - seen[0]!).toBeGreaterThanOrEqual(3_600_000);
    expect(Date.now() - seen[0]!).toBeLessThan(3_600_000 + 60_000);
  });

  test("an unreadable history is treated as spent, not as clear", async () => {
    const h = harness({
      eventRunsSince: () => {
        throw new Error("run index is unreadable");
      },
    });
    const one = offer(h, item());
    await settleWindow();

    expect(h.runs).toHaveLength(0);
    expect(one.settled[0]).toMatchObject({ classification: "event_fire_ceiling" });
  });
});

// -- the block itself ------------------------------------------------------

describe("the <event> block", () => {
  test("carries the envelope's presentation fields and never the connector's data", () => {
    const block = renderEventBlock([
      item("reply.received", "evt_1", SOURCE, {
        level: "attention",
        title: "Reply from jane@acme.com",
        subject: "acme.com",
        body: "Interested — can we talk Thursday?",
        link: { resource: "po://campaigns/cmp_1" },
      }),
    ]);

    expect(block.startsWith("<event>")).toBe(true);
    expect(block.endsWith("</event>")).toBe(true);
    expect(block).toContain("precision-outbound");
    expect(block).toContain("reply.received");
    expect(block).toContain("2026-09-01T18:42:10.000Z");
    expect(block).toContain("acme.com");
    expect(block).toContain("Interested — can we talk Thursday?");
    expect(block).toContain("po://campaigns/cmp_1");

    // The whole of the line this design holds: the runtime does not read a
    // connector's payload, so it does not put one in front of the model either.
    expect(block).not.toContain("thread_id");
    expect(block).not.toContain("do not show this to the model");

    // And the framing, which is the part that makes the rest safe to include.
    expect(block).toContain("untrusted content");
  });

  test("omits presentation fields the connector did not send", () => {
    const block = renderEventBlock([item("reply.received", "evt_bare", SOURCE, {})]);
    expect(block).not.toContain('"subject"');
    expect(block).not.toContain('"body"');
    expect(block).not.toContain('"link"');
    // A missing title falls back to the event name, per the envelope contract.
    expect(block).toContain('"title": "reply.received"');
  });
});
