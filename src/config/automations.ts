/**
 * The `automations` block of `nimblebrain.json`: how much the runtime lets
 * automations spend at once, and the most any one run may spend.
 *
 * The block is the operator's, not the automation author's. An author sets a
 * run's caps on the definition (`maxIterations`, `maxInputTokens`,
 * `maxRunDurationMs`); these ceilings bound whatever the author set, and fill
 * in for what they left unset, at execution time. Enforcing there covers every
 * stored definition, however it was written (the tool, the CLI, a connector,
 * a hand edit).
 */

import { DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS } from "../limits.ts";

/** The `automations` block, as an operator writes it. */
export interface AutomationsConfig {
  /** Automation runs in flight at once across every workspace in the process. */
  maxConcurrentRuns?: number;
  /** Run now and event runs held waiting for a slot. 0 refuses at the limit. */
  maxQueuedRuns?: number;
  /** Ceiling on one run's agentic iterations. */
  maxRunIterations?: number;
  /** Ceiling on one run's input tokens, summed over every model call. */
  maxRunInputTokens?: number;
  /** Ceiling on one run's wall-clock time, in ms. */
  maxRunDurationMs?: number;
}

/** The same keys, resolved. */
export type ResolvedAutomationsConfig = Required<AutomationsConfig>;

/** Wall-clock for a run whose definition sets none. */
export const DEFAULT_RUN_DURATION_MS = 120_000;

/**
 * Each key's default and the range it is clamped to. The per-run ceilings
 * default to the top of the range the create and update tools accept, so a
 * definition those tools accept runs as written unless an operator lowers the
 * ceiling.
 */
const BOUNDS: Record<keyof ResolvedAutomationsConfig, { def: number; min: number; max: number }> = {
  maxConcurrentRuns: { def: 2, min: 1, max: 100 },
  maxQueuedRuns: { def: 50, min: 0, max: 1000 },
  maxRunIterations: { def: MAX_ITERATIONS, min: 1, max: MAX_ITERATIONS },
  maxRunInputTokens: { def: 1_000_000, min: 1_000, max: 1_000_000 },
  maxRunDurationMs: { def: 600_000, min: 10_000, max: 600_000 },
};

/**
 * Resolve the block, clamping each value into its range.
 *
 * A value that is not a finite number resolves to its default rather than
 * throwing: this runs when the automations source starts, and a mistyped
 * ceiling must not keep the runtime from booting when the documented default
 * is the unambiguous fallback. The schema rejects such a value at load anyway.
 */
export function resolveAutomationsConfig(config?: AutomationsConfig): ResolvedAutomationsConfig {
  const pick = (key: keyof ResolvedAutomationsConfig): number => {
    const { def, min, max } = BOUNDS[key];
    const raw = config?.[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
    return Math.min(Math.max(Math.floor(raw), min), max);
  };
  return {
    maxConcurrentRuns: pick("maxConcurrentRuns"),
    maxQueuedRuns: pick("maxQueuedRuns"),
    maxRunIterations: pick("maxRunIterations"),
    maxRunInputTokens: pick("maxRunInputTokens"),
    maxRunDurationMs: pick("maxRunDurationMs"),
  };
}

/**
 * Every key of the block, for the schema drift guard. Derived from the
 * resolver's output so a key added here cannot be forgotten in the schema.
 */
export const AUTOMATIONS_CONFIG_KEYS = Object.keys(
  resolveAutomationsConfig(),
) as (keyof ResolvedAutomationsConfig)[];

/** The per-run caps an automation definition may set (`Automation` in the automations app). */
export interface RunCaps {
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
}

/** The caps one run actually gets. */
export interface EffectiveRunLimits {
  maxIterations: number;
  maxInputTokens: number;
  maxRunDurationMs: number;
}

/**
 * The caps a run of `auto` executes under: each value the definition sets,
 * lowered to the operator's ceiling, and the ceiling (or the runtime's own
 * default, for iterations and duration) where it sets none.
 *
 * `defaultIterations` is the runtime's chat default, so an automation that
 * names no iteration cap runs with the same one a chat turn does.
 */
export function effectiveRunLimits(
  auto: RunCaps,
  config: ResolvedAutomationsConfig = resolveAutomationsConfig(),
  defaultIterations: number = DEFAULT_MAX_ITERATIONS,
): EffectiveRunLimits {
  return {
    maxIterations: Math.min(auto.maxIterations ?? defaultIterations, config.maxRunIterations),
    maxInputTokens: Math.min(
      auto.maxInputTokens ?? config.maxRunInputTokens,
      config.maxRunInputTokens,
    ),
    maxRunDurationMs: Math.min(
      auto.maxRunDurationMs ?? DEFAULT_RUN_DURATION_MS,
      config.maxRunDurationMs,
    ),
  };
}

/**
 * One sentence per cap the definition sets above its ceiling, for the create
 * and update responses. Empty when nothing is lowered.
 */
export function describeClampedLimits(auto: RunCaps, effective: EffectiveRunLimits): string[] {
  const notes: string[] = [];
  const check = (field: keyof EffectiveRunLimits, asked: number | undefined) => {
    if (asked != null && asked > effective[field]) {
      notes.push(
        `${field} ${asked} is above this runtime's per-run ceiling; runs use ${effective[field]}.`,
      );
    }
  };
  check("maxIterations", auto.maxIterations);
  check("maxInputTokens", auto.maxInputTokens);
  check("maxRunDurationMs", auto.maxRunDurationMs);
  return notes;
}
