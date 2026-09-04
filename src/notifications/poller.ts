import {
  notificationSourceLabel,
  notificationsPollDeferredTotal,
  notificationsPollReconnectsTotal,
  notificationsPollSeconds,
  notificationsPulledTotal,
  notificationsTruncatedTotal,
} from "../api/metrics.ts";
import { log } from "../observability/log.ts";
import type { McpSource } from "../tools/mcp-source.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { cursorWriteContention, readCursor, writeCursor } from "./cursors.ts";
import { parseNotificationEnvelope } from "./envelope.ts";
import { NOTIFICATION_REPLAY_MAX_AGE_MS, outboxReadUri } from "./outbox-uri.ts";
import {
  backoffIntervalMs,
  clampNextPollMs,
  POLL_FLOOR_MS,
  type ResolvedPollConfig,
} from "./poll-config.ts";
import { type OutboxPollResult, parseOutboxPollBody } from "./poll-result.ts";
import type { NotificationStore } from "./store.ts";

/**
 * The poller — what makes the inbox fill up on its own.
 *
 * One timer in the runtime process reads every declared outbox on an adaptive
 * cadence, writes what it finds to the workspace's inbox, and advances a cursor
 * per `(workspace, connector)`. It delivers nothing and wakes nothing: routing
 * and the event trigger are separate doors, and this loop is finished the
 * moment an envelope is durable.
 *
 * The operational contract is `ConnectionRevalidator`'s, deliberately — an
 * unattended loop inside a tenant's runtime must degrade nothing:
 *   - Bounded fan-out over workspaces, never `Promise.all` over the whole set.
 *   - Jittered interval + random startup offset, so restarted pods do not align.
 *   - Skip-if-still-running, globally and per workspace, so a slow read cannot
 *     stack and a pushed hint cannot collide with the sweep already reading it.
 *   - Per-sweep try/catch, so one bad sweep never kills the timer.
 *   - A per-source circuit breaker, so a connector answering garbage is read at
 *     the ceiling rather than every tick.
 *
 * What it adds beyond that contract is a **budget**. The revalidator talks to a
 * provider's API; this talks to the tenant's own edge, on the same limiter the
 * agent's tool calls use. So the loop is bounded by polls-per-workspace-minute
 * as well as by cadence, and when the budget is spent the remaining sources are
 * deferred to the next tick in round-robin order rather than starved — a
 * workspace with more outboxes than budget reads all of them, slower, instead
 * of reading the alphabetical first three forever.
 *
 * **Multi-replica note**: `replicas: 1` is the supported topology, the same
 * prerequisite the revalidator states. At `replicas > 1` two pods would poll
 * the same outbox and race the same cursor; that needs a per-tenant leader
 * lease, which is deferred with the revalidator's.
 */

/** Consecutive failed polls before a source's breaker opens. */
const BREAKER_THRESHOLD = 3;

/**
 * Most reads one source may chain in a single tick on `hasMore`.
 *
 * The budget already bounds this, but it bounds a *workspace* — one source
 * insisting `hasMore` forever would otherwise spend the whole workspace's
 * minute on itself. A server with more than this much backlog is read again on
 * the next tick, which is what a backlog is for.
 */
const MAX_CHAINED_READS = 5;

/** Workspaces read concurrently. Each workspace's own sources are sequential,
 *  because the budget and the round-robin position are per workspace. */
const WORKSPACE_CONCURRENCY = 4;

/** ±fraction jitter applied to every tick delay and to the startup offset. */
const JITTER_FRACTION = 0.2;

/** How often the periodic cost summary is logged. */
const SUMMARY_INTERVAL_MS = 600_000;

/** One `(workspace, connector)` with a running connection and a declared outbox. */
export interface PollTarget {
  wsId: string;
  /** The connector's MCP source name — the `source` stamped on every item. */
  serverName: string;
  /** The declared outbox URI, before template expansion. */
  resource: string;
  source: McpSource;
}

export interface NotificationPollerDeps {
  /**
   * Every `(workspace, connector)` whose connection is `running` under the
   * workspace principal, with a declared outbox.
   *
   * A function rather than a lifecycle handle: what the poller needs is a list
   * of readable outboxes, and taking the list keeps the two questions the
   * lifecycle answers — is it installed, is it authorized — where they are
   * already decided.
   */
  targets: () => Promise<PollTarget[]>;
  /** The inbox for one workspace. */
  storeFor: (wsId: string) => NotificationStore;
  /** Where the cursors live. */
  workspaceStore: WorkspaceStore;
  config: ResolvedPollConfig;
  /**
   * The clock. Defaults to `Date.now`.
   *
   * Injectable because every decision this loop makes is a comparison against
   * it — is this source due, has the budget window rolled, has the breaker
   * elapsed — and a test that could only advance the clock by waiting would
   * have to sleep a minute to assert a one-minute cadence. Same seam the hooks
   * grace window takes as a defaulted `now` argument.
   */
  now?: () => number;
}

/** Per-source cadence, backoff and breaker state. Keyed `wsId|serverName`. */
interface SourceState {
  /** Epoch ms this source may next be read. */
  dueAt: number;
  /** Consecutive polls that returned no events. Drives the backoff. */
  emptyStreak: number;
  /** Consecutive failed polls. Drives the breaker. */
  failureStreak: number;
  /** Epoch ms the breaker closes. `0` when closed. */
  breakerOpenUntil: number;
  /**
   * The `McpSource` instance the update hint was arranged on, if any, and the
   * listener release that goes with it.
   *
   * Compared by identity rather than held as a boolean: a recovered connector
   * can be a *new* source object, and a hint arranged on the old one reaches
   * nobody. Re-arranging when the object changes is what keeps the subscription
   * attached to the connection that actually exists — and releasing the old
   * listener as part of that is what keeps a connector that flaps from leaving
   * one dead listener per recovery on the source it flapped off.
   */
  hintSource?: McpSource;
  releaseHint?: () => void;
}

/** A fixed-window poll allowance per workspace. */
class PollBudget {
  readonly #perMinute: number;
  readonly #windows = new Map<string, { startedAt: number; used: number }>();

  constructor(perMinute: number) {
    this.#perMinute = perMinute;
  }

  /** Take one poll's allowance, or report that the window is spent. */
  take(wsId: string, now: number): boolean {
    const window = this.#windows.get(wsId);
    if (!window || now - window.startedAt >= 60_000) {
      this.#windows.set(wsId, { startedAt: now, used: 1 });
      return true;
    }
    if (window.used >= this.#perMinute) return false;
    window.used++;
    return true;
  }

  /** Drop windows for workspaces with nothing to poll — keeps the map bounded. */
  prune(live: Set<string>): void {
    for (const wsId of this.#windows.keys()) {
      if (!live.has(wsId)) this.#windows.delete(wsId);
    }
  }
}

/** What one outbox read did. A failed read carries nothing but its verdict. */
type ReadOutcome =
  | { ok: false }
  | { ok: true; events: number; hasMore: boolean; nextPollMs?: number };

export class NotificationPoller {
  readonly #deps: NotificationPollerDeps;
  readonly #config: ResolvedPollConfig;
  readonly #budget: PollBudget;
  readonly #states = new Map<string, SourceState>();
  /** Workspaces with a read in flight — a sweep's or a pushed hint's. */
  readonly #inFlight = new Set<string>();
  /** Where the next tick resumes a workspace whose budget ran out mid-pass. */
  readonly #resumeAt = new Map<string, string>();

  #timer: ReturnType<typeof setTimeout> | null = null;
  #sweeping = false;
  #stopped = false;
  #lastSummaryAt = 0;
  /** Targets the last sweep found, so only a change in the count is logged. */
  #lastTargetCount: number | null = null;
  /** Counters for the periodic summary line, reset when it is logged. */
  #pulledSinceSummary = 0;
  #reconnectsSinceSummary = 0;
  #deferredSinceSummary = 0;
  #pollsSinceSummary = 0;

  readonly #now: () => number;

  constructor(deps: NotificationPollerDeps) {
    this.#deps = deps;
    this.#config = deps.config;
    this.#budget = new PollBudget(deps.config.budgetPerMinute);
    this.#now = deps.now ?? Date.now;
    // Seeded here rather than in `start()` so the first summary lands one
    // interval after construction whether or not the timer is what drives the
    // sweeps.
    this.#lastSummaryAt = this.#now();
  }

  /**
   * Start the loop.
   *
   * The first tick lands at a random offset inside one base interval, so a
   * fleet of pods restarted together does not read every outbox at the same
   * instant — the same reason the revalidator offsets its first sweep.
   */
  start(): void {
    if (this.#timer || this.#stopped) return;
    log.info(
      `[notifications] poller starting (interval=${Math.floor(this.#config.intervalMs / 1000)}s, ` +
        `ceiling=${Math.floor(this.#config.maxIntervalMs / 1000)}s, ` +
        `maxEvents=${this.#config.maxEvents}, budget=${this.#config.budgetPerMinute}/workspace/min)`,
    );
    this.#schedule(Math.random() * this.#config.intervalMs);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    for (const state of this.#states.values()) releaseHint(state);
  }

  /**
   * One pass over every readable outbox. Public for tests; the timer calls it.
   *
   * Never throws. A sweep that dies takes the timer with it, and an inbox that
   * silently stops filling is the failure this loop exists to prevent.
   */
  async sweep(): Promise<void> {
    if (this.#stopped) return;
    if (this.#sweeping) {
      log.debug("notify", "[notifications] previous sweep still running — skipping tick");
      return;
    }
    this.#sweeping = true;
    try {
      const targets = await this.#deps.targets();
      this.#noteTargetCount(targets.length);
      const byWorkspace = groupByWorkspace(targets);
      this.#budget.prune(new Set(byWorkspace.keys()));
      this.#pruneStates(targets);
      await this.#forEachBounded([...byWorkspace.entries()], ([wsId, group]) =>
        this.#sweepWorkspace(wsId, group),
      );
      this.#maybeLogSummary();
    } catch (err) {
      log.warn(
        `[notifications] poller sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.#sweeping = false;
    }
  }

  // -- scheduling --------------------------------------------------------

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(
      () => {
        void this.sweep().finally(() => this.#schedule(this.#jitter(this.#nextDelayMs())));
      },
      Math.max(0, delayMs),
    );
  }

  /**
   * How long until something is worth doing: the earliest due source, clamped
   * into `[floor, ceiling]`.
   *
   * A fixed tick would have to run at the floor to honour a 15-second
   * `nextPollMs`, which is fourteen wasted wake-ups a minute in the ordinary
   * case where nothing is due for a minute. Deriving the delay from the state
   * map costs one pass over it and lets the loop sleep as long as the slowest
   * cadence its sources actually asked for.
   */
  #nextDelayMs(): number {
    const now = this.#now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const state of this.#states.values()) {
      earliest = Math.min(earliest, Math.max(state.dueAt, state.breakerOpenUntil));
    }
    // Nothing known yet (first tick, or no connector declares an outbox): wake
    // at the base interval to discover one.
    if (!Number.isFinite(earliest)) return this.#config.intervalMs;
    return Math.min(Math.max(earliest - now, POLL_FLOOR_MS), this.#config.maxIntervalMs);
  }

  /** ±JITTER_FRACTION around `ms`. */
  #jitter(ms: number): number {
    const delta = ms * JITTER_FRACTION;
    return ms - delta + Math.random() * 2 * delta;
  }

  // -- one workspace -----------------------------------------------------

  /**
   * Read one workspace's due outboxes, in rotation, until the budget runs out.
   *
   * Sequential within the workspace on purpose: the budget and the rotation
   * position are both per workspace, and concurrent reads would have to
   * coordinate on both to stay exact.
   */
  async #sweepWorkspace(wsId: string, targets: PollTarget[]): Promise<void> {
    if (this.#inFlight.has(wsId)) {
      log.debug("notify", `[notifications] ws=${wsId} already being read — skipping this tick`);
      return;
    }
    this.#inFlight.add(wsId);
    try {
      const now = this.#now();
      const due = rotate(
        targets.filter((target) => this.#isDue(target, now)),
        this.#resumeAt.get(wsId),
      );
      for (let i = 0; i < due.length; i++) {
        // Re-checked per source, not only at the top of the sweep: a pass over
        // a workspace with several outboxes outlives a `stop()` that lands
        // mid-pass, and what it would go on to read is a transport the
        // shutdown is closing.
        if (this.#stopped) return;
        const target = due[i] as PollTarget;
        this.#arrangeUpdateHint(target);
        if (!this.#budget.take(wsId, this.#now())) {
          // Defer the rest and remember where to resume, so the next tick
          // starts with the sources this one could not reach.
          this.#defer(due.length - i);
          this.#resumeAt.set(wsId, target.serverName);
          return;
        }
        await this.#pollSource(target);
      }
      // A complete pass leaves no debt; the next one starts in name order.
      this.#resumeAt.delete(wsId);
    } finally {
      this.#inFlight.delete(wsId);
    }
  }

  /**
   * Read one outbox now, out of band, because the server pushed
   * `notifications/resources/updated` for it.
   *
   * The hint is a latency shortcut and never the delivery: it takes the same
   * budget and the same per-workspace exclusion a scheduled read does, so a
   * server that pushed one per second would spend its workspace's minute and
   * then be read on the ordinary cadence like everyone else.
   */
  async pollOnHint(target: PollTarget): Promise<void> {
    if (this.#stopped) return;
    if (this.#inFlight.has(target.wsId)) return;
    if (!this.#budget.take(target.wsId, this.#now())) {
      this.#defer(1);
      return;
    }
    this.#inFlight.add(target.wsId);
    try {
      await this.#pollSource(target, { hinted: true });
    } catch (err) {
      log.warn(
        `[notifications] hinted poll failed: ${err instanceof Error ? err.message : String(err)}`,
        { source: target.serverName, wsId: target.wsId },
      );
    } finally {
      this.#inFlight.delete(target.wsId);
    }
  }

  // -- one source --------------------------------------------------------

  /**
   * Read one outbox, chaining while the server says there is more.
   *
   * `hinted` marks a read the runtime made because the server asked it to
   * rather than because the cadence came round — see {@link #recordSuccess}.
   */
  async #pollSource(target: PollTarget, opts: { hinted?: boolean } = {}): Promise<void> {
    const state = this.#stateFor(target);
    for (let read = 0; read < MAX_CHAINED_READS; read++) {
      if (this.#stopped) return;
      const outcome = await this.#readOnce(target);
      if (!outcome.ok) {
        this.#recordFailure(target, state);
        return;
      }
      this.#recordSuccess(state, outcome, opts.hinted === true);
      if (!outcome.hasMore) return;
      // `hasMore` means the batch was cut at `maxEvents`, so read again at
      // once — but out of the same allowance, because it is the same cost.
      if (!this.#budget.take(target.wsId, this.#now())) {
        this.#defer(1);
        return;
      }
    }
    log.debug(
      "notify",
      `[notifications] ${target.serverName} still reports hasMore after ${MAX_CHAINED_READS} ` +
        "reads — resuming on the next tick",
    );
  }

  /**
   * One `resources/read` of an outbox, and everything that follows from it.
   *
   * The order is the contract: read, parse, write every envelope, and only then
   * advance the cursor. A write that throws leaves the cursor where it was, so
   * the events are read again rather than skipped — at-least-once is the
   * transport's promise and the store's dedupe is what makes a re-read free.
   */
  async #readOnce(target: PollTarget): Promise<ReadOutcome> {
    const cursor = await this.#cursorFor(target);
    const uri = outboxReadUri(target.resource, {
      ...(cursor !== undefined ? { cursor } : {}),
      maxEvents: this.#config.maxEvents,
      maxAgeMs: NOTIFICATION_REPLAY_MAX_AGE_MS,
    });

    const result = await this.#fetchPollResult(target, uri);
    if (!result) return { ok: false };

    const written = this.#writeEvents(target, result.events);
    if (!written.ok) return { ok: false };

    await this.#advanceCursor(target, cursor, result.cursor ?? written.lastEventCursor);

    return {
      ok: true,
      events: result.events.length,
      hasMore: result.hasMore,
      ...(result.nextPollMs !== undefined ? { nextPollMs: result.nextPollMs } : {}),
    };
  }

  /**
   * The transport half: read the URI, time it, and re-derive the answer.
   *
   * `null` means a failed poll, and the three ways to get one are deliberately
   * the same outcome — a read that threw, a read that returned nothing, and a
   * body that is not a poll answer all leave the runtime with no position it
   * can trust, so all three re-read rather than advance.
   */
  async #fetchPollResult(target: PollTarget, uri: string): Promise<OutboxPollResult | null> {
    const label = notificationSourceLabel(target.serverName);
    // A torn-down transport before the read means `readResource` had to revive
    // it, which is the three-request poll the budget is sized for.
    const wasDisconnected = target.source.getClient() === null;
    const startedAt = this.#now();
    let body: string | undefined;
    try {
      const data = await target.source.readResource(uri, { reconnect: true, logFailures: true });
      body = data?.text;
    } catch (err) {
      log.warn(
        `[notifications] outbox read threw: ${err instanceof Error ? err.message : String(err)}`,
        { source: target.serverName, wsId: target.wsId },
      );
      return null;
    } finally {
      notificationsPollSeconds.observe({ source: label }, (this.#now() - startedAt) / 1000);
      this.#pollsSinceSummary++;
      if (wasDisconnected && target.source.getClient() !== null) {
        notificationsPollReconnectsTotal.inc({ source: label });
        this.#reconnectsSinceSummary++;
      }
    }

    const result = parseOutboxPollBody(body);
    if (!result) {
      log.warn("[notifications] outbox answered a body that is not a poll result", {
        source: target.serverName,
        wsId: target.wsId,
      });
      return null;
    }

    if (result.truncated) {
      notificationsTruncatedTotal.inc({ source: label });
      log.warn(
        "[notifications] outbox reported a gap (truncated): events were dropped before this " +
          "runtime read them, and they cannot be recovered",
        { source: target.serverName, wsId: target.wsId },
      );
    }
    return result;
  }

  /**
   * Move the stored position forward, once the events it covers are durable.
   *
   * A failure here is a warn, not a failed poll: the events ARE in the inbox,
   * so re-reading them costs one round trip and the store's dedupe absorbs the
   * rest. Returning a failure instead would re-open the same write on the next
   * tick and put a circuit breaker in front of a fault the breaker cannot help
   * with.
   */
  async #advanceCursor(
    target: PollTarget,
    previous: string | undefined,
    next: string | undefined,
  ): Promise<void> {
    if (next === undefined || next === previous) return;
    try {
      await writeCursor(this.#deps.workspaceStore, target.wsId, target.serverName, next);
    } catch (err) {
      log.warn(
        `[notifications] cursor write failed: ${err instanceof Error ? err.message : String(err)}`,
        { source: target.serverName, wsId: target.wsId },
      );
    }
  }

  /**
   * Write every envelope in one answer to the inbox.
   *
   * A malformed envelope is dropped and the rest are kept — the parser already
   * logged which field failed. A *store* failure is different: it means the
   * inbox did not take an event, so the whole answer is unwritten as far as the
   * cursor is concerned and `ok: false` holds the position.
   */
  #writeEvents(
    target: PollTarget,
    events: readonly unknown[],
  ): { ok: true; lastEventCursor?: string } | { ok: false } {
    const store = this.#deps.storeFor(target.wsId);
    const label = notificationSourceLabel(target.serverName);
    let lastEventCursor: string | undefined;
    let pulled = 0;
    for (const raw of events) {
      const envelope = parseNotificationEnvelope(raw);
      if (!envelope) continue;
      try {
        store.append(target.serverName, envelope);
      } catch (err) {
        log.warn(
          `[notifications] inbox write failed: ${err instanceof Error ? err.message : String(err)}`,
          { source: target.serverName, wsId: target.wsId },
        );
        if (pulled > 0) notificationsPulledTotal.inc({ source: label }, pulled);
        this.#pulledSinceSummary += pulled;
        return { ok: false };
      }
      pulled++;
      // A per-event cursor is the fallback position when the answer carries no
      // result-level one — the last event written is the furthest point the
      // inbox can vouch for.
      if (envelope.cursor !== undefined) lastEventCursor = envelope.cursor;
    }
    if (pulled > 0) notificationsPulledTotal.inc({ source: label }, pulled);
    this.#pulledSinceSummary += pulled;
    return { ok: true, ...(lastEventCursor !== undefined ? { lastEventCursor } : {}) };
  }

  /** The stored cursor, or `undefined` to bootstrap. */
  async #cursorFor(target: PollTarget): Promise<string | undefined> {
    const ws = await this.#deps.workspaceStore.get(target.wsId);
    return ws ? readCursor(ws, target.serverName) : undefined;
  }

  // -- cadence and the breaker -------------------------------------------

  #stateFor(target: PollTarget): SourceState {
    const key = stateKey(target);
    const existing = this.#states.get(key);
    if (existing) return existing;
    const state: SourceState = {
      dueAt: 0,
      emptyStreak: 0,
      failureStreak: 0,
      breakerOpenUntil: 0,
    };
    this.#states.set(key, state);
    return state;
  }

  /** Whether a source may be read now: past its cadence and past its breaker. */
  #isDue(target: PollTarget, now: number): boolean {
    const state = this.#states.get(stateKey(target));
    if (!state) return true;
    return now >= state.dueAt && now >= state.breakerOpenUntil;
  }

  /**
   * Fold one successful read into the cadence.
   *
   * A non-empty answer snaps back to the base interval; consecutive empty ones
   * back off toward the ceiling. A `nextPollMs` overrides both, clamped into
   * the range the runtime will keep: the server knows whether it is watching
   * something, and the runtime knows what it is willing to pay, so the
   * recommendation wins inside the bound and the bound wins outside it.
   *
   * A **hinted** read snaps back whatever it finds, and never counts as an
   * empty poll. The backoff exists to stop the runtime asking a quiet outbox
   * on its own initiative; a read the server asked for is evidence the outbox
   * is active, and charging it to the backoff would punish a server for being
   * helpful — the one that pushes would end up read less often than the one
   * that does not.
   */
  #recordSuccess(
    state: SourceState,
    outcome: { events: number; nextPollMs?: number },
    hinted: boolean,
  ): void {
    state.failureStreak = 0;
    state.breakerOpenUntil = 0;
    state.emptyStreak = hinted || outcome.events > 0 ? 0 : state.emptyStreak + 1;
    const interval =
      outcome.nextPollMs !== undefined
        ? clampNextPollMs(outcome.nextPollMs, this.#config)
        : backoffIntervalMs(state.emptyStreak, this.#config);
    state.dueAt = this.#now() + interval;
  }

  /**
   * Fold one failed read into the cadence, opening the breaker at the
   * threshold.
   *
   * An open breaker half-opens on the ceiling interval: the source becomes due
   * again after it, gets exactly one read, and either closes the breaker or
   * re-opens it for another ceiling. There is no separate half-open state to
   * hold, because "due once" is what half-open means here.
   */
  #recordFailure(target: PollTarget, state: SourceState): void {
    state.failureStreak++;
    const now = this.#now();
    if (state.failureStreak === BREAKER_THRESHOLD) {
      log.warn(
        `[notifications] outbox failed ${BREAKER_THRESHOLD} consecutive polls — backing off to ` +
          `one read per ${Math.floor(this.#config.maxIntervalMs / 1000)}s until it answers`,
        { source: target.serverName, wsId: target.wsId },
      );
    }
    if (state.failureStreak >= BREAKER_THRESHOLD) {
      state.breakerOpenUntil = now + this.#config.maxIntervalMs;
    }
    state.dueAt = now + backoffIntervalMs(state.failureStreak, this.#config);
  }

  /** Drop state for sources that are no longer readable — keeps the map bounded. */
  #pruneStates(targets: readonly PollTarget[]): void {
    const live = new Set(targets.map(stateKey));
    for (const [key, state] of this.#states) {
      if (live.has(key)) continue;
      releaseHint(state);
      this.#states.delete(key);
    }
    for (const wsId of this.#resumeAt.keys()) {
      if (!targets.some((target) => target.wsId === wsId)) this.#resumeAt.delete(wsId);
    }
  }

  // -- the update hint ---------------------------------------------------

  /**
   * Ask the server to push `resources/updated` for this outbox, if it serves
   * subscriptions, and read it at once when one arrives.
   *
   * Arranged lazily on the first sweep that sees the source running, and
   * re-arranged whenever the connection is replaced by a new `McpSource`. No
   * fleet server advertises `resources.subscribe` today, so this path is
   * exercised by the test fixture rather than by production traffic — which is
   * exactly why it is arranged here, on the same predicate as the poll, rather
   * than on a separate install-time seam that nothing would keep in step.
   */
  #arrangeUpdateHint(target: PollTarget): void {
    const state = this.#stateFor(target);
    if (state.hintSource === target.source) return;
    releaseHint(state);
    state.hintSource = target.source;
    state.releaseHint = target.source.subscribeResourceUpdated((uri) => {
      if (uri !== target.resource) return;
      void this.pollOnHint(target);
    });
    void target.source.subscribeResourceUpdates(target.resource);
  }

  // -- accounting --------------------------------------------------------

  #defer(count: number): void {
    notificationsPollDeferredTotal.inc(count);
    this.#deferredSinceSummary += count;
  }

  /**
   * How many outboxes this sweep may read, said once and again on every change.
   *
   * The summary line's `sources` counts what has actually been read and lands
   * once every ten minutes, so until two of those windows pass an operator
   * cannot tell a connector that declares no outbox from one that declares an
   * outbox the poller cannot see. This answers that on the first sweep after a
   * boot: `targets=0` alongside a connector known to declare an outbox means
   * the declaration or the source is not reaching the collector, which is a
   * different fault from a poller that is reading and finding nothing.
   *
   * Logged on transition rather than per sweep because the count is steady for
   * the life of a pod in the ordinary case, and a line every tick would be
   * noise nobody reads.
   */
  #noteTargetCount(count: number): void {
    if (count === this.#lastTargetCount) return;
    this.#lastTargetCount = count;
    log.info(`[notifications] targets=${count}`);
  }

  /**
   * Periodic cost line: what the loop spent, and whether the cursor writes had
   * to wait on another writer of the workspace record.
   *
   * The contention figure is the one number the metrics cannot carry — it is a
   * property of an in-process lock, not of a request — and it is what says
   * whether the cursor and the hooks reconcile are fighting over the same
   * record.
   */
  #maybeLogSummary(): void {
    const now = this.#now();
    if (now - this.#lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    this.#lastSummaryAt = now;
    const contention = cursorWriteContention();
    log.info(
      `[notifications] polls=${this.#pollsSinceSummary} pulled=${this.#pulledSinceSummary} ` +
        `reconnects=${this.#reconnectsSinceSummary} deferred=${this.#deferredSinceSummary} ` +
        `sources=${this.#states.size} cursorWrites=${contention.attempted} ` +
        `cursorWritesContended=${contention.contended}`,
    );
    this.#pollsSinceSummary = 0;
    this.#pulledSinceSummary = 0;
    this.#reconnectsSinceSummary = 0;
    this.#deferredSinceSummary = 0;
  }

  /** Bounded worker pool over workspaces. */
  async #forEachBounded<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) return;
    const limit = Math.min(WORKSPACE_CONCURRENCY, items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: limit }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          await worker(items[index] as T);
        }
      }),
    );
  }
}

/**
 * Release a source's update-hint listener, if it holds one.
 *
 * Tolerant of a listener set that is already gone — a source torn down before
 * the poller stops is the ordinary shutdown order, not an error.
 */
function releaseHint(state: SourceState): void {
  const release = state.releaseHint;
  if (!release) return;
  state.releaseHint = undefined;
  state.hintSource = undefined;
  try {
    release();
  } catch {
    // Already released with the source it was attached to.
  }
}

function stateKey(target: Pick<PollTarget, "wsId" | "serverName">): string {
  return `${target.wsId}|${target.serverName}`;
}

/** Group targets by workspace, each group in stable name order. */
function groupByWorkspace(targets: readonly PollTarget[]): Map<string, PollTarget[]> {
  const byWorkspace = new Map<string, PollTarget[]>();
  for (const target of targets) {
    const group = byWorkspace.get(target.wsId);
    if (group) group.push(target);
    else byWorkspace.set(target.wsId, [target]);
  }
  for (const group of byWorkspace.values()) {
    group.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }
  return byWorkspace;
}

/**
 * Rotate a name-ordered list so it begins at `resumeAt`.
 *
 * This is the round-robin: a workspace whose budget ran out mid-pass records
 * the source it could not reach, and the next tick starts there. Without it the
 * name-ordered list would read its first N sources every tick and never reach
 * the rest.
 */
function rotate(targets: PollTarget[], resumeAt: string | undefined): PollTarget[] {
  if (resumeAt === undefined || targets.length === 0) return targets;
  const index = targets.findIndex((target) => target.serverName >= resumeAt);
  // Every remaining name sorts before the resume point (the deferred source was
  // uninstalled, or is not due) — start from the top rather than skip the pass.
  if (index <= 0) return targets;
  return [...targets.slice(index), ...targets.slice(0, index)];
}
