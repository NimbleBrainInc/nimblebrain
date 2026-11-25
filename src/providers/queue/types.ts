/**
 * The work queue provider (ADR-0076, "Providers carry the infrastructure").
 *
 * A trigger (a schedule, an event, a person asking for a run) decides that
 * work is due and enqueues it; a worker claims it under a lease, does it, and
 * settles it. This file is the contract every implementation is held to, and
 * `test/helpers/work-queue-conformance.ts` tests each rule stated here.
 *
 * ## Delivery
 *
 * Delivery is **at least once, fenced**. Exactly-once execution is not
 * promised: a worker that stops (or stalls past its lease) after starting the
 * work leaves an item that the next claim hands out again, with a higher
 * `attempt` and a higher `token`. The queue guarantees only that at most one
 * claim of an item is current at a time, and that a superseded claim can no
 * longer extend or settle the item. A consumer whose work has side effects
 * reads `attempt > 1` as "an earlier claim may have done some of this" and
 * decides for itself whether to repeat it, and may pass `token` to its own
 * stores to refuse a superseded worker's writes.
 *
 * ## Clock
 *
 * Every time the queue reads or returns is an ISO 8601 string, and every
 * decision is taken on the provider's clock, never the caller's: whether an
 * item is due, when a lease expires, when retention ends. `notBefore` and
 * `retryAt` are instants the caller names; the provider compares them with
 * its own clock. A caller uses `leaseUntil` to plan when to extend, never to
 * decide whether it still holds the claim: only `extend`, `complete` and
 * `fail` answer that.
 *
 * ## Item states
 *
 * - **pending**: enqueued, or failed with a `retryAt`; due once its due time
 *   has passed.
 * - **claimed**: handed to a worker until `leaseUntil`.
 * - **completed** / **failed**: terminal. A terminal item is never claimed
 *   again, and its idempotency key stays taken for `WORK_QUEUE_RETENTION_MS`.
 *
 * An item is **due** at instant `now` (the provider's clock) when it is
 * pending and its due time is at or before `now`, or claimed and its
 * `leaseUntil` is at or before `now` (the lease has expired). A pending item's
 * due time is its `notBefore`, or its enqueue time when it has none, or the
 * `retryAt` of the `fail` that made it pending again. An expired claimed
 * item's due time is its `leaseUntil`.
 *
 * A claim is **lost** when its item has been claimed again since (its token is
 * stale), when the claim has already been settled by `complete` or `fail`, or
 * when the item no longer exists. A claim whose lease has expired but whose
 * item nobody has claimed again is not lost: its holder may still extend,
 * complete or fail it.
 */

/**
 * How long a terminal item keeps its idempotency key after it completes or
 * fails terminally: an `enqueue` with that key inside the window returns the
 * terminal item (`created: false`) and enqueues nothing. Every implementation
 * keeps a terminal item at least this long; after it, the implementation may
 * forget the item, and an `enqueue` with the key may create a new one.
 *
 * The queue's key catches a trigger that fires twice for one piece of work
 * (two processes deciding the same occurrence is due, a retried request, a
 * restart replaying what it had decided). A consumer that must refuse a repeat
 * for longer keeps its own record.
 */
export const WORK_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** What a trigger asks the queue to hold. */
export interface EnqueueRequest {
  /**
   * What kind of work this is, chosen by the consumer (for example
   * `task.run`). Non-empty. Workers filter claims by it.
   */
  kind: string;
  /**
   * The work's description: JSON data (objects, arrays, strings, finite
   * numbers, booleans, null). A claim returns a value deep-equal to it. A
   * value JSON cannot represent is outside the contract.
   */
  payload: unknown;
  /** Names the piece of work; one key is one item. Non-empty. */
  idempotencyKey: string;
  /** The item is not due before this instant (ISO 8601). Absent: due when enqueued. */
  notBefore?: string;
}

export interface EnqueueResult {
  /** The item's id. Unique per item, including a later item under a forgotten key. */
  id: string;
  /** True when this call created the item; false when the key already named one. */
  created: boolean;
}

export interface ClaimRequest {
  /** Who is claiming, for an operator reading the queue. Non-empty; decides nothing. */
  workerId: string;
  /** How long the claim holds before the item is due again, in milliseconds. A positive number. */
  leaseMs: number;
  /** Claim only items of these kinds. Absent: any kind. Empty: none, so the claim returns null. */
  kinds?: string[];
}

/** A worker's hold on one item, from `claim` or `extend`. */
export interface Claim {
  /** The item's id, as `enqueue` returned it. */
  id: string;
  /** The item's kind, as enqueued. */
  kind: string;
  /** The item's payload, deep-equal to what was enqueued. */
  payload: unknown;
  /** How many times the item has been claimed, this claim included: 1 on the first. */
  attempt: number;
  /**
   * The fencing token: strictly greater than the token of every earlier claim
   * of this item. Compare tokens only for order and equality; their values
   * carry no other meaning, and need not be consecutive.
   */
  token: number;
  /** When this claim's lease expires (ISO 8601, the provider's clock). */
  leaseUntil: string;
}

export interface FailOptions {
  /** Why the attempt failed, kept on the item for an operator. Decides nothing. */
  error: string;
  /**
   * Make the item pending again, due at this instant (ISO 8601; one in the past
   * is due at once). Absent: the item fails terminally.
   */
  retryAt?: string;
}

/**
 * Refused because the claim is lost: its item was claimed again since, the
 * claim was already settled, or the item no longer exists. The holder stops
 * working on the item and writes nothing more for it.
 */
export class LeaseLostError extends Error {
  readonly code = "lease_lost";
  constructor(
    readonly itemId: string,
    readonly token: number,
  ) {
    super(`The claim on work item ${itemId} (token ${token}) is no longer current.`);
    this.name = "LeaseLostError";
  }
}

export interface WorkQueue {
  /**
   * Hold a piece of work until a worker claims it.
   *
   * Idempotent per key: while an item with this `idempotencyKey` exists,
   * pending, claimed, or terminal within `WORK_QUEUE_RETENTION_MS`, the call
   * changes nothing and returns that item's id with `created: false`. The
   * first enqueue's `kind`, `payload` and `notBefore` stand; a repeat's are
   * ignored, so a key must name the work exactly.
   *
   * Rejects an empty `kind` or `idempotencyKey` and a `notBefore` that is not
   * a valid instant, creating nothing.
   */
  enqueue(item: EnqueueRequest): Promise<EnqueueResult>;

  /**
   * Take at most one due item (see "Item states") and hold it for `leaseMs`.
   *
   * Among the due items whose kind passes `kinds`, returns the one with the
   * earliest due time, ties going to the item enqueued first. The returned
   * claim's `attempt` is one more than the item's last, its `token` is greater
   * than every earlier claim's, and its `leaseUntil` is the provider's now
   * plus `leaseMs`; any earlier claim of the item is lost from this moment.
   * Returns null when no item is due. Never returns one item to two claims
   * whose leases overlap.
   *
   * Rejects an empty `workerId` and a `leaseMs` that is not a positive number.
   */
  claim(request: ClaimRequest): Promise<Claim | null>;

  /**
   * Hold the claim for `leaseMs` more, counted from the provider's now (not
   * from the old `leaseUntil`). Returns the claim with its new `leaseUntil`;
   * `id`, `attempt` and `token` are unchanged.
   *
   * Throws `LeaseLostError` when the claim is lost. Rejects a `leaseMs` that is
   * not a positive number.
   */
  extend(claim: Claim, leaseMs: number): Promise<Claim>;

  /**
   * Settle the item as done. It is terminal: never claimed again, and its key
   * stays taken for `WORK_QUEUE_RETENTION_MS`.
   *
   * Throws `LeaseLostError` when the claim is lost, a second `complete` or
   * `fail` of the same claim included.
   */
  complete(claim: Claim): Promise<void>;

  /**
   * Settle the attempt as failed. With `retryAt`, the item is pending again and
   * due at `retryAt`, and its next claim counts as the next attempt. Without
   * it, the item fails terminally, as `complete` settles it, keeping `error`.
   *
   * Throws `LeaseLostError` when the claim is lost. Rejects a `retryAt` that is
   * not a valid instant, changing nothing.
   */
  fail(claim: Claim, options: FailOptions): Promise<void>;

  /**
   * Release what the queue holds (a lock, a connection). Idempotent. Every
   * other method rejects once it has been called. Items are kept: a queue
   * opened again on the same store sees them as they were.
   */
  close(): Promise<void>;

  /**
   * Whether more than one runtime process may use this queue's store at once.
   * A queue that says false serves one process only, so a deployment of
   * several runtime processes needs one that says true (ADR-0076).
   */
  readonly multiProcess: boolean;
}
