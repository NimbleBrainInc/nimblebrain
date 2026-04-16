import type { EventSink } from "../engine/types.ts";
import type { McpSource } from "./mcp-source.ts";

export type BundleState = "healthy" | "restarting" | "dead";

export interface BundleHealth {
  name: string;
  state: BundleState;
  uptime: number | null;
  restartCount: number;
  /** Populated for bundles that never came up (dead-on-arrival). */
  error?: string;
}

interface BundleRecord {
  source: McpSource;
  state: BundleState;
  restartCount: number;
}

/** Dead-on-arrival record for a bundle whose startup threw — the process is
 *  not running, so no McpSource exists to monitor. Kept here so `/v1/health`
 *  can still report it as `dead` (operators would otherwise see the bundle
 *  simply vanish from health output). */
export interface StartFailureRecord {
  name: string;
  error: string;
}

const MAX_RESTARTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

export interface HealthMonitorOptions {
  checkIntervalMs?: number;
  baseDelayMs?: number;
  /** Bundles that threw at startup and should be reported as `dead`. */
  startFailures?: StartFailureRecord[];
}

/**
 * Monitors MCP subprocess health and auto-restarts dead bundles
 * with exponential backoff.
 */
export class HealthMonitor {
  private records: BundleRecord[];
  private startFailures: StartFailureRecord[];
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
    this.startFailures = opts.startFailures ?? [];
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

  /** Get per-bundle health info. Merges live records with dead-on-arrival
   *  start failures so operators see every bundle the system tried to run. */
  getStatus(): BundleHealth[] {
    const live: BundleHealth[] = this.records.map((r) => ({
      name: r.source.name,
      state: r.state,
      uptime: r.source.uptime(),
      restartCount: r.restartCount,
    }));
    // A start failure is suppressed if the same server later came up. We
    // compare by name so the live record (which has real uptime) wins.
    const liveNames = new Set(live.map((r) => r.name));
    const dead: BundleHealth[] = this.startFailures
      .filter((f) => !liveNames.has(f.name))
      .map((f) => ({
        name: f.name,
        state: "dead" as BundleState,
        uptime: null,
        restartCount: 0,
        error: f.error,
      }));
    return [...live, ...dead];
  }

  private async checkOne(record: BundleRecord): Promise<void> {
    // Dead is terminal — no more restart attempts
    if (record.state === "dead") return;

    // Skip if source is alive
    if (record.source.isAlive()) return;

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
      console.error("[health-monitor] reconnect failed:", err);
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
