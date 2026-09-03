/**
 * What paces the outbox poll, and where every default comes from.
 *
 * The cadence numbers are the runtime's, not the server's: a server recommends
 * (`nextPollMs`) and the runtime decides, because the cost of the poll is the
 * runtime's to pay. Everything here is one `nimblebrain.json` block,
 * `notifications.poll`, so an operator who needs to move the cost has one place
 * to move it and the schema documents the same four keys.
 */

/** The `notifications.poll` block, as an operator writes it. */
export interface NotificationsPollConfig {
  intervalMs?: number;
  maxIntervalMs?: number;
  maxEvents?: number;
  budgetPerMinute?: number;
}

/** The same four keys, resolved. */
export type ResolvedPollConfig = Required<NotificationsPollConfig>;

/**
 * The finest cadence the runtime will keep, whatever a server recommends.
 *
 * Not configurable. It is the floor on how much of a tenant's edge budget a
 * standing background loop may consume, and an operator who could lower it
 * would be lowering it for a cost the design bounds on the *tenant's* behalf.
 * A server that wants to be read sooner than this wants a push, which is a
 * different door.
 */
export const POLL_FLOOR_MS = 15_000;

/** Base cadence per source. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Backoff ceiling: the slowest an idle source is read. */
const DEFAULT_MAX_INTERVAL_MS = 300_000;
/** Events asked for per read. */
const DEFAULT_MAX_EVENTS = 100;

/**
 * How the default poll budget is derived, rather than the number it comes to.
 *
 * The edge limiter is per tenant per pod and is shared with the agent's own
 * calls, so a background loop may take only a slice of it; a poll that finds
 * the transport idle-closed costs `initialize` + `initialized` + the read, so
 * the slice buys a third as many polls as requests. The three constants are the
 * argument — the product is not, which is why it is computed here rather than
 * written down as a default an operator would have to re-derive to change
 * safely.
 */
const EDGE_REQUESTS_PER_MINUTE = 120;
const POLL_SHARE_OF_EDGE_BUDGET = 0.25;
const REQUESTS_PER_POLL = 3;

/** Polls per workspace per minute, when the operator sets none. */
export const DEFAULT_BUDGET_PER_MINUTE = Math.floor(
  (EDGE_REQUESTS_PER_MINUTE * POLL_SHARE_OF_EDGE_BUDGET) / REQUESTS_PER_POLL,
);

/**
 * Every key of the block, for the schema drift guard.
 *
 * Derived from the resolver's own output so a fifth knob cannot be added to the
 * runtime and forgotten in the published schema.
 */
export const NOTIFICATIONS_POLL_CONFIG_KEYS = Object.keys(
  resolvePollConfig(),
) as (keyof ResolvedPollConfig)[];

/**
 * Resolve the block, clamping each value to a range the loop can actually keep.
 *
 * A garbage value resolves to its default rather than throwing: this runs at
 * source construction, and a mistyped cadence must not be the reason a runtime
 * fails to boot when the correct behaviour — poll at the documented default —
 * is unambiguous.
 */
export function resolvePollConfig(config?: NotificationsPollConfig): ResolvedPollConfig {
  const intervalMs = positive(config?.intervalMs, DEFAULT_INTERVAL_MS, POLL_FLOOR_MS);
  return {
    intervalMs,
    // The ceiling can never sit below the base: a `maxIntervalMs` under
    // `intervalMs` would make an idle source back off to a FASTER cadence than
    // a busy one, which is the opposite of what the knob says it does.
    maxIntervalMs: Math.max(
      intervalMs,
      positive(config?.maxIntervalMs, DEFAULT_MAX_INTERVAL_MS, POLL_FLOOR_MS),
    ),
    maxEvents: Math.min(positive(config?.maxEvents, DEFAULT_MAX_EVENTS, 1), 1000),
    budgetPerMinute: positive(config?.budgetPerMinute, DEFAULT_BUDGET_PER_MINUTE, 1),
  };
}

/**
 * Clamp a server's `nextPollMs` into the range the runtime will keep: never
 * faster than the floor, never slower than the configured ceiling.
 *
 * A recommendation outside the range is honoured *as far as the range allows*
 * rather than discarded, because both ends carry a meaning worth keeping — a
 * server asking for 2 s is saying "as fast as you will go", and one asking for
 * an hour is saying "as slow as you will go".
 */
export function clampNextPollMs(nextPollMs: number, config: ResolvedPollConfig): number {
  return Math.min(Math.max(nextPollMs, POLL_FLOOR_MS), config.maxIntervalMs);
}

/**
 * The cadence after `emptyStreak` consecutive empty polls: the base doubled per
 * empty poll, clamped to the ceiling.
 *
 * Stated as a mechanism rather than a ladder because both ends of it are
 * configurable — a written-down `60 → 120 → 300` would be a claim about the
 * defaults that goes false the moment an operator moves either one.
 */
export function backoffIntervalMs(emptyStreak: number, config: ResolvedPollConfig): number {
  if (emptyStreak <= 0) return config.intervalMs;
  // Cap the exponent before it is applied: `2 ** 1024` is Infinity, and
  // `Math.min(Infinity, ceiling)` is fine but `Infinity` reaching a caller that
  // adds to it is not.
  const doublings = Math.min(emptyStreak, 32);
  return Math.min(config.intervalMs * 2 ** doublings, config.maxIntervalMs);
}

/** A positive finite number, or the default. Floored at `min`. */
function positive(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(Math.floor(value), min);
}
