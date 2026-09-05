/**
 * The inbox store — what the runtime stamps, and what a server cannot.
 *
 * The properties pinned here are the ones every consumer above rests on: a
 * server cannot forge provenance, an at-least-once transport cannot double a
 * record, `seq` counts one workspace and not the process, and a store bound to
 * one workspace cannot see or mark another's items.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { NotificationCreatedPayload } from "../../../src/engine/schemas/events.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { parseNotificationEnvelope } from "../../../src/notifications/envelope.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import type { NotificationEnvelope } from "../../../src/notifications/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

const WS_A = "ws_aaaaaaaaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbbbbbbbb";

let workDir: string;

/** Collects everything emitted, so a test can assert on the event as well as the write. */
class CapturingSink implements EventSink {
  readonly events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
}

function storeFor(wsId: string, sink: EventSink = new NoopEventSink()): NotificationStore {
  return new NotificationStore(new WorkspaceContext({ wsId, workDir }), { eventSink: sink });
}

/** A parsed envelope, so tests exercise exactly what the poller will hand the store. */
function envelope(overrides: Record<string, unknown> = {}): NotificationEnvelope {
  const parsed = parseNotificationEnvelope({
    eventId: "evt_01",
    name: "domain.active",
    timestamp: "2026-09-01T18:42:10Z",
    data: {},
    ...overrides,
  });
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-store-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("the runtime stamps provenance; a server cannot", () => {
  test("source, workspaceId, receivedAt and seq come from the store", () => {
    const { item } = storeFor(WS_A).append("acme", envelope());
    expect(item.source).toBe("acme");
    expect(item.workspaceId).toBe(WS_A);
    expect(item.seq).toBe(1);
    expect(Number.isNaN(Date.parse(item.receivedAt))).toBe(false);
    expect(item.deliveries).toEqual([]);
    expect(item.readAt).toBeUndefined();
  });

  test("an envelope claiming the stamped fields does not set them", () => {
    // The parser only ever produces the five `EventOccurrence` members, so
    // these never reach the record — this pins that the *stored* item takes
    // its provenance from the store even when the payload argues otherwise.
    const forged = envelope({
      source: "trusted-bank",
      workspaceId: WS_B,
      seq: 999,
      receivedAt: "1999-01-01T00:00:00.000Z",
      readAt: "1999-01-01T00:00:00.000Z",
      deliveries: [{ routeId: "rt", target: "slack__send_message", attempts: 1, outcome: "delivered" }],
    });
    const { item } = storeFor(WS_A).append("acme", forged);
    expect(item.source).toBe("acme");
    expect(item.workspaceId).toBe(WS_A);
    expect(item.seq).toBe(1);
    expect(item.receivedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(item.readAt).toBeUndefined();
    expect(item.deliveries).toEqual([]);
    expect(item.envelope).not.toHaveProperty("source");
    expect(item.envelope).not.toHaveProperty("seq");
  });
});

describe("dedupe on (source, eventId)", () => {
  test("a second write of the same event returns the stored item and creates nothing", () => {
    const store = storeFor(WS_A);
    const first = store.append("acme", envelope());
    const second = store.append("acme", envelope({ name: "domain.reregistered" }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.item.seq).toBe(first.item.seq);
    // The stored record is the FIRST one — a redelivery does not rewrite it.
    expect(second.item.envelope.name).toBe("domain.active");
    expect(store.list().length).toBe(1);
  });

  test("the same eventId from a different source is a different item", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope());
    const other = store.append("beta", envelope());
    expect(other.created).toBe(true);
    expect(store.list().length).toBe(2);
  });

  test("a redelivery emits no second event", () => {
    const sink = new CapturingSink();
    const store = storeFor(WS_A, sink);
    store.append("acme", envelope());
    store.append("acme", envelope());
    expect(sink.events.filter((e) => e.type === "notification.created").length).toBe(1);
  });
});

describe("seq is monotonic per workspace", () => {
  test("it counts one workspace, not the process", () => {
    const a = storeFor(WS_A);
    const b = storeFor(WS_B);
    expect(a.append("acme", envelope({ eventId: "e1" })).item.seq).toBe(1);
    expect(b.append("acme", envelope({ eventId: "e1" })).item.seq).toBe(1);
    expect(a.append("acme", envelope({ eventId: "e2" })).item.seq).toBe(2);
    expect(b.append("acme", envelope({ eventId: "e2" })).item.seq).toBe(2);
    expect(a.append("beta", envelope({ eventId: "e3" })).item.seq).toBe(3);
  });

  test("it survives a fresh store over the same tree", () => {
    storeFor(WS_A).append("acme", envelope({ eventId: "e1" }));
    storeFor(WS_A).append("acme", envelope({ eventId: "e2" }));
    expect(storeFor(WS_A).append("acme", envelope({ eventId: "e3" })).item.seq).toBe(3);
  });

  test("it continues across a day roll", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope({ eventId: "e1" }));
    // A yesterday file, written by hand at a seq below the current maximum.
    const dir = join(workDir, "workspaces", WS_A, "notifications");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01.jsonl"),
      `${JSON.stringify({
        envelope: envelope({ eventId: "old" }),
        source: "acme",
        workspaceId: WS_A,
        receivedAt: "2026-01-01T00:00:00.000Z",
        seq: 1,
        deliveries: [],
      })}\n`,
    );
    // The newest day file still decides the next seq, so an older file with a
    // colliding number cannot rewind the counter.
    expect(store.append("acme", envelope({ eventId: "e2" })).item.seq).toBe(2);
  });
});

describe("the workspace is the boundary", () => {
  test("a store sees only its own workspace's items", () => {
    storeFor(WS_A).append("acme", envelope({ eventId: "a1" }));
    storeFor(WS_B).append("acme", envelope({ eventId: "b1" }));
    expect(storeFor(WS_A).list().map((i) => i.envelope.eventId)).toEqual(["a1"]);
    expect(storeFor(WS_B).list().map((i) => i.envelope.eventId)).toEqual(["b1"]);
  });

  test("markRead cannot reach another workspace's item", () => {
    storeFor(WS_B).append("acme", envelope({ eventId: "b1" }));
    const changed = storeFor(WS_A).markRead([{ source: "acme", eventId: "b1" }]);
    expect(changed).toEqual([]);
    expect(storeFor(WS_B).list()[0]?.readAt).toBeUndefined();
  });

  test("items live under the workspace's own directory", () => {
    storeFor(WS_A).append("acme", envelope());
    const dir = join(workDir, "workspaces", WS_A, "notifications");
    expect(readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))).toBe(true);
  });
});

describe("markRead", () => {
  test("marks what it names and reports only what changed", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope({ eventId: "e1" }));
    store.append("acme", envelope({ eventId: "e2" }));
    const changed = store.markRead([
      { source: "acme", eventId: "e1" },
      { source: "acme", eventId: "nope" },
    ]);
    expect(changed.map((i) => i.envelope.eventId)).toEqual(["e1"]);
    const stored = storeFor(WS_A).list();
    expect(stored.find((i) => i.envelope.eventId === "e1")?.readAt).toBeDefined();
    expect(stored.find((i) => i.envelope.eventId === "e2")?.readAt).toBeUndefined();
  });

  test("re-marking an already-read item changes nothing", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope());
    store.markRead([{ source: "acme", eventId: "evt_01" }]);
    expect(store.markRead([{ source: "acme", eventId: "evt_01" }])).toEqual([]);
  });

  test("records who marked it — read state is shared, and this is who cleared it", () => {
    // The whole workspace reads one queue, so the second member to open an
    // item changes nothing and the row keeps naming the first.
    const store = storeFor(WS_A);
    store.append("acme", envelope());
    store.markRead([{ source: "acme", eventId: "evt_01" }], "usr_first");
    expect(store.markRead([{ source: "acme", eventId: "evt_01" }], "usr_second")).toEqual([]);
    expect(store.get("acme", "evt_01")?.readBy).toBe("usr_first");
  });
});

/** An envelope's presentation block at the top of the level vocabulary. */
const URGENT = { _meta: { "ai.nimblebrain/notification": { level: "urgent", title: "A reply" } } };

describe("the effective level", () => {
  test("is stored only when a ceiling actually clamped the item", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope({ eventId: "e1", ...URGENT }), "info");
    store.append("acme", envelope({ eventId: "e2", ...URGENT }), "urgent");
    // A second copy of a value that already exists is a field that can
    // disagree with itself, so an unclamped item does not carry one.
    expect(store.get("acme", "e1")?.effectiveLevel).toBe("info");
    expect(store.get("acme", "e2")?.effectiveLevel).toBeUndefined();
  });

  test("is absent when the caller resolved none", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope({ ...URGENT }));
    expect(store.get("acme", "evt_01")?.effectiveLevel).toBeUndefined();
  });
});

describe("the delivery ledger", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    routeId: "rt_1",
    target: "slack__send_message",
    kind: "tool" as const,
    attempts: 1,
    outcome: "pending" as const,
    updatedAt: "2026-09-01T19:00:00.000Z",
    ...over,
  });

  test("writes rows onto an item and replaces one that names the same target", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope());
    const ref = { source: "acme", eventId: "evt_01" };

    store.recordDeliveries(ref, [row(), row({ routeId: "rt_2" })]);
    store.recordDeliveries(ref, [row({ outcome: "delivered", attempts: 2 })]);

    const stored = storeFor(WS_A).get("acme", "evt_01")?.deliveries ?? [];
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ routeId: "rt_1", outcome: "delivered", attempts: 2 });
    expect(stored[1]).toMatchObject({ routeId: "rt_2", outcome: "pending" });
  });

  test("a ref naming nothing here answers rather than throwing", () => {
    // An item pruned mid-retry is the ordinary way this happens, and a
    // background loop needs an answer, not an exception.
    const store = storeFor(WS_A);
    expect(store.recordDeliveries({ source: "acme", eventId: "gone" }, [row()])).toBeUndefined();
  });

  test("pendingDeliveries returns only rows still waiting on an attempt", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope({ eventId: "e1" }));
    store.append("acme", envelope({ eventId: "e2" }));
    store.recordDeliveries({ source: "acme", eventId: "e1" }, [row()]);
    store.recordDeliveries({ source: "acme", eventId: "e2" }, [row({ outcome: "delivered" })]);

    const pending = storeFor(WS_A).pendingDeliveries();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.item.envelope.eventId).toBe("e1");
  });

  test("survives the round trip through disk, which is what makes it the retry state", () => {
    const store = storeFor(WS_A);
    store.append("acme", envelope());
    store.recordDeliveries({ source: "acme", eventId: "evt_01" }, [
      row({ nextAttemptAt: "2026-09-01T19:01:00.000Z", classification: "timeout" }),
    ]);
    // A fresh store object: everything it knows, it read back off the files.
    const reread = storeFor(WS_A).pendingDeliveries();
    expect(reread[0]?.row).toMatchObject({
      nextAttemptAt: "2026-09-01T19:01:00.000Z",
      classification: "timeout",
      attempts: 1,
    });
  });
});

describe("list", () => {
  function seed(store: NotificationStore): void {
    store.append("acme", envelope({ eventId: "e1", name: "domain.active" }));
    store.append("acme", envelope({ eventId: "e2", name: "reply.received", ...urgent() }));
    store.append("beta", envelope({ eventId: "e3", name: "bounce.received" }));
  }
  function urgent(): Record<string, unknown> {
    return { _meta: { "ai.nimblebrain/notification": { level: "urgent", title: "A reply" } } };
  }

  test("returns newest first", () => {
    const store = storeFor(WS_A);
    seed(store);
    expect(store.list().map((i) => i.envelope.eventId)).toEqual(["e3", "e2", "e1"]);
  });

  test("filters by source, level (as a minimum), unread and cursor", () => {
    const store = storeFor(WS_A);
    seed(store);
    expect(store.list({ source: "beta" }).map((i) => i.envelope.eventId)).toEqual(["e3"]);
    expect(store.list({ level: "attention" }).map((i) => i.envelope.eventId)).toEqual(["e2"]);
    expect(store.list({ level: "info" }).length).toBe(3);
    expect(store.list({ after: 2 }).map((i) => i.envelope.eventId)).toEqual(["e3"]);
    store.markRead([{ source: "acme", eventId: "e1" }]);
    expect(store.list({ unreadOnly: true }).map((i) => i.envelope.eventId)).toEqual(["e3", "e2"]);
  });

  test("caps the page", () => {
    const store = storeFor(WS_A);
    seed(store);
    expect(store.list({ limit: 2 }).length).toBe(2);
    expect(store.list({ limit: 10_000 }).length).toBe(3);
  });
});

describe("order", () => {
  function seedThree(store: NotificationStore): void {
    for (const eventId of ["e1", "e2", "e3"]) store.append("acme", envelope({ eventId }));
  }

  test("ascending is the replay order", () => {
    const store = storeFor(WS_A);
    seedThree(store);
    expect(store.list({ order: "asc" }).map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(store.list({ order: "asc", after: 1 }).map((i) => i.envelope.eventId)).toEqual([
      "e2",
      "e3",
    ]);
    expect(store.list({ order: "asc", after: 3 })).toEqual([]);
  });

  test("ascending pages forward; descending does not", () => {
    const store = storeFor(WS_A);
    seedThree(store);
    // The property the two orders differ on. Ascending takes the OLDEST page
    // above the cursor, so repeating with the page's highest seq advances.
    const first = store.list({ order: "asc", limit: 2 });
    expect(first.map((i) => i.seq)).toEqual([1, 2]);
    const second = store.list({ order: "asc", limit: 2, after: 2 });
    expect(second.map((i) => i.seq)).toEqual([3]);

    // Descending takes the NEWEST page, so its own cursor returns nothing —
    // it is a "what has arrived since" mark, not a pager.
    const newest = store.list({ limit: 2 });
    expect(newest.map((i) => i.seq)).toEqual([3, 2]);
    expect(store.list({ limit: 2, after: 3 })).toEqual([]);
  });

  test("filters apply in both directions", () => {
    const store = storeFor(WS_A);
    seedThree(store);
    store.append("beta", envelope({ eventId: "b1" }));
    expect(store.list({ order: "asc", source: "beta" }).map((i) => i.seq)).toEqual([4]);
    store.markRead([{ source: "acme", eventId: "e1" }]);
    expect(store.list({ order: "asc", unreadOnly: true }).map((i) => i.seq)).toEqual([2, 3, 4]);
  });
});

describe("retention", () => {
  test("prunes day files past the window and keeps the rest", () => {
    const dir = join(workDir, "workspaces", WS_A, "notifications");
    mkdirSync(dir, { recursive: true });
    const stale = new Date();
    stale.setDate(stale.getDate() - 200);
    writeFileSync(join(dir, `${stale.toISOString().slice(0, 10)}.jsonl`), "");
    const store = storeFor(WS_A);
    store.append("acme", envelope());
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);
    expect(files[0]).toBe(`${new Date().toISOString().slice(0, 10)}.jsonl`);
  });
});

describe("notification.created", () => {
  test("carries the workspace and the presentation the SSE router needs", () => {
    const sink = new CapturingSink();
    storeFor(WS_A, sink).append(
      "acme",
      envelope({
        _meta: {
          "ai.nimblebrain/notification": {
            level: "attention",
            title: "acme-outreach.test is active",
            subject: "acme-outreach.test",
          },
        },
      }),
    );
    const event = sink.events.find((e) => e.type === "notification.created");
    expect(event?.data).toMatchObject({
      workspaceId: WS_A,
      id: "acme:evt_01",
      seq: 1,
      source: "acme",
      name: "domain.active",
      level: "attention",
      title: "acme-outreach.test is active",
      subject: "acme-outreach.test",
    });
  });

  test("the payload the store emits matches its declared schema", () => {
    const sink = new CapturingSink();
    storeFor(WS_A, sink).append("acme", envelope());
    const event = sink.events.find((e) => e.type === "notification.created");
    expect(Value.Check(NotificationCreatedPayload, event?.data)).toBe(true);
  });
});
