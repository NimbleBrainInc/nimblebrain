/**
 * RunBus — server-authoritative, replayable per-conversation turn log.
 *
 * A chat turn runs to completion on the server regardless of any client
 * connection. The RunBus is the in-memory source of truth for an in-flight
 * turn: it owns the turn's cancellation handle, an ordered event log with
 * monotonic sequence numbers, and the set of live subscribers.
 *
 * Why it exists (issue #254 follow-up — conversation-tab rewrite):
 *   - The client is a *viewer*. It attaches to a run, replays everything
 *     emitted so far (so a page refresh reconstructs the in-progress
 *     assistant message), then tails live events. Disconnect / refresh /
 *     conversation-switch never lose or duplicate work — they just detach
 *     and re-attach.
 *   - The turn's lifecycle is decoupled from the originating HTTP request.
 *     Closing the tab does NOT abort generation; only an explicit
 *     {@link RunBus.cancel} (the Stop button) does.
 *
 * Scope: single-process, in-memory. Multi-replica (`platform.replicas > 1`)
 * needs a Redis-backed log + conversationId-sticky routing — deferred,
 * mirrors the `SessionRegistry` pattern.
 */

import { RunInProgressError } from "./errors.ts";

export type RunStatus = "running" | "done" | "error" | "cancelled";

/** A single buffered event in a run's log. `seq` is 1-based and monotonic. */
export interface BufferedRunEvent {
  seq: number;
  type: string;
  data: unknown;
}

interface RunLog {
  conversationId: string;
  seq: number;
  events: BufferedRunEvent[];
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  abort: AbortController;
  eventListeners: Set<(e: BufferedRunEvent) => void>;
  endListeners: Set<(s: RunStatus) => void>;
  gcTimer?: ReturnType<typeof setTimeout>;
}

/** Detach callback returned by {@link RunBus.attach}. */
export type DetachFn = () => void;

export class RunBus {
  private runs = new Map<string, RunLog>();
  /** How long a terminal run's log is retained for late re-attach. */
  private readonly graceMs: number;

  constructor(graceMs = 30_000) {
    this.graceMs = graceMs;
  }

  /**
   * Begin a turn for a conversation. Throws {@link RunInProgressError} if one
   * is already running. Returns the turn's `AbortSignal` — the engine threads
   * this (NOT the HTTP request's signal), so generation survives client
   * disconnect and is only stopped by {@link cancel}.
   */
  begin(conversationId: string): AbortSignal {
    const existing = this.runs.get(conversationId);
    if (existing && existing.status === "running") {
      throw new RunInProgressError(conversationId);
    }
    // A terminal log lingering in its grace window is replaced by the new turn.
    if (existing?.gcTimer) clearTimeout(existing.gcTimer);

    const log: RunLog = {
      conversationId,
      seq: 0,
      events: [],
      status: "running",
      startedAt: Date.now(),
      abort: new AbortController(),
      eventListeners: new Set(),
      endListeners: new Set(),
    };
    this.runs.set(conversationId, log);
    return log.abort.signal;
  }

  /** Whether a turn is currently generating for this conversation. */
  isActive(conversationId: string): boolean {
    return this.runs.get(conversationId)?.status === "running";
  }

  /** Last sequence number assigned for this conversation's current/last run. */
  currentSeq(conversationId: string): number {
    return this.runs.get(conversationId)?.seq ?? 0;
  }

  /** Status of the conversation's current/last (still-retained) run. */
  getStatus(conversationId: string): RunStatus | undefined {
    return this.runs.get(conversationId)?.status;
  }

  /** Conversation ids with an actively generating turn. */
  activeConversationIds(): string[] {
    const ids: string[] = [];
    for (const [id, log] of this.runs) {
      if (log.status === "running") ids.push(id);
    }
    return ids;
  }

  /**
   * Append an event to the run's log and fan it out to live subscribers.
   * No-op if the run isn't active (defensive — late engine events after a
   * cancel shouldn't resurrect a terminated log).
   */
  publish(conversationId: string, type: string, data: unknown): BufferedRunEvent | null {
    const log = this.runs.get(conversationId);
    if (!log || log.status !== "running") return null;
    log.seq += 1;
    const evt: BufferedRunEvent = { seq: log.seq, type, data };
    log.events.push(evt);
    for (const fn of log.eventListeners) {
      try {
        fn(evt);
      } catch {
        // A failing subscriber must not break the fan-out to others.
      }
    }
    return evt;
  }

  /**
   * Snapshot of buffered events with `seq > afterSeq` (no live subscription).
   * Used to replay an in-progress turn to a freshly connecting SSE subscriber
   * before it starts receiving live fan-out. Empty if no retained run.
   */
  bufferedSince(conversationId: string, afterSeq: number): BufferedRunEvent[] {
    const log = this.runs.get(conversationId);
    if (!log) return [];
    return log.events.filter((e) => e.seq > afterSeq);
  }

  /** Mark a run terminal, notify end-listeners, and schedule log GC. */
  end(conversationId: string, status: Exclude<RunStatus, "running">): void {
    const log = this.runs.get(conversationId);
    if (!log || log.status !== "running") return;
    log.status = status;
    log.endedAt = Date.now();
    for (const fn of log.endListeners) {
      try {
        fn(status);
      } catch {
        // ignore
      }
    }
    this.scheduleGc(log);
  }

  /**
   * Explicitly cancel an active run (the Stop button). Aborts the turn's
   * signal (engine stops cooperatively) and marks it `cancelled`.
   */
  cancel(conversationId: string): boolean {
    const log = this.runs.get(conversationId);
    if (!log || log.status !== "running") return false;
    log.abort.abort();
    this.end(conversationId, "cancelled");
    return true;
  }

  /**
   * Attach a viewer. Synchronously replays every buffered event with
   * `seq > afterSeq`, then streams live events as they're published. If the
   * run is already terminal, replays the tail then fires `onEnd`.
   *
   * Pass `afterSeq = 0` for a fresh attach (full replay), or the highest seq
   * the client already rendered (from a prior connection) to resume without
   * gaps or duplicates.
   *
   * Returns a detach function. No-op attach (returns a noop) when there's no
   * retained run for the conversation — the caller then renders only
   * persisted history.
   */
  attach(
    conversationId: string,
    afterSeq: number,
    onEvent: (e: BufferedRunEvent) => void,
    onEnd?: (s: RunStatus) => void,
  ): DetachFn {
    const log = this.runs.get(conversationId);
    if (!log) return () => {};

    // Snapshot the replay set before registering the live listener. JS is
    // single-threaded and publish() is synchronous, so nothing can interleave
    // between the filter and the add — no gaps, no double-delivery.
    const replay = log.events.filter((e) => e.seq > afterSeq);
    const liveListener = (e: BufferedRunEvent) => onEvent(e);
    log.eventListeners.add(liveListener);

    let endListener: ((s: RunStatus) => void) | undefined;
    if (onEnd) {
      endListener = (s) => onEnd(s);
      log.endListeners.add(endListener);
    }

    for (const e of replay) onEvent(e);
    // Already-terminal run: deliver the terminal status after the replay.
    if (log.status !== "running" && onEnd) onEnd(log.status);

    return () => {
      log.eventListeners.delete(liveListener);
      if (endListener) log.endListeners.delete(endListener);
    };
  }

  /** Drop a retained terminal log immediately (test/GC helper). */
  evict(conversationId: string): void {
    const log = this.runs.get(conversationId);
    if (log?.gcTimer) clearTimeout(log.gcTimer);
    this.runs.delete(conversationId);
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
      this.runs.delete(log.conversationId);
      return;
    }
    log.gcTimer = setTimeout(() => {
      // Only GC if a newer run hasn't replaced this one.
      if (this.runs.get(log.conversationId) === log) {
        this.runs.delete(log.conversationId);
      }
    }, this.graceMs);
    // Don't keep the process alive solely for log GC.
    log.gcTimer.unref?.();
  }
}
