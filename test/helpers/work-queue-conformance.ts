import { describe, expect, test } from "bun:test";
import {
  type Claim,
  type EnqueueRequest,
  LeaseLostError,
  type LeaseLostReason,
  MAX_WORK_PAYLOAD_BYTES,
  WORK_QUEUE_RETENTION_MS,
  type WorkQueue,
} from "../../src/providers/queue/types.ts";

/**
 * The properties every `WorkQueue` has, whatever store holds the items.
 *
 * Each test checks one rule from the doc comments in
 * `src/providers/queue/types.ts`, so an implementation that passes this suite
 * keeps the contract a consumer reads there. What belongs here: anything a
 * caller of the interface can observe. What does not: files, tables, locks.
 * Those stay in the implementation's own tests.
 *
 * The queue decides on its own clock, so `open` returns a clock the test
 * controls along with the queue it governs. Two properties are not every
 * implementation's: durability across close and reopen, and several
 * instances on one store. An implementation declares each in
 * `WorkQueueCapabilities`, and the cases for one it lacks are skipped by name.
 */
export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

export function createTestClock(start = Date.parse("2026-01-01T00:00:00.000Z")): TestClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface WorkQueueHarness {
  queue: WorkQueue;
  clock: TestClock;
  /**
   * Open a second instance on the same store, on the same clock, as another
   * process would. Required with `capabilities.peers`.
   */
  openPeer?: () => Promise<WorkQueue>;
  /**
   * Close `queue` and open the store again, on the same clock. Required with
   * `capabilities.durable`.
   */
  reopen?: () => Promise<WorkQueue>;
  /** Close every instance the harness opened and remove the store. */
  cleanup: () => Promise<void>;
}

const LEASE = 30_000;
const SCOPE = "ws-test-a";
const KINDS = ["k", "x", "y", "first", "second"];
const W = { workerId: "worker-a", leaseMs: LEASE, kinds: KINDS };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function item(
  key: string,
  payload: unknown = key,
  extra: Partial<EnqueueRequest> = {},
): EnqueueRequest {
  return { scope: SCOPE, kind: "k", payload, idempotencyKey: key, ...extra };
}

/** Expect `promise` to reject with a `LeaseLostError` naming `claim` and `reason`. */
async function expectLeaseLost(
  promise: Promise<unknown>,
  claim: Claim,
  reason: LeaseLostReason,
): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LeaseLostError);
  if (err instanceof LeaseLostError) {
    expect(err.code).toBe("lease_lost");
    expect(err.itemId).toBe(claim.id);
    expect(err.token).toBe(claim.token);
    expect(err.reason).toBe(reason);
  }
}

async function claimOrFail(queue: WorkQueue, kinds: string[] = KINDS): Promise<Claim> {
  const claim = await queue.claim({ ...W, kinds });
  if (!claim) throw new Error("expected a due item, got none");
  return claim;
}

/**
 * Run the interface suite against one implementation. `label` names it in the
 * test output; `open` builds a fresh, empty store.
 */
export interface WorkQueueCapabilities {
  /** The implementation keeps items across close and reopen; its harness provides `reopen`. */
  durable?: boolean;
  /** Several instances may share one store (`multiProcess: true`); its harness provides `openPeer`. */
  peers?: boolean;
}

export function describeWorkQueueConformance(
  label: string,
  open: () => Promise<WorkQueueHarness>,
  capabilities: WorkQueueCapabilities = {},
): void {
  async function withQueue(fn: (h: WorkQueueHarness) => Promise<void>): Promise<void> {
    const h = await open();
    try {
      await fn(h);
    } finally {
      await h.cleanup();
    }
  }

  describe(`${label} — WorkQueue conformance`, () => {
    test("multiProcess is a boolean", () =>
      withQueue(async ({ queue }) => {
        expect(typeof queue.multiProcess).toBe("boolean");
      }));

    describe("enqueue", () => {
      test("a new key creates an item with a non-empty id", () =>
        withQueue(async ({ queue }) => {
          const r = await queue.enqueue(item("a"));
          expect(r.created).toBe(true);
          expect(typeof r.id).toBe("string");
          expect(r.id.length).toBeGreaterThan(0);
        }));

      test("distinct keys are distinct items", () =>
        withQueue(async ({ queue }) => {
          const a = await queue.enqueue(item("a"));
          const b = await queue.enqueue(item("b"));
          expect(a.id).not.toBe(b.id);
        }));

      test("one key under two scopes is two items", () =>
        withQueue(async ({ queue }) => {
          const a = await queue.enqueue(item("a"));
          const b = await queue.enqueue(item("a", "a", { scope: "ws-test-b" }));
          expect(b.created).toBe(true);
          expect(b.id).not.toBe(a.id);
          expect((await claimOrFail(queue)).id).not.toBe((await claimOrFail(queue)).id);
        }));

      test("one key under two kinds is one item", () =>
        withQueue(async ({ queue }) => {
          const a = await queue.enqueue(item("a", "a", { kind: "x" }));
          expect(await queue.enqueue(item("a", "a", { kind: "y" }))).toEqual({
            id: a.id,
            created: false,
          });
        }));

      test("the same key while pending returns the same item, created false", () =>
        withQueue(async ({ queue }) => {
          const a = await queue.enqueue(item("a"));
          expect(await queue.enqueue(item("a"))).toEqual({ id: a.id, created: false });
          await claimOrFail(queue);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("the same key while claimed returns the same item and leaves the claim alone", () =>
        withQueue(async ({ queue }) => {
          const a = await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          expect(await queue.enqueue(item("a"))).toEqual({ id: a.id, created: false });
          expect(await queue.claim(W)).toBeNull();
          await queue.complete(claim);
        }));

      test("the same key after completion, within retention, returns the item and enqueues nothing", () =>
        withQueue(async ({ queue, clock }) => {
          const a = await queue.enqueue(item("a"));
          await queue.complete(await claimOrFail(queue));
          clock.advance(WORK_QUEUE_RETENTION_MS - 1);
          expect(await queue.enqueue(item("a"))).toEqual({ id: a.id, created: false });
          expect(await queue.claim(W)).toBeNull();
        }));

      test("the same key after a terminal fail, within retention, returns the item and enqueues nothing", () =>
        withQueue(async ({ queue, clock }) => {
          const a = await queue.enqueue(item("a"));
          await queue.fail(await claimOrFail(queue), { error: "boom" });
          clock.advance(WORK_QUEUE_RETENTION_MS - 1);
          expect(await queue.enqueue(item("a"))).toEqual({ id: a.id, created: false });
          expect(await queue.claim(W)).toBeNull();
        }));

      test("a later item under a forgotten key has a new id", () =>
        withQueue(async ({ queue, clock }) => {
          const old = await queue.enqueue(item("a"));
          await queue.complete(await claimOrFail(queue));
          clock.advance(WORK_QUEUE_RETENTION_MS);
          // Give an implementation that forgets on claim its chance to.
          await queue.claim(W);
          const again = await queue.enqueue(item("a"));
          // Forgetting is allowed, not required; when it forgot, the id is new.
          if (again.created) expect(again.id).not.toBe(old.id);
          else expect(again.id).toBe(old.id);
        }));

      test("concurrent enqueues of one key create one item", () =>
        withQueue(async ({ queue }) => {
          const results = await Promise.all(
            Array.from({ length: 8 }, () => queue.enqueue(item("a"))),
          );
          expect(results.filter((r) => r.created)).toHaveLength(1);
          expect(new Set(results.map((r) => r.id)).size).toBe(1);
        }));

      test("the first enqueue's kind, payload and notBefore stand; a repeat's are ignored", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a", { v: 1 }, { kind: "first" }));
          await queue.enqueue(
            item("a", { v: 2 }, { kind: "second", notBefore: iso(clock.now() + 60_000) }),
          );
          const claim = await claimOrFail(queue);
          expect(claim.kind).toBe("first");
          expect(claim.payload).toEqual({ v: 1 });
        }));

      test("rejects an empty scope, kind or key, creating nothing", () =>
        withQueue(async ({ queue }) => {
          await expect(queue.enqueue(item("a", 1, { scope: "" }))).rejects.toThrow();
          await expect(queue.enqueue(item("a", 1, { kind: "" }))).rejects.toThrow();
          await expect(queue.enqueue(item(""))).rejects.toThrow();
          expect(await queue.claim(W)).toBeNull();
          expect((await queue.enqueue(item("a"))).created).toBe(true);
        }));

      test("accepts a notBefore in RFC 3339 with Z or an explicit offset", () =>
        withQueue(async ({ queue, clock }) => {
          const t = clock.now();
          // The same instant, an hour ahead, written two ways.
          await queue.enqueue(item("z", "z", { notBefore: "2026-01-01T01:00:00Z" }));
          await queue.enqueue(item("off", "off", { notBefore: "2025-12-31T15:00:00.000-10:00" }));
          clock.advance(Date.parse("2026-01-01T01:00:00Z") - t - 1);
          expect(await queue.claim(W)).toBeNull();
          clock.advance(1);
          expect(await queue.claim(W)).not.toBeNull();
          expect(await queue.claim(W)).not.toBeNull();
        }));

      test("rejects a notBefore without an offset, or not RFC 3339, creating nothing", () =>
        withQueue(async ({ queue }) => {
          for (const notBefore of [
            "2026-01-01T01:00:00",
            "2026-01-01",
            "Thu, 01 Jan 2026 01:00:00 GMT",
            "not a time",
            "",
          ]) {
            await expect(queue.enqueue(item("a", 1, { notBefore }))).rejects.toThrow();
          }
          expect((await queue.enqueue(item("a"))).created).toBe(true);
        }));

      test("accepts a payload of MAX_WORK_PAYLOAD_BYTES and rejects one byte more, creating nothing", () =>
        withQueue(async ({ queue }) => {
          // A string serializes to its characters plus two quotes.
          const fits = "a".repeat(MAX_WORK_PAYLOAD_BYTES - 2);
          const over = "a".repeat(MAX_WORK_PAYLOAD_BYTES - 1);
          await expect(queue.enqueue(item("over", over))).rejects.toThrow();
          expect((await queue.enqueue(item("fits", fits))).created).toBe(true);
          expect((await claimOrFail(queue)).payload).toBe(fits);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("measures the payload in UTF-8 bytes", () =>
        withQueue(async ({ queue }) => {
          // "é" is two UTF-8 bytes: 2n + 1 + two quotes is one byte over the limit,
          // in far fewer characters than the limit.
          const over = `${"é".repeat((MAX_WORK_PAYLOAD_BYTES - 2) / 2)}a`;
          await expect(queue.enqueue(item("over", over))).rejects.toThrow();
        }));
    });

    describe("claim", () => {
      test("returns null when nothing is enqueued", () =>
        withQueue(async ({ queue }) => {
          expect(await queue.claim(W)).toBeNull();
        }));

      test("an item is not due before notBefore, and is due at it", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a", 1, { notBefore: iso(clock.now() + 10_000) }));
          clock.advance(9_999);
          expect(await queue.claim(W)).toBeNull();
          clock.advance(1);
          expect(await queue.claim(W)).not.toBeNull();
        }));

      test("a notBefore in the past is due at once", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a", 1, { notBefore: iso(clock.now() - 10_000) }));
          expect(await queue.claim(W)).not.toBeNull();
        }));

      test("sequential claims in one scope take items in due-time order", () =>
        withQueue(async ({ queue, clock }) => {
          const t = clock.now();
          await queue.enqueue(item("a", "late", { notBefore: iso(t - 1_000) }));
          await queue.enqueue(item("b", "early", { notBefore: iso(t - 5_000) }));
          clock.advance(1);
          await queue.enqueue(item("c", "now"));
          expect((await claimOrFail(queue)).payload).toBe("early");
          expect((await claimOrFail(queue)).payload).toBe("late");
          expect((await claimOrFail(queue)).payload).toBe("now");
          expect(await queue.claim(W)).toBeNull();
        }));

      test("an expired claim is due at its leaseUntil, ordered by it in its scope", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a", "leased"));
          await claimOrFail(queue);
          await queue.enqueue(item("b", "pending", { notBefore: iso(clock.now() + LEASE + 1) }));
          clock.advance(LEASE + 1);
          expect((await claimOrFail(queue)).payload).toBe("leased");
          expect((await claimOrFail(queue)).payload).toBe("pending");
        }));

      test("the first claim is attempt 1, leased until now plus leaseMs, with the item's id and kind", () =>
        withQueue(async ({ queue, clock }) => {
          const { id } = await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          expect(claim.id).toBe(id);
          expect(claim.kind).toBe("k");
          expect(claim.attempt).toBe(1);
          expect(typeof claim.token).toBe("number");
          expect(claim.leaseUntil).toBe(iso(clock.now() + LEASE));
        }));

      test("returned times are UTC with Z and milliseconds", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          expect(claim.leaseUntil).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect((await queue.extend(claim, LEASE)).leaseUntil).toMatch(/\.\d{3}Z$/);
        }));

      test("an item is claimed once while its lease holds", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await claimOrFail(queue);
          expect(await queue.claim({ ...W, workerId: "worker-b" })).toBeNull();
          clock.advance(LEASE - 1);
          expect(await queue.claim({ ...W, workerId: "worker-b" })).toBeNull();
        }));

      test("concurrent claims never hand one item to two workers", () =>
        withQueue(async ({ queue }) => {
          for (let i = 0; i < 5; i++) await queue.enqueue(item(`i${i}`, i));
          const claims = await Promise.all(
            Array.from({ length: 10 }, (_, i) => queue.claim({ ...W, workerId: `w${i}` })),
          );
          const got = claims.filter((c): c is Claim => c !== null);
          expect(got).toHaveLength(5);
          expect(new Set(got.map((c) => c.id)).size).toBe(5);
        }));

      test("an expired lease makes the item due again: a higher token, the next attempt, the same item", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a", { n: 1 }));
          const first = await claimOrFail(queue);
          clock.advance(LEASE);
          const second = await queue.claim({ ...W, workerId: "worker-b" });
          if (!second) throw new Error("expected the expired item to be reclaimed");
          expect(second.id).toBe(first.id);
          expect(second.kind).toBe(first.kind);
          expect(second.payload).toEqual({ n: 1 });
          expect(second.attempt).toBe(2);
          expect(second.token).toBeGreaterThan(first.token);
          expect(second.leaseUntil).toBe(iso(clock.now() + LEASE));
        }));

      test("redelivery has no cap", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          let last = await claimOrFail(queue);
          for (let i = 2; i <= 12; i++) {
            clock.advance(LEASE);
            const next = await claimOrFail(queue);
            expect(next.attempt).toBe(i);
            expect(next.token).toBeGreaterThan(last.token);
            last = next;
          }
        }));

      test("kinds limits the claim to those kinds", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a", "x", { kind: "x" }));
          await queue.enqueue(item("b", "y", { kind: "y" }));
          expect(await queue.claim({ ...W, kinds: ["z"] })).toBeNull();
          expect((await claimOrFail(queue, ["y"])).kind).toBe("y");
          expect(await queue.claim({ ...W, kinds: ["y"] })).toBeNull();
          expect((await claimOrFail(queue, ["x", "y"])).kind).toBe("x");
        }));

      test("the payload round-trips as JSON data", () =>
        withQueue(async ({ queue, clock }) => {
          const payload = {
            s: 'héllo ✓ "quoted" \n line',
            n: -12.5,
            i: 9007199254740991,
            b: false,
            z: null,
            a: [1, "two", { three: [3] }, []],
            o: { nested: { deep: { deeper: true } }, empty: {} },
          };
          // A millisecond apart, so due-time order fixes the claim order.
          await queue.enqueue(item("a", payload));
          clock.advance(1);
          await queue.enqueue(item("b", "a bare string"));
          clock.advance(1);
          await queue.enqueue(item("c", null));
          expect((await claimOrFail(queue)).payload).toEqual(payload);
          expect((await claimOrFail(queue)).payload).toBe("a bare string");
          expect((await claimOrFail(queue)).payload).toBeNull();
        }));

      test("rejects an empty workerId, empty kinds, and a leaseMs that is not positive, claiming nothing", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a"));
          await expect(queue.claim({ ...W, workerId: "" })).rejects.toThrow();
          await expect(queue.claim({ ...W, kinds: [] })).rejects.toThrow();
          await expect(queue.claim({ ...W, leaseMs: 0 })).rejects.toThrow();
          await expect(queue.claim({ ...W, leaseMs: -1 })).rejects.toThrow();
          await expect(queue.claim({ ...W, leaseMs: Number.NaN })).rejects.toThrow();
          expect((await claimOrFail(queue)).attempt).toBe(1);
        }));
    });

    describe("extend", () => {
      test("holds the claim for leaseMs from now, keeping id, attempt and token", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          clock.advance(LEASE - 1_000);
          const extended = await queue.extend(claim, 60_000);
          expect(extended).toEqual({ ...claim, leaseUntil: iso(clock.now() + 60_000) });
          clock.advance(59_999);
          expect(await queue.claim({ ...W, workerId: "worker-b" })).toBeNull();
          clock.advance(1);
          expect(await queue.claim({ ...W, workerId: "worker-b" })).not.toBeNull();
        }));

      test("an expired claim nobody has taken can still be extended", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          clock.advance(LEASE * 2);
          const extended = await queue.extend(claim, LEASE);
          expect(extended.token).toBe(claim.token);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("a claim superseded by a reclaim is refused as superseded", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const stale = await claimOrFail(queue);
          clock.advance(LEASE);
          const current = await claimOrFail(queue);
          await expectLeaseLost(queue.extend(stale, LEASE), stale, "superseded");
          await queue.extend(current, LEASE);
          await queue.complete(current);
        }));

      test("a completed claim is refused as settled", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          await queue.complete(claim);
          await expectLeaseLost(queue.extend(claim, LEASE), claim, "settled");
        }));

      test("a failed claim is refused as settled, retried or terminal", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await queue.enqueue(item("b"));
          const retried = await claimOrFail(queue);
          const terminal = await claimOrFail(queue);
          await queue.fail(retried, { error: "x", retryAt: iso(clock.now() + 60_000) });
          await queue.fail(terminal, { error: "x" });
          await expectLeaseLost(queue.extend(retried, LEASE), retried, "settled");
          await expectLeaseLost(queue.extend(terminal, LEASE), terminal, "settled");
        }));

      test("rejects a leaseMs that is not positive, changing nothing", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          await expect(queue.extend(claim, 0)).rejects.toThrow();
          clock.advance(LEASE);
          expect((await claimOrFail(queue)).attempt).toBe(2);
        }));
    });

    describe("complete", () => {
      test("a completed item is never claimed again", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await queue.complete(await claimOrFail(queue));
          clock.advance(LEASE * 10);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("an expired claim nobody has taken can still complete", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          clock.advance(LEASE * 2);
          await queue.complete(claim);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("completing again succeeds and changes nothing", () =>
        withQueue(async ({ queue, clock }) => {
          const { id } = await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          await queue.complete(claim);
          await queue.complete(claim);
          clock.advance(LEASE * 10);
          expect(await queue.claim(W)).toBeNull();
          expect(await queue.enqueue(item("a"))).toEqual({ id, created: false });
        }));

      test("a superseded claim is refused as superseded, and the current holder keeps the item", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const stale = await claimOrFail(queue);
          clock.advance(LEASE);
          const current = await claimOrFail(queue);
          await expectLeaseLost(queue.complete(stale), stale, "superseded");
          expect(await queue.claim(W)).toBeNull();
          await queue.complete(current);
        }));

      test("a claim settled by fail is refused as settled", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          await queue.fail(claim, { error: "x" });
          await expectLeaseLost(queue.complete(claim), claim, "settled");
        }));

      test("a claim whose item is forgotten is refused as gone", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          await queue.complete(claim);
          clock.advance(WORK_QUEUE_RETENTION_MS);
          await queue.claim(W);
          // Forgetting is allowed, not required: only a forgotten item is gone.
          if ((await queue.enqueue(item("a"))).created) {
            await expectLeaseLost(queue.complete(claim), claim, "gone");
            await expectLeaseLost(queue.extend(claim, LEASE), claim, "gone");
          }
        }));

      test("racing complete and fail of one claim: exactly one wins, the other is refused as settled", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          const results = await Promise.allSettled([
            queue.complete(claim),
            queue.fail(claim, { error: "x" }),
          ]);
          const won = results.filter((r) => r.status === "fulfilled");
          const lost = results.filter((r) => r.status === "rejected");
          expect(won).toHaveLength(1);
          expect(lost).toHaveLength(1);
          const reason = (lost[0] as PromiseRejectedResult).reason;
          expect(reason).toBeInstanceOf(LeaseLostError);
          if (reason instanceof LeaseLostError) expect(reason.reason).toBe("settled");
        }));
    });

    describe("fail", () => {
      test("with retryAt, the item is due again at retryAt as the next attempt", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a", { n: 1 }));
          const first = await claimOrFail(queue);
          await queue.fail(first, { error: "transient", retryAt: iso(clock.now() + 5_000) });
          clock.advance(4_999);
          expect(await queue.claim(W)).toBeNull();
          clock.advance(1);
          const second = await claimOrFail(queue);
          expect(second.id).toBe(first.id);
          expect(second.payload).toEqual({ n: 1 });
          expect(second.attempt).toBe(2);
          expect(second.token).toBeGreaterThan(first.token);
        }));

      test("a retryAt in the past is due at once", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await queue.fail(await claimOrFail(queue), {
            error: "transient",
            retryAt: iso(clock.now() - 1_000),
          });
          expect((await claimOrFail(queue)).attempt).toBe(2);
        }));

      test("a retried item is ordered by its retryAt in its scope", () =>
        withQueue(async ({ queue, clock }) => {
          const t = clock.now();
          await queue.enqueue(item("a", "retried"));
          await queue.enqueue(item("b", "waiting", { notBefore: iso(t + 2_000) }));
          await queue.fail(await claimOrFail(queue), { error: "x", retryAt: iso(t + 3_000) });
          clock.advance(3_000);
          expect((await claimOrFail(queue)).payload).toBe("waiting");
          expect((await claimOrFail(queue)).payload).toBe("retried");
        }));

      test("without retryAt, the item fails terminally and is never claimed again", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await queue.fail(await claimOrFail(queue), { error: "permanent" });
          clock.advance(WORK_QUEUE_RETENTION_MS - 1);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("failing again the same way succeeds and changes nothing", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await queue.enqueue(item("b"));
          const retried = await claimOrFail(queue);
          const terminal = await claimOrFail(queue);
          const retryAt = iso(clock.now() + 5_000);
          await queue.fail(retried, { error: "x", retryAt });
          await queue.fail(retried, { error: "x", retryAt });
          await queue.fail(terminal, { error: "x" });
          await queue.fail(terminal, { error: "x" });
          clock.advance(4_999);
          expect(await queue.claim(W)).toBeNull();
          clock.advance(1);
          const next = await claimOrFail(queue);
          expect(next.id).toBe(retried.id);
          expect(next.attempt).toBe(2);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("a different fail of a settled claim is refused as settled", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          await queue.enqueue(item("b"));
          const retried = await claimOrFail(queue);
          const terminal = await claimOrFail(queue);
          await queue.fail(retried, { error: "x", retryAt: iso(clock.now() + 5_000) });
          await queue.fail(terminal, { error: "x" });
          await expectLeaseLost(
            queue.fail(retried, { error: "x", retryAt: iso(clock.now() + 9_000) }),
            retried,
            "settled",
          );
          await expectLeaseLost(queue.fail(retried, { error: "x" }), retried, "settled");
          await expectLeaseLost(queue.complete(retried), retried, "settled");
          await expectLeaseLost(
            queue.fail(terminal, { error: "x", retryAt: iso(clock.now()) }),
            terminal,
            "settled",
          );
        }));

      test("a retried claim is refused as superseded once the item is claimed again", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const first = await claimOrFail(queue);
          const retryAt = iso(clock.now());
          await queue.fail(first, { error: "x", retryAt });
          await claimOrFail(queue);
          await expectLeaseLost(queue.fail(first, { error: "x", retryAt }), first, "superseded");
        }));

      test("a superseded claim is refused as superseded, and the item is unchanged", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const stale = await claimOrFail(queue);
          clock.advance(LEASE);
          const current = await claimOrFail(queue);
          await expectLeaseLost(
            queue.fail(stale, { error: "late", retryAt: iso(clock.now()) }),
            stale,
            "superseded",
          );
          await expectLeaseLost(queue.fail(stale, { error: "late" }), stale, "superseded");
          expect(await queue.claim(W)).toBeNull();
          await queue.complete(current);
        }));

      test("rejects a retryAt that is not RFC 3339 with an offset, keeping lease, attempt and token", () =>
        withQueue(async ({ queue, clock }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          for (const retryAt of ["soon", "2026-01-01T01:00:00", "2026-01-01"]) {
            await expect(queue.fail(claim, { error: "x", retryAt })).rejects.toThrow();
          }
          // Still held: nobody else can claim it before its lease ends.
          clock.advance(LEASE - 1);
          expect(await queue.claim({ ...W, workerId: "worker-b" })).toBeNull();
          expect((await queue.extend(claim, LEASE)).token).toBe(claim.token);
          clock.advance(LEASE);
          const next = await claimOrFail(queue);
          expect(next.attempt).toBe(2);
          expect(next.token).toBeGreaterThan(claim.token);
        }));
    });

    describe("close", () => {
      test("is idempotent, and every other method rejects after it", () =>
        withQueue(async ({ queue }) => {
          await queue.enqueue(item("a"));
          const claim = await claimOrFail(queue);
          await queue.close();
          await queue.close();
          await expect(queue.enqueue(item("b"))).rejects.toThrow();
          await expect(queue.claim(W)).rejects.toThrow();
          await expect(queue.extend(claim, LEASE)).rejects.toThrow();
          await expect(queue.complete(claim)).rejects.toThrow();
          await expect(queue.fail(claim, { error: "x" })).rejects.toThrow();
        }));
    });

    const durableTest = capabilities.durable ? test : test.skip;
    describe("durability", () => {
      durableTest(
        capabilities.durable
          ? "a queue opened again on the store shows every item as it was"
          : "skipped: the implementation does not state it is durable",
        async () => {
          const h = await open();
          try {
            if (!h.reopen) throw new Error("a durable implementation's harness provides reopen");
            const { clock } = h;
            // A millisecond apart, so due-time order fixes the claim order.
            await h.queue.enqueue(item("held"));
            clock.advance(1);
            await h.queue.enqueue(item("done"));
            clock.advance(1);
            await h.queue.enqueue(item("waiting"));
            await h.queue.enqueue(item("later", "later", { notBefore: iso(clock.now() + 60_000) }));
            const held = await claimOrFail(h.queue);
            const done = await claimOrFail(h.queue);
            await h.queue.complete(done);

            const reopened = await h.reopen();
            await reopened.extend(held, LEASE);
            await reopened.complete(done);
            expect((await reopened.enqueue(item("done"))).created).toBe(false);
            const waiting = await claimOrFail(reopened);
            expect(waiting.payload).toBe("waiting");
            expect(waiting.attempt).toBe(1);
            await reopened.complete(waiting);
            expect(await reopened.claim(W)).toBeNull();
            clock.advance(60_000);
            const rest = [await claimOrFail(reopened), await claimOrFail(reopened)];
            expect(rest.map((c) => [c.payload, c.attempt]).sort()).toEqual([
              ["held", 2],
              ["later", 1],
            ]);
          } finally {
            await h.cleanup();
          }
        },
      );
    });

    const peerTest = capabilities.peers ? test : test.skip;
    const peerName = (name: string) =>
      capabilities.peers ? name : `skipped: no second instance (multiProcess is false): ${name}`;
    describe("several instances on one store", () => {
      async function withPeers(
        fn: (a: WorkQueue, b: WorkQueue, h: WorkQueueHarness) => Promise<void>,
      ): Promise<void> {
        const h = await open();
        try {
          if (!h.openPeer) throw new Error("a multi-process harness provides openPeer");
          await fn(h.queue, await h.openPeer(), h);
        } finally {
          await h.cleanup();
        }
      }

      peerTest(peerName("racing enqueues of one key across instances create one item"), () =>
        withPeers(async (a, b) => {
          const results = await Promise.all([
            ...Array.from({ length: 4 }, () => a.enqueue(item("k1"))),
            ...Array.from({ length: 4 }, () => b.enqueue(item("k1"))),
          ]);
          expect(results.filter((r) => r.created)).toHaveLength(1);
          expect(new Set(results.map((r) => r.id)).size).toBe(1);
        }),
      );

      peerTest(peerName("racing claims across instances never hand one item to two workers"), () =>
        withPeers(async (a, b) => {
          for (let i = 0; i < 6; i++) await a.enqueue(item(`i${i}`, i));
          const claims = await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
              (i % 2 ? a : b).claim({ ...W, workerId: `w${i}` }),
            ),
          );
          const got = claims.filter((c): c is Claim => c !== null);
          expect(got).toHaveLength(6);
          expect(new Set(got.map((c) => c.id)).size).toBe(6);
        }),
      );

      peerTest(peerName("a claim taken on one instance is fenced and settled on the other"), () =>
        withPeers(async (a, b, { clock }) => {
          await a.enqueue(item("k1"));
          const stale = await claimOrFail(a);
          clock.advance(LEASE);
          const current = await claimOrFail(b);
          await expectLeaseLost(a.complete(stale), stale, "superseded");
          await b.complete(current);
          await a.complete(current);
          await expectLeaseLost(a.fail(current, { error: "x" }), current, "settled");
        }),
      );
    });
  });
}
