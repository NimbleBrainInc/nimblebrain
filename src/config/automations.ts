/**
 * The `automations` block of `nimblebrain.json`: how much the runtime lets
 * automations spend at once, and the most any one run may spend.
 *
 * The block is the operator's, not the automation author's. An author sets a
 * run's caps on the definition (`maxIterations`, `maxInputTokens`,
 * `maxRunDurationMs`); these ceilings bound what the author set, and what the
 * runtime fills in for what they left unset, at execution time. Enforcing
 * there covers every stored definition, however it was written (the tool, the
 * CLI, a connector, a hand edit).
 */

import { DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS } from "../limits.ts";

/** The `automations` block, as an operator writes it. */
export interface AutomationsConfig {
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
export type ResolvedAutomationsConfig = Required<Omit<AutomationsConfig, "maxRunInputTokens">> & {
  maxRunInputTokens: number | undefined;
};

/** Wall-clock for a run whose definition sets none. */
export const DEFAULT_RUN_DURATION_MS = 120_000;

/**
 * The range each key is clamped to. The iteration and duration ceilings
 * default to the top of the range the create and update tools accept, so a
 * definition those tools accept runs as written unless an operator lowers the
 * ceiling. The input-token ceiling has no default, and its range reaches well
 * past the create range so an operator can set one that admits the large runs
 * uncapped definitions make.
 */
export const AUTOMATIONS_CONFIG_BOUNDS: Record<
  keyof AutomationsConfig,
  { min: number; max: number }
> = {
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
 * throwing: this runs when the automations source starts, and a mistyped
 * ceiling must not keep the runtime from booting when the documented default
 * is the unambiguous fallback. The schema rejects such a value at load anyway.
 */
export function resolveAutomationsConfig(config?: AutomationsConfig): ResolvedAutomationsConfig {
  const pick = (key: keyof AutomationsConfig): number | undefined => {
    const { min, max } = AUTOMATIONS_CONFIG_BOUNDS[key];
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
export const AUTOMATIONS_CONFIG_KEYS = Object.keys(
  AUTOMATIONS_CONFIG_BOUNDS,
) as (keyof AutomationsConfig)[];

/** The per-run caps an automation definition may set (`Automation` in the automations app). */
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
 * The caps a run of `auto` executes under: each value the definition sets,
 * lowered to the operator's ceiling, and the runtime's own default held to
 * the ceiling where it sets none. Input tokens have no runtime default: an
 * unset cap runs under the operator's ceiling when one is configured, and
 * uncapped when none is.
 *
 * `defaultIterations` is the runtime's chat default, so an automation that
 * names no iteration cap runs with the same one a chat turn does.
 */
export function effectiveRunLimits(
  auto: RunCaps,
  config: ResolvedAutomationsConfig = resolveAutomationsConfig(),
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

/**
 * One sentence per cap the definition sets above its ceiling, for the create
 * and update responses. Empty when nothing is lowered.
 */
export function describeClampedLimits(auto: RunCaps, effective: EffectiveRunLimits): string[] {
  const notes: string[] = [];
  const check = (field: keyof EffectiveRunLimits, asked: number | undefined) => {
    const applied = effective[field];
    if (asked != null && applied != null && asked > applied) {
      notes.push(`${field} ${asked} is above this runtime's per-run ceiling; runs use ${applied}.`);
    }
  };
  check("maxIterations", auto.maxIterations);
  check("maxInputTokens", auto.maxInputTokens);
  check("maxRunDurationMs", auto.maxRunDurationMs);
  return notes;
}
