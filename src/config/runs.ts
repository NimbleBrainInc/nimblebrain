/**
 * The `runs` block of `nimblebrain.json`: how many unattended runs the door
 * admits at once and holds waiting, and the most any one run may spend.
 *
 * The block is the operator's, not the work's author. A run's work names its
 * own caps (a task's `maxIterations`, `maxInputTokens`, `maxRunDurationMs`);
 * these ceilings bound what it names, and what the door fills in for what it
 * left unset, when the run starts. Enforcing there covers every run, whoever
 * described it.
 */

import { DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS } from "../limits.ts";

/** The `runs` block, as an operator writes it. */
export interface RunsConfig {
  /**
   * Unattended runs in flight at once across every workspace in the process
   * (the runtime's run admission, `src/runtime/admission.ts`). Chat is not admitted.
   */
  maxConcurrentRuns?: number;
  /** Unattended runs held waiting for a slot. 0 refuses at the limit. */
  maxQueuedRuns?: number;
  /** Ceiling on one run's agentic iterations. */
  maxRunIterations?: number;
  /**
   * Ceiling on one run's input tokens, summed over every model call. Unset,
   * there is none, and a definition with no cap of its own runs uncapped.
   */
  maxRunInputTokens?: number;
  /** Ceiling on one run's wall-clock time, in ms. */
  maxRunDurationMs?: number;
}

/**
 * The same keys, resolved. `maxRunInputTokens` stays unset when the operator
 * sets none, because input tokens have no runtime default: a run is capped
 * only by its definition or by an operator ceiling.
 */
export type ResolvedRunsConfig = Required<Omit<RunsConfig, "maxRunInputTokens">> & {
  maxRunInputTokens: number | undefined;
};

/** Wall-clock for a run whose work sets none. */
export const DEFAULT_RUN_DURATION_MS = 120_000;

/**
 * The range each key is clamped to. The iteration and duration ceilings
 * default to the top of the range a work spec's limits may name, so work runs
 * as written unless an operator lowers the ceiling. The input-token ceiling has
 * no default, and its range reaches well past what work may name so an
 * operator can set one that admits the large runs uncapped work makes.
 */
export const RUNS_CONFIG_BOUNDS: Record<keyof RunsConfig, { min: number; max: number }> = {
  maxConcurrentRuns: { min: 1, max: 100 },
  maxQueuedRuns: { min: 0, max: 1000 },
  maxRunIterations: { min: 1, max: MAX_ITERATIONS },
  maxRunInputTokens: { min: 1_000, max: 100_000_000 },
  maxRunDurationMs: { min: 10_000, max: 600_000 },
};

/**
 * Resolve the block, clamping each value into its range.
 *
 * A value that is not a finite number resolves to its default rather than
 * throwing: this runs when the door first admits a run, and a mistyped
 * ceiling must not keep the runtime from booting when the documented default
 * is the unambiguous fallback. The schema rejects such a value at load anyway.
 */
export function resolveRunsConfig(config?: RunsConfig): ResolvedRunsConfig {
  const pick = (key: keyof RunsConfig): number | undefined => {
    const { min, max } = RUNS_CONFIG_BOUNDS[key];
    const raw = config?.[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
    return Math.min(Math.max(Math.floor(raw), min), max);
  };
  return {
    maxConcurrentRuns: pick("maxConcurrentRuns") ?? 2,
    maxQueuedRuns: pick("maxQueuedRuns") ?? 50,
    maxRunIterations: pick("maxRunIterations") ?? MAX_ITERATIONS,
    maxRunInputTokens: pick("maxRunInputTokens"),
    maxRunDurationMs: pick("maxRunDurationMs") ?? 600_000,
  };
}

/**
 * Every key of the block, for the schema drift guard. Derived from the bounds
 * the resolver clamps against, so a key added here cannot be forgotten in the
 * schema.
 */
export const RUNS_CONFIG_KEYS = Object.keys(RUNS_CONFIG_BOUNDS) as (keyof RunsConfig)[];

/** The per-run caps a run's work may name. */
export interface RunCaps {
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
}

/** The caps one run actually gets. No `maxInputTokens` means no input-token cap. */
export interface EffectiveRunLimits {
  maxIterations: number;
  maxInputTokens?: number;
  maxRunDurationMs: number;
}

/**
 * The caps a run of `auto` executes under: each value the work names, lowered
 * to the operator's ceiling, and the runtime's own default held to the ceiling
 * where it names none. Input tokens have no runtime default: an unset cap runs
 * under the operator's ceiling when one is configured, and uncapped when none
 * is.
 *
 * `defaultIterations` is the runtime's chat default, so work that names no
 * iteration cap runs with the same one a chat turn does.
 */
export function effectiveRunLimits(
  auto: RunCaps,
  config: ResolvedRunsConfig = resolveRunsConfig(),
  defaultIterations: number = DEFAULT_MAX_ITERATIONS,
): EffectiveRunLimits {
  const ceiling = config.maxRunInputTokens;
  const maxInputTokens =
    ceiling === undefined ? auto.maxInputTokens : Math.min(auto.maxInputTokens ?? ceiling, ceiling);
  return {
    maxIterations: Math.min(auto.maxIterations ?? defaultIterations, config.maxRunIterations),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    maxRunDurationMs: Math.min(
      auto.maxRunDurationMs ?? DEFAULT_RUN_DURATION_MS,
      config.maxRunDurationMs,
    ),
  };
}
