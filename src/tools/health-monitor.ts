import type { EventSink } from "../engine/types.ts";
import type { McpSource } from "./mcp-source.ts";

export type ProcessLiveness = "healthy" | "restarting" | "cooldown" | "dead";

export interface BundleHealth {
  name: string;
  state: ProcessLiveness;
  uptime: number | null;
  restartCount: number;
}

interface BundleRecord {
  source: McpSource;
  state: ProcessLiveness;
  restartCount: number;
  /**
   * Epoch ms until which a crashed source is in slow-re-probe cooldown (its
   * quick-retry budget spent). Null when not cooling. A check skips a cooling
   * source until the window elapses, then resumes the restart burst.
   */
  cooldownUntil: number | null;
}

/**
 * Quick-retry budget for a crashed source. After this many CONSECUTIVE fast
 * restart attempts fail, the source backs off to a slow re-probe
 * (`DEFAULT_COOLDOWN_MS`) — it is NOT abandoned. A transient upstream outage
 * (rate-limit, brief 5xx window) can outlast the burst and still recover, so
 * exhausting the budget is never terminal. The only terminal state is a
 * deliberate teardown (`isStopped()`).
 */
const MAX_RESTARTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;
/**
 * How long a crashed source waits, after spending its quick-retry budget,
 * before the next burst of restart attempts. Bounds the re-probe rate against a
 * persistently-down upstream while still self-healing within one cooldown of
 * the upstream recovering.
 */
const DEFAULT_COOLDOWN_MS = 300_000;

export interface HealthMonitorOptions {
  checkIntervalMs?: number;
  baseDelayMs?: number;
  cooldownMs?: number;
}

/**
 * Monitors MCP subprocess/transport health and keeps down sources alive:
 * exponential-backoff restart bursts, then a slow re-probe cooldown so a
 * transient upstream outage self-heals instead of bricking the connector. Only
 * a deliberate teardown (`isStopped()`) is terminal.
 */
export class HealthMonitor {
  private records: BundleRecord[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkIntervalMs: number;
  private baseDelayMs: number;
  private cooldownMs: number;

  constructor(
    sources: McpSource[],
    private eventSink: EventSink,
    opts: HealthMonitorOptions = {},
  ) {
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.records = sources.map((source) => ({
      source,
      state: "healthy" as ProcessLiveness,
      restartCount: 0,
      cooldownUntil: null,
    }));
  }

  /** Start the periodic health check loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** Stop the periodic health check loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single health check across all bundles. */
  async check(): Promise<void> {
    const tasks = this.records.map((record) => this.checkOne(record));
    await Promise.all(tasks);
  }

  /** Get per-bundle health info. */
  getStatus(): BundleHealth[] {
    return this.records.map((r) => ({
      name: r.source.name,
      state: r.state,
      uptime: r.source.uptime(),
      restartCount: r.restartCount,
    }));
  }

  private async checkOne(record: BundleRecord): Promise<void> {
    // `dead` is terminal and reachable ONLY via deliberate teardown
    // (`isStopped()` below). A crashed source is never left here — it backs off
    // to the `cooldown` slow re-probe — so this early-out never strands a
    // recoverable source.
    if (record.state === "dead") return;

    // Alive sources need no restart. Clear any cooldown, mark healthy, and (after
    // sustained uptime) reset the backoff counter for the next crash episode —
    // covers a source that self-healed out of band (inline recovery) as well as
    // one the monitor just restarted.
    if (record.source.isAlive()) {
      record.state = "healthy";
      record.cooldownUntil = null;
      this.resetBackoffIfRecovered(record);
      return;
    }

    // A source that was deliberately stopped via `stop()` (a teardown /
    // disconnect — e.g. a user-initiated `startAuth` tears the boot source out
    // of the registry and builds a fresh provider+source) is terminal for the
    // monitor. This `records` set is a one-time boot snapshot and is never
    // re-seeded, so the stopped instance lingers here as an orphan. Reconnecting
    // it would run its STALE provider's refresh, whose failure makes the SDK
    // delete the SHARED on-disk credentials (tokens/client/identity in the same
    // wsId/serverName dir) the fresh flow depends on, and flip the connection to
    // `reauth_required` over a live `pending_auth`. Mark it dead and leave it
    // alone. A self-dropped transport (idle close, network blip) leaves
    // `isStopped()` false and still reconnects below.
    if (record.source.isStopped()) {
      record.state = "dead";
      return;
    }

    // Slow-re-probe cooldown: the quick-retry budget was spent on an earlier
    // sweep and the window hasn't elapsed — skip so a persistently-throttling
    // upstream isn't hammered. Once it passes, fall through and resume the burst.
    if (record.cooldownUntil !== null && Date.now() < record.cooldownUntil) return;
    record.cooldownUntil = null;

    const remote = isRemoteSource(record.source);

    // Source is down — emit crashed event
    this.emitBundleEvent(record, "bundle.crashed", remote);

    // Quick-retry budget spent. NOT terminal: a transient upstream outage
    // (rate-limit, brief 5xx window) can outlast the burst and still recover.
    // Back off to a slow re-probe — reset the counter and gate the next burst
    // behind the cooldown window — so we keep trying at a bounded rate until the
    // source recovers or is deliberately stopped. (`bundle.dead` is retired: a
    // crash never ends here, and deliberate teardown is handled above.)
    if (record.restartCount >= MAX_RESTARTS) {
      record.state = "cooldown";
      record.cooldownUntil = Date.now() + this.cooldownMs;
      record.restartCount = 0;
      this.emitBundleEvent(record, "bundle.cooldown", remote, { retryInMs: this.cooldownMs });
      return;
    }

    await this.attemptRestart(record, remote);
  }

  /**
   * Clear the consecutive-failure counter once a recovered source has
   * sustained a full check interval of uptime.
   */
  private resetBackoffIfRecovered(record: BundleRecord): void {
    // `MAX_RESTARTS` must bound CONSECUTIVE failures, not lifetime drops, and
    // the exponential backoff must start fresh for the next independent crash
    // episode. Without this, a remote connector that periodically drops and
    // cleanly reconnects (e.g. a server that idle-closes long-lived streams)
    // accrues restarts across its whole life and is wrongly killed after
    // `MAX_RESTARTS` total drops despite every reconnect succeeding. The reset
    // is gated on SUSTAINED uptime, not a single successful reconnect, on
    // purpose: a source that recovers then immediately re-drops never earns the
    // reset, so it still escalates to `dead` instead of looping forever.
    if (record.restartCount === 0) return;
    const uptime = record.source.uptime();
    if (uptime !== null && uptime >= this.checkIntervalMs) {
      record.restartCount = 0;
    }
  }

  /** Restart a downed source after exponential backoff, updating state on the outcome. */
  private async attemptRestart(record: BundleRecord, remote: boolean): Promise<void> {
    record.state = "restarting";
    const delay = this.baseDelayMs * 2 ** record.restartCount;
    record.restartCount++;

    this.emitBundleEvent(record, "bundle.restarting", remote, {
      attempt: record.restartCount,
      delayMs: delay,
    });

    await sleep(delay);

    // Remote sources reconnect via transport stop+start cycle; stdio sources
    // restart the subprocess.
    const ok = remote ? await this.reconnectRemote(record.source) : await record.source.restart();

    if (ok) {
      record.state = "healthy";
      this.emitBundleEvent(record, "bundle.recovered", remote);
    } else {
      // Restart failed — check again on next cycle (might hit max)
      record.state = "restarting";
    }
  }

  /** Emit a `run.error` lifecycle event for a bundle, flagging remote sources. */
  private emitBundleEvent(
    record: BundleRecord,
    event: string,
    remote: boolean,
    extra: Record<string, unknown> = {},
  ): void {
    this.eventSink.emit({
      type: "run.error",
      data: {
        source: record.source.name,
        event,
        ...extra,
        ...(remote ? { remote: true } : {}),
      },
    });
  }

  /**
   * Reconnect a remote source. Routes through `restart()` (→ tryRestart) so a
   * HealthMonitor tick shares the source's in-flight-restart guard with inline
   * session recovery (readResource / callTool) — otherwise the two could fire
   * concurrent stop()/start() cycles on the same source after a roll.
   * `restart()` never throws: it returns false and emits `source.restart_failed`.
   */
  private async reconnectRemote(source: McpSource): Promise<boolean> {
    return source.restart();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Duck-type check for remote sources. If McpSource has isRemote(), use it.
 * Otherwise fall back to checking for a remoteConfig property.
 */
function isRemoteSource(source: McpSource): boolean {
  const s = source as unknown as { isRemote?: () => boolean };
  if (typeof s.isRemote === "function") {
    return s.isRemote();
  }
  return false;
}
