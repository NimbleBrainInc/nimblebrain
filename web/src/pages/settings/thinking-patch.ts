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

/** Select value for "no operator override — use the platform default policy". */
export const THINKING_DEFAULT = "" as const;

/** Select value for "no operator tier — use DEFAULT_THINKING_EFFORT". */
export const EFFORT_DEFAULT = "__default__" as const;

/**
 * Whether a chosen depth reaches the resolver in this mode.
 *
 * True for the default path (which reads `configEffort` with no mode set) and
 * for `enabled`; false for `off` and `adaptive`, which state no depth by
 * definition and return before the resolver looks at one.
 *
 * The render gate and the save patch both derive from this on purpose. They
 * disagreed once — the control was drawn only for `enabled` while the patch
 * cleared the field everywhere else — which made a depth set through the
 * config file or the admin tool disappear on the next save from this screen.
 */
export function effortAppliesTo(thinking: ThinkingMode | typeof THINKING_DEFAULT): boolean {
  return thinking === THINKING_DEFAULT || thinking === "enabled";
}

/**
 * Whether an explicit token budget is offered in this mode.
 *
 * Narrower than {@link effortAppliesTo}: the resolver would honor a bare budget
 * on the default path too, but this panel only offers the field alongside an
 * explicit `enabled`, so anywhere else the stored value is stale and gets
 * cleared rather than re-sent.
 */
export function budgetAppliesTo(thinking: ThinkingMode | typeof THINKING_DEFAULT): boolean {
  return thinking === "enabled";
}

/**
 * The thinking half of a `set_model_config` patch.
 *
 * Every field is either set or explicitly cleared, never omitted, so a value
 * the operator removed on this screen can't survive on disk from an earlier
 * save. Depth and budget are independent of each other and of the mode: the
 * budget only reaches providers that meter thinking in tokens, and sending one
 * never voids the chosen depth.
 */
export function thinkingPatchFor(
  thinking: ThinkingMode | typeof THINKING_DEFAULT,
  effort: ThinkingEffort | typeof EFFORT_DEFAULT,
  budget: number | null,
): Record<string, unknown> {
  const effortPatch =
    !effortAppliesTo(thinking) || effort === EFFORT_DEFAULT
      ? { clearThinkingEffort: true }
      : { thinkingEffort: effort };
  const budgetPatch =
    !budgetAppliesTo(thinking) || budget == null
      ? { clearThinkingBudget: true }
      : { thinkingBudgetTokens: budget };

  if (thinking === THINKING_DEFAULT) {
    return { clearThinking: true, ...effortPatch, ...budgetPatch };
  }
  return { thinking, ...effortPatch, ...budgetPatch };
}
