/**
 * RunBus — server-authoritative, replayable per-conversation turn log.
 *
 * A chat turn runs to completion on the server regardless of any client
 * connection. The RunBus is the in-memory source of truth for an in-flight
 * turn: it owns the turn's cancellation handle and an ordered event log with
 * monotonic sequence numbers.
 *
 * Delivery is the runtime's job, not the bus's: {@link RunBus.publish} buffers
 * each event and returns it, and the runtime fans that return value out to live
 * SSE subscribers (`onTurnEvent`). A freshly connecting viewer first replays
 * the buffer via {@link RunBus.bufferedSince} (so a refresh reconstructs the
 * in-progress message), then tails. The bus stays a pure buffer + lifecycle —
 * one delivery path, no parallel subscriber set to keep in sync.
 *
 * Why it exists (issue #254 follow-up — conversation-tab rewrite):
 *   - The client is a *viewer*. Disconnect / refresh / conversation-switch
 *     never lose or duplicate work — they just replay-from-seq and re-tail.
 *   - The turn's lifecycle is decoupled from the originating HTTP request.
 *     Closing the tab does NOT abort generation; only an explicit
 *     {@link RunBus.cancel} (the Stop button) does.
 *
 * Keyed by the conversation's scoped key (`conversationKey`: workspace, owner
 * and id), never the bare id: a conversation id is unique only within its
 * scope, so two scopes' turns on one id are two runs.
 *
 * Scope: single-process, in-memory. Multi-replica (`platform.replicas > 1`)
 * needs a Redis-backed log + conversation-sticky routing — deferred.
 */

import { log as logger } from "../observability/log.ts";
import { RunInProgressError } from "./errors.ts";

export type RunStatus = "running" | "done" | "error" | "cancelled";

/** A single buffered event in a run's log. `seq` is 1-based and monotonic. */
export interface BufferedRunEvent {
  seq: number;
  type: string;
  data: unknown;
}

interface RunLog {
  key: string;
  seq: number;
  events: BufferedRunEvent[];
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  abort: AbortController;
  gcTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Hard cap on buffered events per run. A defense against a runaway or
 * adversarial event producer holding unbounded memory for the grace window.
 *
 * Sized to sit comfortably above legitimate worst cases: a Synapse-research
 * style extended-thinking turn emits on the order of 10^5 events (token
 * deltas + tool progress + status). 500k gives ~5x headroom over the
 * worst legit run we've measured. Hitting it requires either a model
 * stream looping pathologically or an adversarial tool spamming progress
 * events — either way, terminating the run with a clear error is the
 * correct response. Operators see a warn log; the agent's next turn can
 * pick up from persisted history.
 */
const DEFAULT_MAX_EVENTS_PER_RUN = 500_000;

export class RunBus {
  private runs = new Map<string, RunLog>();
  /** How long a terminal run's log is retained for late re-attach. */
  private readonly graceMs: number;
  /** Per-run event cap. See {@link DEFAULT_MAX_EVENTS_PER_RUN}. Configurable
   *  via constructor for tests; production should leave it at the default. */
  private readonly maxEventsPerRun: number;

  constructor(graceMs = 30_000, maxEventsPerRun = DEFAULT_MAX_EVENTS_PER_RUN) {
    this.graceMs = graceMs;
    this.maxEventsPerRun = maxEventsPerRun;
  }

  /**
   * Begin a turn for a conversation. Throws {@link RunInProgressError} if one
   * is already running. Returns the turn's `AbortSignal` — the engine threads
   * this (NOT the HTTP request's signal), so generation survives client
   * disconnect and is only stopped by {@link cancel}.
   */
  begin(key: string): AbortSignal {
    const existing = this.runs.get(key);
    if (existing && existing.status === "running") {
      throw new RunInProgressError(key);
    }
    // A terminal log lingering in its grace window is replaced by the new turn.
    if (existing?.gcTimer) clearTimeout(existing.gcTimer);

    const log: RunLog = {
      key,
      seq: 0,
      events: [],
      status: "running",
      startedAt: Date.now(),
      abort: new AbortController(),
    };
    this.runs.set(key, log);
    return log.abort.signal;
  }

  /** Whether a turn is currently generating for this conversation. */
  isActive(key: string): boolean {
    return this.runs.get(key)?.status === "running";
  }

  /** Last sequence number assigned for this conversation's current/last run. */
  currentSeq(key: string): number {
    return this.runs.get(key)?.seq ?? 0;
  }

  /** Status of the conversation's current/last (still-retained) run. */
  getStatus(key: string): RunStatus | undefined {
    return this.runs.get(key)?.status;
  }

  /**
   * Append an event to the run's log and return it (the caller delivers it to
   * live viewers). No-op — returns null — if the run isn't active (defensive:
   * late engine events after a cancel shouldn't resurrect a terminated log).
   *
   * If appending this event would exceed {@link maxEventsPerRun}, the run is
   * aborted, a synthetic terminal `error` event is appended and returned (so
   * viewers see the cause rather than a silent stop), and the run is marked
   * `error`. Subsequent publishes during the same tick are dropped by the
   * standard `status !== "running"` guard.
   */
  publish(key: string, type: string, data: unknown): BufferedRunEvent | null {
    const log = this.runs.get(key);
    if (log?.status !== "running") return null;

    // Overflow check BEFORE seq increment / push: the terminal error event
    // itself counts toward seq but is intentionally allowed past the cap so
    // viewers always see why generation stopped. No re-entry guard needed —
    // `end()` below flips status off "running", so the next publish returns at
    // the top guard.
    if (log.events.length >= this.maxEventsPerRun) {
      logger.warn(
        `[run-bus] key=${key} hit per-run event cap ` +
          `(${this.maxEventsPerRun}); aborting turn. This indicates a runaway ` +
          `producer (model stream looping or tool spamming progress events).`,
      );
      log.abort.abort();
      log.seq += 1;
      const errEvt: BufferedRunEvent = {
        seq: log.seq,
        type: "error",
        data: {
          error: "buffer_overflow",
          message: `Per-run event cap exceeded (${this.maxEventsPerRun}). Turn aborted.`,
        },
      };
      log.events.push(errEvt);
      this.end(key, "error");
      return errEvt;
    }

    log.seq += 1;
    const evt: BufferedRunEvent = { seq: log.seq, type, data };
    log.events.push(evt);
    return evt;
  }

  /**
   * Snapshot of buffered events with `seq > afterSeq` (no live subscription).
   * Used to replay an in-progress turn to a freshly connecting SSE subscriber
   * before it starts receiving live fan-out. Empty if no retained run.
   */
  bufferedSince(key: string, afterSeq: number): BufferedRunEvent[] {
    const log = this.runs.get(key);
    if (!log) return [];
    return log.events.filter((e) => e.seq > afterSeq);
  }

  /** Mark a run terminal and schedule log GC. The terminal frame itself is a
   *  published event (delivered + replayable like any other); `end` only flips
   *  the lifecycle so `isActive`/`getStatus` reflect it and the buffer is GC'd
   *  after the grace window. */
  end(key: string, status: Exclude<RunStatus, "running">): void {
    const log = this.runs.get(key);
    if (log?.status !== "running") return;
    log.status = status;
    log.endedAt = Date.now();
    this.scheduleGc(log);
  }

  /**
   * Explicitly cancel an active run (the Stop button). Aborts the turn's
   * signal (engine stops cooperatively) and marks it `cancelled`.
   */
  cancel(key: string): boolean {
    const log = this.runs.get(key);
    if (log?.status !== "running") return false;
    log.abort.abort();
    this.end(key, "cancelled");
    return true;
  }

  /**
   * Drop a retained log immediately (release a failed reservation / GC helper).
   *
   * When `expectedSignal` is supplied, the log is dropped only if it's still
   * the run that owns that signal — the per-run `AbortSignal` is its identity.
   * This mirrors {@link scheduleGc}'s `=== log` guard: without it, a late
   * failure-path evict (e.g. a `begin()` reservation whose `store.load()` then
   * rejects after the original run was cancelled and a *new* turn legitimately
   * replaced it at the same id) would delete the newer run's log and orphan a
   * live turn — generation continues with no buffer, no viewers, no terminal
   * frame. Callers releasing their own reservation pass the signal `begin()`
   * returned; the no-arg form stays an unconditional drop for GC/tests.
   */
  evict(key: string, expectedSignal?: AbortSignal): void {
    const log = this.runs.get(key);
    if (!log) return;
    if (expectedSignal && log.abort.signal !== expectedSignal) return;
    if (log.gcTimer) clearTimeout(log.gcTimer);
    this.runs.delete(key);
  }

  /** Cancel all active runs and clear state (shutdown / reset). */
  reset(): void {
    for (const log of this.runs.values()) {
      if (log.gcTimer) clearTimeout(log.gcTimer);
      if (log.status === "running") log.abort.abort();
    }
    this.runs.clear();
  }

  private scheduleGc(log: RunLog): void {
    if (this.graceMs <= 0) {
      this.runs.delete(log.key);
      return;
    }
    log.gcTimer = setTimeout(() => {
      // Only GC if a newer run hasn't replaced this one.
      if (this.runs.get(log.key) === log) {
        this.runs.delete(log.key);
      }
    }, this.graceMs);
    // Don't keep the process alive solely for log GC.
    log.gcTimer.unref?.();
  }
}
