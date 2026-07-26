/**
 * The Settings → Model thinking payload, as pure data logic.
 *
 * Deliberately free of React and of the API client so the exact object the
 * panel sends can be fed to `set_model_config` from a server-side test. The
 * depth control shipped inert three times because the web side asserted the
 * patch shape, the server side asserted hand-written inputs, and nothing
 * crossed the boundary between them.
 */

// Mirrors `RuntimeConfig["thinking"]` and `ThinkingEffort` in
// src/runtime/types.ts and src/engine/types.ts. Re-declared rather than
// imported because web/ is deliberately isolated from src/ — same convention
// as web/src/types.ts. A tier added there must be added here too.
export type ThinkingMode = "off" | "adaptive" | "enabled";
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The tiers, in ascending depth, with their labels. The panel renders from
 * this rather than hard-coding a second copy of the list: a tier added to
 * `ThinkingEffort` above and not here would compile clean and simply never be
 * offerable.
 */
export const THINKING_EFFORT_OPTIONS: ReadonlyArray<{ value: ThinkingEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

/** Select value for "no operator override — use the platform default policy". */
export const THINKING_DEFAULT = "" as const;

/** Select value for "no operator tier — use DEFAULT_THINKING_EFFORT". */
export const EFFORT_DEFAULT = "__default__" as const;

/**
 * Whether the resolver reads depth and budget in this mode.
 *
 * True for the default path — which reads both with no mode set — and for
 * `enabled`. False for `off` and `adaptive`, which return before looking at
 * either.
 *
 * One predicate for both fields, and it gates the render as well as the patch.
 * Every arrangement of this that used more than one has produced the same bug:
 * a field the panel doesn't draw gets cleared on save, silently deleting a
 * value set through the config file or the admin tool. Depth hit it first
 * (drawn only for `enabled`), then budget, once a bare budget became
 * load-bearing in the resolver. The render gate must equal what the resolver
 * honors, or the panel is destroying config it never showed.
 */
export function tuningAppliesTo(thinking: ThinkingMode | typeof THINKING_DEFAULT): boolean {
  return thinking === THINKING_DEFAULT || thinking === "enabled";
}

/**
 * The thinking half of a `set_model_config` patch.
 *
 * Every field is either set or explicitly cleared, never omitted, so a value
 * the operator removed on this screen can't survive on disk from an earlier
 * save. The cost is deliberate and worth naming: switching to `off` or
 * `adaptive` and saving deletes a persisted depth and budget, so an
 * Enabled → Adaptive → Enabled round trip through this panel does not restore
 * a depth set in `nimblebrain.json` or via `set_model_config`. Keeping them
 * would mean the panel preserving values it isn't showing, which is the
 * failure this rule exists to prevent; both modes genuinely ignore them.
 *
 * Depth and budget are independent of each other and of the mode: the
 * budget only reaches providers that meter thinking in tokens, and sending one
 * never voids the chosen depth.
 */
export function thinkingPatchFor(
  thinking: ThinkingMode | typeof THINKING_DEFAULT,
  effort: ThinkingEffort | typeof EFFORT_DEFAULT,
  budget: number | null,
): Record<string, unknown> {
  const applies = tuningAppliesTo(thinking);
  const effortPatch =
    !applies || effort === EFFORT_DEFAULT
      ? { clearThinkingEffort: true }
      : { thinkingEffort: effort };
  const budgetPatch =
    !applies || budget == null ? { clearThinkingBudget: true } : { thinkingBudgetTokens: budget };

  if (thinking === THINKING_DEFAULT) {
    return { clearThinking: true, ...effortPatch, ...budgetPatch };
  }
  return { thinking, ...effortPatch, ...budgetPatch };
}
