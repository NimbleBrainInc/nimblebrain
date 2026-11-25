import { describe, expect, test } from "bun:test";
import {
  type Claim,
  LeaseLostError,
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
 * The queue decides on its own clock, so the harness hands the implementation
 * a clock it controls; an implementation under test takes its time from it.
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
  cleanup: () => Promise<void>;
}

const LEASE = 30_000;
const W = { workerId: "worker-a", leaseMs: LEASE };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Expect `promise` to reject with a `LeaseLostError` naming `claim`. */
async function expectLeaseLost(promise: Promise<unknown>, claim: Claim): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LeaseLostError);
  if (err instanceof LeaseLostError) {
    expect(err.code).toBe("lease_lost");
    expect(err.itemId).toBe(claim.id);
    expect(err.token).toBe(claim.token);
  }
}

async function claimOrFail(queue: WorkQueue, kinds?: string[]): Promise<Claim> {
  const claim = await queue.claim(kinds ? { ...W, kinds } : W);
  if (!claim) throw new Error("expected a due item, got none");
  return claim;
}

/**
 * Run the interface suite against one implementation. `label` names it in the
 * test output; `open` builds a fresh, empty queue on the given clock.
 */
export function describeWorkQueueConformance(
  label: string,
  open: (clock: TestClock) => Promise<WorkQueueHarness>,
): void {
  async function withQueue(
    fn: (queue: WorkQueue, clock: TestClock) => Promise<void>,
  ): Promise<void> {
    const clock = createTestClock();
    const { queue, cleanup } = await open(clock);
    try {
      await fn(queue, clock);
    } finally {
      await cleanup();
    }
  }

  describe(`${label} — WorkQueue conformance`, () => {
    test("multiProcess is a boolean", () =>
      withQueue(async (queue) => {
        expect(typeof queue.multiProcess).toBe("boolean");
      }));

    describe("enqueue", () => {
      test("a new key creates an item", () =>
        withQueue(async (queue) => {
          const r = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          expect(r.created).toBe(true);
          expect(typeof r.id).toBe("string");
          expect(r.id.length).toBeGreaterThan(0);
        }));

      test("distinct keys are distinct items", () =>
        withQueue(async (queue) => {
          const a = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const b = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "b" });
          expect(a.id).not.toBe(b.id);
        }));

      test("the same key while pending returns the same item, created false", () =>
        withQueue(async (queue) => {
          const a = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const again = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          expect(again).toEqual({ id: a.id, created: false });
          await claimOrFail(queue);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("the same key while claimed returns the same item and leaves the claim alone", () =>
        withQueue(async (queue) => {
          const a = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          expect(await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" })).toEqual({
            id: a.id,
            created: false,
          });
          expect(await queue.claim(W)).toBeNull();
          await queue.complete(claim);
        }));

      test("the same key after completion, within retention, returns the item and enqueues nothing", () =>
        withQueue(async (queue, clock) => {
          const a = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await queue.complete(await claimOrFail(queue));
          clock.advance(WORK_QUEUE_RETENTION_MS - 1);
          expect(await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" })).toEqual({
            id: a.id,
            created: false,
          });
          expect(await queue.claim(W)).toBeNull();
        }));

      test("the same key after a terminal fail, within retention, returns the item and enqueues nothing", () =>
        withQueue(async (queue, clock) => {
          const a = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await queue.fail(await claimOrFail(queue), { error: "boom" });
          clock.advance(WORK_QUEUE_RETENTION_MS - 1);
          expect(await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" })).toEqual({
            id: a.id,
            created: false,
          });
          expect(await queue.claim(W)).toBeNull();
        }));

      test("the first enqueue's kind, payload and notBefore stand; a repeat's are ignored", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "first", payload: { v: 1 }, idempotencyKey: "a" });
          await queue.enqueue({
            kind: "second",
            payload: { v: 2 },
            idempotencyKey: "a",
            notBefore: iso(clock.now() + 60_000),
          });
          const claim = await claimOrFail(queue);
          expect(claim.kind).toBe("first");
          expect(claim.payload).toEqual({ v: 1 });
        }));

      test("rejects an empty kind, an empty key, and an invalid notBefore, creating nothing", () =>
        withQueue(async (queue) => {
          await expect(
            queue.enqueue({ kind: "", payload: 1, idempotencyKey: "a" }),
          ).rejects.toThrow();
          await expect(
            queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "" }),
          ).rejects.toThrow();
          await expect(
            queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a", notBefore: "not a time" }),
          ).rejects.toThrow();
          expect(await queue.claim(W)).toBeNull();
          expect(
            (await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" })).created,
          ).toBe(true);
        }));
    });

    describe("claim", () => {
      test("returns null when nothing is enqueued", () =>
        withQueue(async (queue) => {
          expect(await queue.claim(W)).toBeNull();
        }));

      test("an item is not due before notBefore, and is due at it", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({
            kind: "k",
            payload: 1,
            idempotencyKey: "a",
            notBefore: iso(clock.now() + 10_000),
          });
          clock.advance(9_999);
          expect(await queue.claim(W)).toBeNull();
          clock.advance(1);
          expect(await queue.claim(W)).not.toBeNull();
        }));

      test("a notBefore in the past is due at once", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({
            kind: "k",
            payload: 1,
            idempotencyKey: "a",
            notBefore: iso(clock.now() - 10_000),
          });
          expect(await queue.claim(W)).not.toBeNull();
        }));

      test("the earliest due time is claimed first, whatever the enqueue order", () =>
        withQueue(async (queue, clock) => {
          const t = clock.now();
          await queue.enqueue({
            kind: "k",
            payload: "late",
            idempotencyKey: "a",
            notBefore: iso(t - 1_000),
          });
          await queue.enqueue({
            kind: "k",
            payload: "early",
            idempotencyKey: "b",
            notBefore: iso(t - 5_000),
          });
          clock.advance(1);
          await queue.enqueue({ kind: "k", payload: "now", idempotencyKey: "c" });
          expect((await claimOrFail(queue)).payload).toBe("early");
          expect((await claimOrFail(queue)).payload).toBe("late");
          expect((await claimOrFail(queue)).payload).toBe("now");
          expect(await queue.claim(W)).toBeNull();
        }));

      test("ties in due time go to the item enqueued first", () =>
        withQueue(async (queue) => {
          for (const key of ["c", "a", "b"]) {
            await queue.enqueue({ kind: "k", payload: key, idempotencyKey: key });
          }
          expect((await claimOrFail(queue)).payload).toBe("c");
          expect((await claimOrFail(queue)).payload).toBe("a");
          expect((await claimOrFail(queue)).payload).toBe("b");
        }));

      test("the first claim is attempt 1, leased until now plus leaseMs, with the item's id and kind", () =>
        withQueue(async (queue, clock) => {
          const { id } = await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          expect(claim.id).toBe(id);
          expect(claim.kind).toBe("k");
          expect(claim.attempt).toBe(1);
          expect(typeof claim.token).toBe("number");
          expect(claim.leaseUntil).toBe(iso(clock.now() + LEASE));
        }));

      test("an item is claimed once while its lease holds", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await claimOrFail(queue);
          expect(await queue.claim({ workerId: "worker-b", leaseMs: LEASE })).toBeNull();
          clock.advance(LEASE - 1);
          expect(await queue.claim({ workerId: "worker-b", leaseMs: LEASE })).toBeNull();
        }));

      test("concurrent claims never hand one item to two workers", () =>
        withQueue(async (queue) => {
          for (let i = 0; i < 5; i++) {
            await queue.enqueue({ kind: "k", payload: i, idempotencyKey: `i${i}` });
          }
          const claims = await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
              queue.claim({ workerId: `w${i}`, leaseMs: LEASE }),
            ),
          );
          const got = claims.filter((c): c is Claim => c !== null);
          expect(got).toHaveLength(5);
          expect(new Set(got.map((c) => c.id)).size).toBe(5);
        }));

      test("an expired lease makes the item due again: a higher token, the next attempt, the same item", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: { n: 1 }, idempotencyKey: "a" });
          const first = await claimOrFail(queue);
          clock.advance(LEASE);
          const second = await queue.claim({ workerId: "worker-b", leaseMs: LEASE });
          if (!second) throw new Error("expected the expired item to be reclaimed");
          expect(second.id).toBe(first.id);
          expect(second.kind).toBe(first.kind);
          expect(second.payload).toEqual({ n: 1 });
          expect(second.attempt).toBe(2);
          expect(second.token).toBeGreaterThan(first.token);
          expect(second.leaseUntil).toBe(iso(clock.now() + LEASE));
        }));

      test("an expired claim is due at its leaseUntil, ordered among pending items by it", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: "leased", idempotencyKey: "a" });
          await claimOrFail(queue);
          // Due 1 ms after the lease expires.
          await queue.enqueue({
            kind: "k",
            payload: "pending",
            idempotencyKey: "b",
            notBefore: iso(clock.now() + LEASE + 1),
          });
          clock.advance(LEASE + 1);
          expect((await claimOrFail(queue)).payload).toBe("leased");
          expect((await claimOrFail(queue)).payload).toBe("pending");
        }));

      test("kinds limits the claim to those kinds; absent takes any; empty takes none", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "x", payload: "x", idempotencyKey: "a" });
          await queue.enqueue({ kind: "y", payload: "y", idempotencyKey: "b" });
          expect(await queue.claim({ ...W, kinds: [] })).toBeNull();
          expect(await queue.claim({ ...W, kinds: ["z"] })).toBeNull();
          expect((await claimOrFail(queue, ["y"])).kind).toBe("y");
          expect(await queue.claim({ ...W, kinds: ["y"] })).toBeNull();
          expect((await claimOrFail(queue)).kind).toBe("x");
        }));

      test("the payload round-trips as JSON data", () =>
        withQueue(async (queue) => {
          const payload = {
            s: 'héllo ✓ "quoted" \n line',
            n: -12.5,
            i: 9007199254740991,
            b: false,
            z: null,
            a: [1, "two", { three: [3] }, []],
            o: { nested: { deep: { deeper: true } }, empty: {} },
          };
          await queue.enqueue({ kind: "k", payload, idempotencyKey: "a" });
          await queue.enqueue({ kind: "k", payload: "a bare string", idempotencyKey: "b" });
          await queue.enqueue({ kind: "k", payload: null, idempotencyKey: "c" });
          expect((await claimOrFail(queue)).payload).toEqual(payload);
          expect((await claimOrFail(queue)).payload).toBe("a bare string");
          expect((await claimOrFail(queue)).payload).toBeNull();
        }));

      test("rejects an empty workerId and a leaseMs that is not positive", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await expect(queue.claim({ workerId: "", leaseMs: LEASE })).rejects.toThrow();
          await expect(queue.claim({ workerId: "w", leaseMs: 0 })).rejects.toThrow();
          await expect(queue.claim({ workerId: "w", leaseMs: -1 })).rejects.toThrow();
          await expect(queue.claim({ workerId: "w", leaseMs: Number.NaN })).rejects.toThrow();
          expect((await claimOrFail(queue)).attempt).toBe(1);
        }));
    });

    describe("extend", () => {
      test("holds the claim for leaseMs from now, keeping id, attempt and token", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          clock.advance(LEASE - 1_000);
          const extended = await queue.extend(claim, 60_000);
          expect(extended).toEqual({ ...claim, leaseUntil: iso(clock.now() + 60_000) });
          clock.advance(59_999);
          expect(await queue.claim({ workerId: "worker-b", leaseMs: LEASE })).toBeNull();
          clock.advance(1);
          expect(await queue.claim({ workerId: "worker-b", leaseMs: LEASE })).not.toBeNull();
        }));

      test("an expired claim nobody has taken can still be extended", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          clock.advance(LEASE * 2);
          const extended = await queue.extend(claim, LEASE);
          expect(extended.token).toBe(claim.token);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("a claim superseded by a reclaim is refused with LeaseLostError", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const stale = await claimOrFail(queue);
          clock.advance(LEASE);
          const current = await claimOrFail(queue);
          await expectLeaseLost(queue.extend(stale, LEASE), stale);
          // The refusal changed nothing for the current holder.
          await queue.extend(current, LEASE);
          await queue.complete(current);
        }));

      test("a settled claim is refused with LeaseLostError", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          await queue.complete(claim);
          await expectLeaseLost(queue.extend(claim, LEASE), claim);
        }));

      test("rejects a leaseMs that is not positive", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          await expect(queue.extend(claim, 0)).rejects.toThrow();
        }));
    });

    describe("complete", () => {
      test("a completed item is never claimed again", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await queue.complete(await claimOrFail(queue));
          clock.advance(LEASE * 10);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("an expired claim nobody has taken can still complete", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          clock.advance(LEASE * 2);
          await queue.complete(claim);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("a superseded claim is refused with LeaseLostError, and the current holder keeps the item", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const stale = await claimOrFail(queue);
          clock.advance(LEASE);
          const current = await claimOrFail(queue);
          await expectLeaseLost(queue.complete(stale), stale);
          expect(await queue.claim(W)).toBeNull();
          await queue.complete(current);
        }));

      test("a second settle of the same claim is refused with LeaseLostError", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          await queue.complete(claim);
          await expectLeaseLost(queue.complete(claim), claim);
          await expectLeaseLost(queue.fail(claim, { error: "late" }), claim);
        }));
    });

    describe("fail", () => {
      test("with retryAt, the item is due again at retryAt as the next attempt", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: { n: 1 }, idempotencyKey: "a" });
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
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await queue.fail(await claimOrFail(queue), {
            error: "transient",
            retryAt: iso(clock.now() - 1_000),
          });
          expect((await claimOrFail(queue)).attempt).toBe(2);
        }));

      test("a retried item is ordered by its retryAt among pending items", () =>
        withQueue(async (queue, clock) => {
          const t = clock.now();
          await queue.enqueue({ kind: "k", payload: "retried", idempotencyKey: "a" });
          await queue.enqueue({
            kind: "k",
            payload: "waiting",
            idempotencyKey: "b",
            notBefore: iso(t + 2_000),
          });
          await queue.fail(await claimOrFail(queue), { error: "x", retryAt: iso(t + 3_000) });
          clock.advance(3_000);
          expect((await claimOrFail(queue)).payload).toBe("waiting");
          expect((await claimOrFail(queue)).payload).toBe("retried");
        }));

      test("without retryAt, the item fails terminally and is never claimed again", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          await queue.fail(await claimOrFail(queue), { error: "permanent" });
          clock.advance(WORK_QUEUE_RETENTION_MS - 1);
          expect(await queue.claim(W)).toBeNull();
        }));

      test("a superseded claim is refused with LeaseLostError, and the item is unchanged", () =>
        withQueue(async (queue, clock) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const stale = await claimOrFail(queue);
          clock.advance(LEASE);
          const current = await claimOrFail(queue);
          await expectLeaseLost(
            queue.fail(stale, { error: "late", retryAt: iso(clock.now()) }),
            stale,
          );
          await expectLeaseLost(queue.fail(stale, { error: "late" }), stale);
          expect(await queue.claim(W)).toBeNull();
          await queue.complete(current);
        }));

      test("rejects an invalid retryAt, changing nothing", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          await expect(queue.fail(claim, { error: "x", retryAt: "soon" })).rejects.toThrow();
          await queue.complete(claim);
        }));
    });

    describe("close", () => {
      test("is idempotent, and every other method rejects after it", () =>
        withQueue(async (queue) => {
          await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
          const claim = await claimOrFail(queue);
          await queue.close();
          await queue.close();
          await expect(
            queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "b" }),
          ).rejects.toThrow();
          await expect(queue.claim(W)).rejects.toThrow();
          await expect(queue.extend(claim, LEASE)).rejects.toThrow();
          await expect(queue.complete(claim)).rejects.toThrow();
          await expect(queue.fail(claim, { error: "x" })).rejects.toThrow();
        }));
    });
  });
}
