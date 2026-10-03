/**
 * Run admission: how many unattended runs execute at once, the queue beyond
 * that, and a fair share of freed slots between workspaces.
 *
 * Asserted at the run-start door (`Runtime.executeTask`), so every source of
 * unattended runs inherits it, including sources not yet written (ADR-0045).
 * The door knows nothing about what a run is for: a request names the
 * workspace the run is walled to and, optionally, an opaque key the caller
 * chose. Admission refuses a second request for a key that already holds a
 * slot or waits for one, and never interprets the key otherwise.
 *
 * Attended runs (chat) are not admitted: a person in the loop is not capacity
 * the runtime schedules.
 *
 * The pool and the queue are in memory, per process. A slot is held by an
 * {@link AdmissionLease} from the moment a run is admitted until the lease is
 * released; `release` is idempotent, so the door and the caller that handed
 * it a lease can both release it on every exit path.
 */

/** What a run asks admission for. */
export interface AdmissionRequest {
  /** The workspace the run is walled to. Fair share is computed per workspace. */
  workspaceId: string;
  /**
   * An opaque key the caller chose. A request whose key already holds a slot
   * or waits in the queue is refused (`running` / `queued`). Absent, the run is
   * never a duplicate.
   */
  key?: string;
}

/** A held slot. */
export interface AdmissionLease {
  readonly workspaceId: string;
  readonly key?: string;
  /** Free the slot and admit the next waiting run. Idempotent. */
  release(): void;
}

/**
 * Why a request was not admitted and not queued.
 *
 * - `running`: a run with the same key holds a slot.
 * - `queued`: a run with the same key waits in the queue.
 * - `busy`: no slot is free now, and the request asked not to wait.
 * - `queue_full`: no slot is free and the queue is at its limit.
 * - `stopped`: admission has stopped (the runtime is shutting down).
 */
export type AdmissionRefusal = "running" | "queued" | "busy" | "queue_full" | "stopped";

/**
 * Why a queued run left the queue without a slot.
 *
 * - `cancelled`: its caller took it out ({@link RunAdmission.cancel}).
 * - `aborted`: the signal it waited under fired ({@link RunAdmission.acquire}).
 * - `stopped`: admission stopped while it waited.
 * - any other string: the reason a caller passed to {@link RunAdmission.withdraw}.
 */
export type AdmissionWithdrawal = "cancelled" | "aborted" | "stopped" | (string & {});

/**
 * How a queued request learns how it left the queue. Both callbacks run
 * synchronously, inside the call that freed the slot or withdrew the entry,
 * so a caller can record the outcome before that call returns.
 */
export interface AdmissionWaiter {
  /** The run took a slot. The waiter now owns `lease` and must release it. */
  admitted(lease: AdmissionLease): void;
  /** The run left the queue without a slot. */
  withdrawn(reason: AdmissionWithdrawal): void;
}

/**
 * What a request became, known at once.
 *
 * `position` is the run's place in arrival order (1 is the oldest waiting).
 * The run that takes a freed slot is chosen by fair share, so a run from a
 * workspace holding fewer slots can start ahead of an older one.
 */
export type AdmissionTicket =
  | { state: "admitted"; lease: AdmissionLease }
  | { state: "queued"; position: number }
  | { state: "refused"; reason: AdmissionRefusal };

/** The limits a pool runs under. */
export interface AdmissionLimits {
  /** Unattended runs in flight at once, across every workspace in the process. */
  maxConcurrentRuns: number;
  /** Runs held waiting for a slot. 0 refuses at the limit. */
  maxQueuedRuns: number;
}

/** A waiting run, as {@link RunAdmission.queued} reports it. */
export type QueuedAdmission = Readonly<AdmissionRequest>;

export interface RunAdmission {
  readonly limits: Readonly<AdmissionLimits>;
  /**
   * Take a slot now, or wait for one. With a `waiter`, a request that finds no
   * free slot joins the queue; without one it is refused `busy`, which is how a
   * caller with its own durable place in line (a scheduled run's persisted next
   * run) asks whether a slot is free now without queueing.
   */
  request(request: AdmissionRequest, waiter?: AdmissionWaiter): AdmissionTicket;
  /**
   * The awaited form: resolves with a lease once the run holds a slot, waiting
   * in the queue if it must. Rejects with {@link RunAdmissionRefusedError} when
   * refused or withdrawn, and with an `AbortError` when `signal` fires first.
   */
  acquire(request: AdmissionRequest, signal?: AbortSignal): Promise<AdmissionLease>;
  /** Take the queued run with `key` out of the queue. False when none waits. */
  cancel(key: string, reason?: AdmissionWithdrawal): boolean;
  /** Take every queued run `match` selects out of the queue; returns how many. */
  withdraw(match: (entry: QueuedAdmission) => boolean, reason: AdmissionWithdrawal): number;
  /** Whether a run with `key` holds a slot. */
  isRunning(key: string): boolean;
  /** Whether a run with `key` waits in the queue. */
  isQueued(key: string): boolean;
  /** Whether a request made now without a waiter would be admitted (ignoring keys). */
  hasFreeSlot(): boolean;
  /** Slots held now. */
  inFlight(): number;
  /** Waiting runs, in arrival order. */
  queued(): QueuedAdmission[];
  /** Whether `lease` is a live lease of this pool. */
  owns(lease: AdmissionLease): boolean;
  /** Refuse every later request and withdraw every queued run as `stopped`. */
  stop(): void;
}

/** Thrown by {@link RunAdmission.acquire} when a run is refused or leaves the queue unadmitted. */
export class RunAdmissionRefusedError extends Error {
  readonly code = "run_admission_refused";
  constructor(public readonly reason: AdmissionRefusal | AdmissionWithdrawal) {
    super(`Run not admitted: ${reason}`);
    this.name = "RunAdmissionRefusedError";
  }
}

interface Entry {
  request: QueuedAdmission;
  waiter: AdmissionWaiter;
}

/** Defaults match `resolveAutomationsConfig`, which is where the runtime's values come from. */
const DEFAULT_LIMITS: AdmissionLimits = { maxConcurrentRuns: 2, maxQueuedRuns: 50 };

/**
 * Create a pool.
 *
 * Fair share: when a slot frees and runs wait, it goes to the waiting run whose
 * workspace holds the fewest slots right now; among equals, the oldest waiting
 * run. A workspace alone in the queue takes every slot that frees, so fair
 * share never leaves a slot idle.
 */
export function createRunAdmission(limits: Partial<AdmissionLimits> = {}): RunAdmission {
  const resolved: AdmissionLimits = { ...DEFAULT_LIMITS, ...limits };
  const leases = new Set<AdmissionLease>();
  const runningKeys = new Set<string>();
  const heldByWorkspace = new Map<string, number>();
  const queue: Entry[] = [];
  let stopped = false;
  let draining = false;

  const held = (wsId: string) => heldByWorkspace.get(wsId) ?? 0;

  function grant(request: AdmissionRequest): AdmissionLease {
    let released = false;
    const lease: AdmissionLease = {
      workspaceId: request.workspaceId,
      ...(request.key !== undefined ? { key: request.key } : {}),
      release() {
        if (released) return;
        released = true;
        leases.delete(lease);
        if (request.key !== undefined) runningKeys.delete(request.key);
        const n = held(request.workspaceId) - 1;
        if (n > 0) heldByWorkspace.set(request.workspaceId, n);
        else heldByWorkspace.delete(request.workspaceId);
        drain();
      },
    };
    leases.add(lease);
    if (request.key !== undefined) runningKeys.add(request.key);
    heldByWorkspace.set(request.workspaceId, held(request.workspaceId) + 1);
    return lease;
  }

  /** Index of the waiting run fair share admits next: fewest slots held by its workspace, then oldest. */
  function nextIndex(): number {
    let best = 0;
    let bestHeld = held(queue[0]!.request.workspaceId);
    for (let i = 1; i < queue.length && bestHeld > 0; i++) {
      const h = held(queue[i]!.request.workspaceId);
      if (h < bestHeld) {
        best = i;
        bestHeld = h;
      }
    }
    return best;
  }

  /**
   * Admit waiting runs while slots are free. Re-entrant calls (a waiter that
   * releases its lease inside `admitted`) return at once; the outer loop picks
   * the freed slot up.
   */
  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queue.length > 0 && leases.size < resolved.maxConcurrentRuns) {
        const [entry] = queue.splice(nextIndex(), 1);
        if (!entry) break;
        const lease = grant(entry.request);
        try {
          entry.waiter.admitted(lease);
        } catch {
          // A waiter that throws cannot be trusted to release what it was
          // handed; the slot must not leak with it.
          lease.release();
        }
      }
    } finally {
      draining = false;
    }
  }

  function refusalFor(request: AdmissionRequest): AdmissionRefusal | null {
    if (stopped) return "stopped";
    if (request.key !== undefined) {
      if (runningKeys.has(request.key)) return "running";
      if (queue.some((e) => e.request.key === request.key)) return "queued";
    }
    return null;
  }

  function hasFreeSlot(): boolean {
    return !stopped && leases.size < resolved.maxConcurrentRuns && queue.length === 0;
  }

  function withdraw(match: (entry: QueuedAdmission) => boolean, reason: AdmissionWithdrawal) {
    const out: Entry[] = [];
    for (let i = 0; i < queue.length; ) {
      if (match(queue[i]!.request)) out.push(...queue.splice(i, 1));
      else i++;
    }
    // Callbacks run after the queue is consistent, so one that makes a new
    // request sees the queue without the entries being withdrawn.
    for (const entry of out) entry.waiter.withdrawn(reason);
    return out.length;
  }

  const admission: RunAdmission = {
    limits: resolved,

    request(request, waiter) {
      const refused = refusalFor(request);
      if (refused) return { state: "refused", reason: refused };
      if (hasFreeSlot()) return { state: "admitted", lease: grant(request) };
      if (!waiter) return { state: "refused", reason: "busy" };
      if (queue.length >= resolved.maxQueuedRuns) return { state: "refused", reason: "queue_full" };
      queue.push({ request: { ...request }, waiter });
      return { state: "queued", position: queue.length };
    },

    acquire(request, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<AdmissionLease>((resolve, reject) => {
        let entryKey: object | null = null;
        const onAbort = () => {
          if (entryKey) withdraw((e) => e === entryKey, "aborted");
        };
        const ticket = admission.request(request, {
          admitted: (lease) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(lease);
          },
          withdrawn: (reason) => {
            signal?.removeEventListener("abort", onAbort);
            reject(reason === "aborted" ? abortError() : new RunAdmissionRefusedError(reason));
          },
        });
        if (ticket.state === "admitted") resolve(ticket.lease);
        else if (ticket.state === "refused") reject(new RunAdmissionRefusedError(ticket.reason));
        else {
          // The queued entry's request object is its identity for an abort.
          entryKey = queue[queue.length - 1]!.request;
          signal?.addEventListener("abort", onAbort, { once: true });
        }
      });
    },

    cancel(key, reason = "cancelled") {
      return withdraw((e) => e.key === key, reason) > 0;
    },

    withdraw,

    isRunning: (key) => runningKeys.has(key),
    isQueued: (key) => queue.some((e) => e.request.key === key),
    hasFreeSlot,
    inFlight: () => leases.size,
    queued: () => queue.map((e) => e.request),
    owns: (lease) => leases.has(lease),

    stop() {
      stopped = true;
      withdraw(() => true, "stopped");
    },
  };
  return admission;
}

function abortError(): DOMException {
  return new DOMException("The run was aborted while it waited for a run slot", "AbortError");
}
