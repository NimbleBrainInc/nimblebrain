import type { EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import type { McpSource } from "./mcp-source.ts";

export type BundleState = "healthy" | "restarting" | "dead";

export interface BundleHealth {
  name: string;
  state: BundleState;
  uptime: number | null;
  restartCount: number;
}

interface BundleRecord {
  source: McpSource;
  state: BundleState;
  restartCount: number;
}

const MAX_RESTARTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

export interface HealthMonitorOptions {
  checkIntervalMs?: number;
  baseDelayMs?: number;
}

/**
 * Monitors MCP subprocess health and auto-restarts dead bundles
 * with exponential backoff.
 */
export class HealthMonitor {
  private records: BundleRecord[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkIntervalMs: number;
  private baseDelayMs: number;

  constructor(
    sources: McpSource[],
    private eventSink: EventSink,
    opts: HealthMonitorOptions = {},
  ) {
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.records = sources.map((source) => ({
      source,
      state: "healthy" as BundleState,
      restartCount: 0,
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
    // Dead is terminal — no more restart attempts
    if (record.state === "dead") return;

    // Skip if source is alive. A source that has stayed up for at least one
    // full check interval has demonstrably recovered, so clear the
    // consecutive-failure counter: `MAX_RESTARTS` must bound CONSECUTIVE
    // failures, not lifetime drops, and the exponential backoff must start
    // fresh for the next independent crash episode. Without this, a remote
    // connector that periodically drops and cleanly reconnects (e.g. a
    // server that idle-closes long-lived streams) accrues restarts across
    // its whole life and is wrongly killed after `MAX_RESTARTS` total drops
    // despite every reconnect succeeding. The reset is gated on SUSTAINED
    // uptime, not a single successful reconnect, on purpose: a source that
    // recovers then immediately re-drops never earns the reset, so it still
    // escalates to `dead` instead of looping forever.
    if (record.source.isAlive()) {
      if (record.restartCount > 0) {
        const uptime = record.source.uptime();
        if (uptime !== null && uptime >= this.checkIntervalMs) {
          record.restartCount = 0;
        }
      }
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

    const remote = isRemoteSource(record.source);

    // Source is down — emit crashed event
    this.eventSink.emit({
      type: "run.error",
      data: {
        source: record.source.name,
        event: "bundle.crashed",
        ...(remote ? { remote: true } : {}),
      },
    });

    // Check if we've exhausted restart attempts
    if (record.restartCount >= MAX_RESTARTS) {
      record.state = "dead";
      this.eventSink.emit({
        type: "run.error",
        data: {
          source: record.source.name,
          event: "bundle.dead",
          ...(remote ? { remote: true } : {}),
        },
      });
      return;
    }

    // Attempt restart with exponential backoff
    record.state = "restarting";
    const delay = this.baseDelayMs * 2 ** record.restartCount;
    record.restartCount++;

    this.eventSink.emit({
      type: "run.error",
      data: {
        source: record.source.name,
        event: "bundle.restarting",
        attempt: record.restartCount,
        delayMs: delay,
        ...(remote ? { remote: true } : {}),
      },
    });

    await sleep(delay);

    let ok: boolean;
    if (remote) {
      // Remote sources: reconnect via transport stop+start cycle
      ok = await this.reconnectRemote(record.source);
    } else {
      // Stdio sources: restart subprocess
      ok = await record.source.restart();
    }

    if (ok) {
      record.state = "healthy";
      this.eventSink.emit({
        type: "run.error",
        data: {
          source: record.source.name,
          event: "bundle.recovered",
          ...(remote ? { remote: true } : {}),
        },
      });
    } else {
      // Restart failed — check again on next cycle (might hit max)
      record.state = "restarting";
    }
  }

  /** Reconnect a remote source via transport-level stop+start. */
  private async reconnectRemote(source: McpSource): Promise<boolean> {
    try {
      await source.stop();
      await source.start();
      return true;
    } catch (err) {
      log.error("[health-monitor] reconnect failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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
