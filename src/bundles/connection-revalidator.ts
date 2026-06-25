/**
 * ConnectionRevalidator — the kernel's generic credential re-validation loop.
 *
 * A sibling to `HealthMonitor`, but a DISJOINT concern: `HealthMonitor` checks
 * liveness-of-PROCESS (is the transport up? restart it) over contextless
 * `McpSource` objects. This checks liveness-of-CREDENTIAL (did the upstream
 * authorization lapse?) over `BundleLifecycle` connections — which carry the
 * `(serverName, wsId, principalId, ref)` tuple a provider probe needs. It never
 * touches transports, restarts, or `dead`; it only flips `running →
 * reauth_required` when a provider's probe says the upstream credential is
 * definitively gone. Recovery stays the explicit user reconnect flow — the
 * revalidator never auto-promotes back to `running`.
 *
 * Provider specifics live entirely behind `ConnectionHealthProbe`
 * (`./connection-probe.ts`); this loop dispatches by `providerId` and never
 * names a vendor.
 *
 * Operational contract (an external SaaS on a timer inside the runtime
 * process — it must degrade nothing):
 *   - Bounded fan-out (concurrency cap), never `Promise.all` over the whole set.
 *   - Jittered interval + random startup offset (one provider key is shared
 *     across all tenant pods — avoid a synchronized thundering herd).
 *   - Skip-if-still-running so a slow sweep can't stack.
 *   - Per-sweep try/catch so one bad sweep never kills the timer.
 *   - Anti-flap: N consecutive `credential_lost` before a flip; `indeterminate`
 *     (any API error/timeout) is a no-op that preserves the streak; `live`
 *     resets it.
 *   - Circuit breaker: if a single sweep would flip more than a threshold,
 *     abort the sweep and keep ALL state — a mass disappearance of credentials
 *     is far more likely an upstream fault than every user revoking at once.
 *
 * Multi-replica note: at `replicas: 1` (the only supported topology today)
 * per-pod re-validation is correct — each pod owns its connections' in-memory
 * state. At `replicas > 1` this needs leader election (per-tenant Redis lease)
 * + the clustered RunBus; see the prerequisites in this package's `CLAUDE.md`.
 */

import { log } from "../observability/log.ts";
import {
  bundleProviderId,
  type ConnectionHealthProbe,
  type ProbeTarget,
} from "./connection-probe.ts";
import type { BundleLifecycleManager } from "./lifecycle.ts";

const DEFAULT_INTERVAL_MS = 300_000; // 5 min
const DEFAULT_CONCURRENCY = 8;
/** Consecutive `credential_lost` verdicts required before flipping to reauth. */
const FLIP_THRESHOLD = 2;
/** ±fraction jitter applied to every interval (and the startup offset). */
const JITTER_FRACTION = 0.2;
/** Circuit breaker: a sweep that would flip more than max(ABS, FRACTION×checked)
 *  connections is treated as an upstream fault — abort, flip nothing. */
const FLAP_BREAKER_ABS = 5;
const FLAP_BREAKER_FRACTION = 0.5;

export interface RevalidatorOptions {
  intervalMs?: number;
  concurrency?: number;
}

interface Candidate {
  target: ProbeTarget;
  key: string;
}

export class ConnectionRevalidator {
  private readonly probes: Map<string, ConnectionHealthProbe>;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  /** key `serverName|wsId|principalId` → consecutive credential_lost count. */
  private readonly degradedStreak = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;
  private stopped = false;

  constructor(
    private readonly lifecycle: BundleLifecycleManager,
    probes: ConnectionHealthProbe[],
    opts: RevalidatorOptions = {},
  ) {
    this.probes = new Map(probes.map((p) => [p.providerId, p]));
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /** Start the loop. No-op when no probes are registered (e.g. Composio not
   *  configured) — the loop is dormant, not merely idle. */
  start(): void {
    if (this.timer || this.probes.size === 0) return;
    log.info(
      `[connection-revalidator] starting (interval=${Math.round(this.intervalMs / 1000)}s, ` +
        `providers=${[...this.probes.keys()].join(",")})`,
    );
    // Random first offset within one interval so pods don't align on boot.
    this.scheduleNext(Math.random() * this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sweep().finally(() => this.scheduleNext(this.jitter(this.intervalMs)));
    }, delayMs);
  }

  /** ±JITTER_FRACTION around `ms`. (Runtime code — `Math.random` is allowed
   *  here; the restriction is only on deterministic workflow scripts.) */
  private jitter(ms: number): number {
    const delta = ms * JITTER_FRACTION;
    return ms - delta + Math.random() * 2 * delta;
  }

  /** One re-validation pass. Public for tests; the timer calls it. */
  async sweep(signal?: AbortSignal): Promise<void> {
    if (this.sweeping) {
      log.debug("mcp", "[connection-revalidator] previous sweep still running — skipping tick");
      return;
    }
    this.sweeping = true;
    const startedAt = Date.now();
    try {
      const targets = this.collectTargets();
      if (targets.length === 0) return;

      const verdicts = new Array<"live" | "credential_lost" | "indeterminate">(targets.length);
      let errors = 0;
      await this.forEachBounded(targets, async (t, i) => {
        const probe = this.probes.get(bundleProviderId(t.ref) ?? "");
        if (!probe) {
          verdicts[i] = "indeterminate";
          return;
        }
        const v = await probe.probe(t, signal ?? neverAbort());
        verdicts[i] = v;
        if (v === "indeterminate") errors++;
      });

      // Update streaks; collect connections that crossed the flip threshold.
      const seen = new Set<string>();
      const candidates: Candidate[] = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i] as ProbeTarget;
        const key = streakKey(t);
        seen.add(key);
        const v = verdicts[i];
        if (v === "live") {
          this.degradedStreak.delete(key);
        } else if (v === "credential_lost") {
          const next = (this.degradedStreak.get(key) ?? 0) + 1;
          this.degradedStreak.set(key, next);
          if (next >= FLIP_THRESHOLD) candidates.push({ target: t, key });
        }
        // indeterminate: leave the streak untouched (preserve across one bad sweep).
      }
      // Drop streaks for connections no longer present/running — keep the map bounded.
      for (const key of this.degradedStreak.keys()) {
        if (!seen.has(key)) this.degradedStreak.delete(key);
      }

      // Circuit breaker: a mass flip is more likely an upstream fault than a
      // real mass revocation. Abort the sweep, flip nothing, and reset the
      // candidates' streaks so they must re-confirm from scratch.
      const breakerLimit = Math.max(
        FLAP_BREAKER_ABS,
        Math.ceil(targets.length * FLAP_BREAKER_FRACTION),
      );
      let flipped = 0;
      if (candidates.length > breakerLimit) {
        for (const c of candidates) this.degradedStreak.delete(c.key);
        log.error(
          `[connection-revalidator] FLAP STORM: ${candidates.length}/${targets.length} connections ` +
            `would flip to reauth_required in one sweep — aborting, keeping all state (likely an ` +
            `upstream provider fault, not mass revocation). Streaks reset.`,
        );
      } else {
        for (const c of candidates) {
          if (this.flip(c)) flipped++;
        }
      }

      log.info(
        `[connection-revalidator] swept checked=${targets.length} ` +
          `lost=${candidates.length} flipped=${flipped} errors=${errors} ` +
          `durationMs=${Date.now() - startedAt}`,
      );
    } catch (err) {
      // A sweep must never kill the timer.
      log.warn(
        `[connection-revalidator] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /** Apply one flip. Re-checks the connection is STILL running at flip time —
   *  `recordConnectionStateChange` races a concurrent user-initiated reconnect,
   *  and we must never clobber a fresh `pending_auth`/`running`. */
  private flip(c: Candidate): boolean {
    const { serverName, wsId, principalId } = c.target;
    const inst = this.lifecycle.getInstance(serverName, wsId);
    const state = inst?.connections?.get(principalId)?.state ?? inst?.state;
    if (state !== "running") {
      this.degradedStreak.delete(c.key);
      return false;
    }
    this.lifecycle.recordConnectionStateChange(serverName, wsId, principalId, "reauth_required");
    this.degradedStreak.delete(c.key); // no longer running → won't be re-probed
    log.warn(
      `[connection-revalidator] flip ${serverName} (ws=${wsId}, principal=${principalId}) ` +
        `running → reauth_required: upstream credential gone (${FLIP_THRESHOLD} consecutive checks)`,
    );
    return true;
  }

  /** Enumerate `running` connections whose provider has a registered probe. */
  private collectTargets(): ProbeTarget[] {
    const out: ProbeTarget[] = [];
    for (const inst of this.lifecycle.getInstances()) {
      const ref = inst.ref;
      const providerId = bundleProviderId(ref);
      if (!providerId || !this.probes.has(providerId) || !ref) continue;

      const conns = inst.connections;
      if (conns && conns.size > 0) {
        for (const conn of conns.values()) {
          if (conn.state === "running") {
            out.push({
              serverName: inst.serverName,
              wsId: inst.wsId,
              principalId: conn.principalId,
              ref,
            });
          }
        }
      } else if (inst.state === "running") {
        // No per-principal map (shouldn't happen for a running URL bundle) —
        // fall back to the workspace principal.
        out.push({ serverName: inst.serverName, wsId: inst.wsId, principalId: "_workspace", ref });
      }
    }
    return out;
  }

  /** Bounded worker pool — inlined to avoid a bundles→runtime import cycle. */
  private async forEachBounded(
    items: ProbeTarget[],
    worker: (item: ProbeTarget, index: number) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    const limit = Math.min(this.concurrency, items.length);
    let cursor = 0;
    const runners = Array.from({ length: limit }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await worker(items[idx] as ProbeTarget, idx);
      }
    });
    await Promise.all(runners);
  }
}

function streakKey(t: ProbeTarget): string {
  return `${t.serverName}|${t.wsId}|${t.principalId}`;
}

/** An AbortSignal that never fires — for the timer-driven sweep (cancellation
 *  is handled by `stop()` clearing the timer, not mid-sweep abort). */
function neverAbort(): AbortSignal {
  return new AbortController().signal;
}
