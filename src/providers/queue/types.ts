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
 * `attempt` and a higher `token`. Redelivery has no cap: the queue hands an
 * item out again as often as its claims are lost, and a consumer reads
 * `attempt` to decide when to stop repeating the work (`attempt > 1` means an
 * earlier claim may have done some of it).
 *
 * The queue guarantees that at most one claim of an item is current at a
 * time, and that a superseded claim can no longer extend or settle the item.
 * The `token` fences records keyed by the item's id: a consumer's store that
 * keeps the highest token it has seen for an item can refuse a superseded
 * worker's writes. Exclusion across items (one run per task at a time) is not
 * the queue's job; it belongs to the Leases provider (ADR-0076).
 *
 * ## What an implementation needs
 *
 * Every state change is a conditional update on one item: claim takes an item
 * only if it is still due, and extend and settle apply only if the claim's
 * token is still the item's. So an implementation needs an atomic
 * compare-and-set per item, and a unique constraint on (scope, key). A queue
 * that cannot express those (SQS, plain Redis Streams) cannot implement this
 * contract as it stands.
 *
 * ## Clock and time format
 *
 * Every decision is taken on the provider's clock, never the caller's: whether
 * an item is due, when a lease expires, when retention ends. `notBefore` and
 * `retryAt` are instants the caller names, as RFC 3339 date-times with `Z` or
 * an explicit offset (`2026-01-01T09:00:00Z`, `2026-01-01T09:00:00.000-10:00`);
 * any other form, an offsetless one included, and any date-time that names
 * no real instant (`2026-02-30`, hour `24`, second `60`) is rejected and
 * changes nothing. Every time the queue returns is UTC with `Z` and millisecond
 * precision (`2026-01-01T19:00:00.000Z`). A caller uses `leaseUntil` to plan
 * when to extend, never to decide whether it still holds the claim: only
 * `extend`, `complete` and `fail` answer that.
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
 * A claim is **lost** in three ways, which `LeaseLostError.reason` names:
 * `superseded`, the item has been claimed again since; `settled`, the claim
 * was settled one way and is now asked to settle another way or to extend;
 * `gone`, the item no longer exists. A claim whose lease has expired but whose
 * item nobody has claimed again is not lost: its holder may still extend,
 * complete or fail it.
 */

/**
 * How long a terminal item keeps its idempotency key after it completes or
 * fails terminally: an `enqueue` with that scope and key inside the window
 * returns the terminal item (`created: false`) and enqueues nothing. After
 * it, the implementation may forget the item, and an `enqueue` with the key
 * may create a new one.
 *
 * Its consumers need a day: the same occurrence fired by two processes, a
 * request retried by its caller, and a restart replaying the triggers it had
 * decided all repeat within minutes to hours. A consumer that must refuse a
 * repeat for longer keeps its own record.
 *
 * A terminal item need keep only its scope, key, id, state, and the token of
 * the claim that settled it (so a repeated settle is recognised).
 */
export const WORK_QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The largest payload every implementation accepts, measured as the UTF-8
 * bytes of its JSON serialization. A larger body goes to the Blobs provider
 * and the payload carries its reference (ADR-0076).
 */
export const MAX_WORK_PAYLOAD_BYTES = 256 * 1024;

/** What a trigger asks the queue to hold. */
export interface EnqueueRequest {
  /**
   * The tenancy the item belongs to: the kernel passes the workspace id, and
   * never a value taken from tool input. Opaque to the queue. Non-empty. Keys
   * under different scopes never collide.
   */
  scope: string;
  /**
   * What kind of work this is, chosen by the consumer (for example
   * `task.run`). Non-empty. Workers claim by it.
   */
  kind: string;
  /**
   * The work's description: JSON data (objects, arrays, strings, finite
   * numbers, booleans, null), at most `MAX_WORK_PAYLOAD_BYTES` serialized. A
   * claim returns a value deep-equal to it. A value JSON cannot represent is
   * outside the contract.
   */
  payload: unknown;
  /**
   * Names the piece of work within its scope; one (scope, key) is one item,
   * whatever its kind. Non-empty.
   */
  idempotencyKey: string;
  /** The item is not due before this instant (RFC 3339, with offset). Absent: due when enqueued. */
  notBefore?: string;
}

export interface EnqueueResult {
  /**
   * The item's id: non-empty, and unique per item, including a later item
   * under a forgotten key.
   */
  id: string;
  /** True when this call created the item; false when the scope and key already named one. */
  created: boolean;
}

export interface ClaimRequest {
  /** Who is claiming. Non-empty. Not normative: an implementation may keep it for an operator. */
  workerId: string;
  /** How long the claim holds before the item is due again, in milliseconds. A positive number. */
  leaseMs: number;
  /**
   * The kinds this worker can do. Non-empty: a worker names what it knows, so
   * one running older code never claims a kind it cannot handle.
   */
  kinds: string[];
}

/** A worker's hold on one item, from `claim` or `extend`. */
export interface Claim {
  /** The item's id, as `enqueue` returned it. */
  id: string;
  /** The item's kind, as enqueued. */
  kind: string;
  /**
   * The item's payload, deep-equal to what was enqueued. It is the caller's own
   * copy: changing it changes nothing the queue keeps or delivers later.
   */
  payload: unknown;
  /** How many times the item has been claimed, this claim included: 1 on the first. */
  attempt: number;
  /**
   * The fencing token: strictly greater than the token of every earlier claim
   * of this item. Compare tokens only for order and equality; their values
   * carry no other meaning, and need not be consecutive.
   */
  token: number;
  /** When this claim's lease expires (UTC, `Z`, milliseconds; the provider's clock). */
  leaseUntil: string;
}

export interface FailOptions {
  /** Why the attempt failed. Not normative: an implementation may keep it for an operator. */
  error: string;
  /**
   * Make the item pending again, due at this instant (RFC 3339, with offset;
   * one in the past is due at once). Absent: the item fails terminally.
   */
  retryAt?: string;
}

/** Why a claim is lost (see "Item states"). */
export type LeaseLostReason = "superseded" | "settled" | "gone";

/**
 * Refused because the claim is lost. The holder stops working on the item and
 * writes nothing more for it.
 */
export class LeaseLostError extends Error {
  readonly code = "lease_lost";
  constructor(
    readonly itemId: string,
    readonly token: number,
    readonly reason: LeaseLostReason,
  ) {
    super(`The claim on work item ${itemId} (token ${token}) is no longer current: ${reason}.`);
    this.name = "LeaseLostError";
  }
}

export interface WorkQueue {
  /**
   * Hold a piece of work until a worker claims it.
   *
   * Idempotent per (scope, key): while an item with this `scope` and
   * `idempotencyKey` exists, pending, claimed, or terminal within
   * `WORK_QUEUE_RETENTION_MS`, the call changes nothing and returns that
   * item's id with `created: false`. The first enqueue's `kind`, `payload` and
   * `notBefore` stand; a repeat's are ignored, so a key must name the work
   * exactly. Concurrent enqueues of one (scope, key) create one item: exactly
   * one of them answers `created: true`.
   *
   * Rejects an empty `scope`, `kind` or `idempotencyKey`, a `notBefore` that is
   * not RFC 3339 with an offset, and a payload over `MAX_WORK_PAYLOAD_BYTES`,
   * creating nothing.
   */
  enqueue(item: EnqueueRequest): Promise<EnqueueResult>;

  /**
   * Take at most one due item (see "Item states") of one of `kinds`, and hold
   * it for `leaseMs`. Returns null when none is due.
   *
   * Prefers earlier due times: a sequence of claims in one scope takes that
   * scope's items in due-time order. Nothing is promised about order across
   * scopes or between concurrent claims; a fairness rule across scopes is a
   * later, additive decision.
   *
   * The returned claim's `attempt` is one more than the item's last, its
   * `token` is greater than every earlier claim's, and its `leaseUntil` is the
   * provider's now plus `leaseMs`; any earlier claim of the item is superseded
   * from this moment. Never returns one item to two claims whose leases
   * overlap, concurrent claims included.
   *
   * Rejects an empty `workerId`, an empty `kinds`, and a `leaseMs` that is not
   * a positive number, claiming nothing.
   */
  claim(request: ClaimRequest): Promise<Claim | null>;

  /**
   * Hold the claim for `leaseMs` more, counted from the provider's now (not
   * from the old `leaseUntil`). Returns the claim with its new `leaseUntil`;
   * `id`, `attempt` and `token` are unchanged.
   *
   * Throws `LeaseLostError` when the claim is lost, a claim already settled
   * included (`settled`). Rejects a `leaseMs` that is not a positive number,
   * changing nothing.
   */
  extend(claim: Claim, leaseMs: number): Promise<Claim>;

  /**
   * Settle the item as done. It is terminal: never claimed again, and its key
   * stays taken for `WORK_QUEUE_RETENTION_MS`.
   *
   * Repeating it for a claim it already completed succeeds and changes
   * nothing. Throws `LeaseLostError` when the claim is lost: `superseded`,
   * `gone`, or `settled` when the claim was settled by `fail`.
   */
  complete(claim: Claim): Promise<void>;

  /**
   * Settle the attempt as failed. With `retryAt`, the item is pending again and
   * due at `retryAt`, and its next claim counts as the next attempt. Without
   * it, the item fails terminally, as `complete` settles it.
   *
   * Repeating the same settle (the same claim, failed again with the same
   * `retryAt`, or again terminally) succeeds and changes nothing, until the
   * item is claimed again. Throws `LeaseLostError` when the claim is lost:
   * `superseded`, `gone`, or `settled` when the claim was settled another way.
   * Rejects a `retryAt` that is not RFC 3339 with an offset, changing nothing:
   * the claim keeps its lease, attempt and token.
   */
  fail(claim: Claim, options: FailOptions): Promise<void>;

  /**
   * Release what the queue holds (a lock, a connection). Idempotent. Every
   * other method rejects once it has been called. A durable implementation
   * shows every item, as it was, to a queue opened again on the same store;
   * whether an implementation is durable is its own to state.
   */
  close(): Promise<void>;

  /**
   * Whether more than one runtime process may use this queue's store at once.
   * A queue that says false serves one process only, so a deployment of
   * several runtime processes needs one that says true (ADR-0076).
   */
  readonly multiProcess: boolean;
}
