/**
 * The Organization → Models form's fields and the `set_model_config` patch each one
 * sends, as pure data logic.
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
 * either. The panel draws the Effort and Budget fields only where this holds.
 */
export function tuningAppliesTo(thinking: ThinkingMode | typeof THINKING_DEFAULT): boolean {
  return thinking === THINKING_DEFAULT || thinking === "enabled";
}

/**
 * What each field holds while it is edited. Number fields hold the input's
 * text, so a half-typed value is never coerced; an empty field, or an empty
 * select option, means "no override".
 */
export interface ModelConfigValues {
  defaultModel: string;
  fastModel: string;
  maxIterations: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  thinking: ThinkingMode | typeof THINKING_DEFAULT;
  thinkingEffort: ThinkingEffort | typeof EFFORT_DEFAULT;
  thinkingBudgetTokens: string;
}

export type ModelConfigField = keyof ModelConfigValues;

/** `""` → `null`; otherwise the number the field holds. */
const numberOrNull = (raw: string) => (raw.trim() === "" ? null : Number(raw));

/**
 * The `set_model_config` patch for one field.
 *
 * One field per save, so a save never touches a field the operator did not
 * change. An empty value is sent as `null`, which clears the override; omitting
 * the key would leave the old value in place. Changing the thinking mode does
 * not send the depth or budget: `off` and `adaptive` ignore both, and keeping
 * them means switching back to a mode that reads them restores what was set.
 */
export function modelConfigPatch<K extends ModelConfigField>(
  field: K,
  value: ModelConfigValues[K],
): Record<string, unknown> {
  switch (field) {
    case "defaultModel":
      return { models: { default: value || null } };
    case "fastModel":
      return { models: { fast: value || null } };
    case "maxIterations":
    case "maxInputTokens":
    case "maxOutputTokens":
    case "thinkingBudgetTokens":
      return { [field]: numberOrNull(value) };
    case "thinking":
      return { thinking: value === THINKING_DEFAULT ? null : value };
    case "thinkingEffort":
      return { thinkingEffort: value === EFFORT_DEFAULT ? null : value };
  }
  throw new Error(`Unknown model config field: ${String(field)}`);
}
