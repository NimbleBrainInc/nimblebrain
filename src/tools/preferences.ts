/**
 * A person's preferences against the deployment's defaults: what they have
 * set, what each unset one falls back to, and the patch `nb__set_preferences`
 * applies (`src/platform/AGENTS.md` §1.3: omitted leaves it, a value sets it,
 * `null` clears it).
 */

import { resolvedBrand } from "../brand/index.ts";
import { isKnownTimezone } from "../identity/timezone.ts";
import type { UserPreferences } from "../identity/user.ts";
import type {
  EffectivePreferences,
  OwnPreferences,
  PreferenceDefaults,
  SetPreferencesInput,
  Theme,
} from "../platform/schemas/preferences.ts";
import type { Runtime } from "../runtime/runtime.ts";

/** The locale a person has when they have not set one. */
export const DEFAULT_LOCALE = "en-US";

/** The string preferences a person sets directly; `model` is stored as `models.default`. */
const SCALAR_KEYS = ["timezone", "locale", "theme"] as const;

/**
 * What each preference resolves to for someone who has not set it. The model
 * is the instance's configured default, untinted by the caller, as in
 * `get_config`'s `resolved`.
 */
export function preferenceDefaults(runtime: Runtime): PreferenceDefaults {
  const brandTheme = resolvedBrand().defaultTheme;
  const theme: Theme = brandTheme === "light" || brandTheme === "dark" ? brandTheme : "system";
  return {
    timezone: runtime.getOperatorTimezone(),
    locale: DEFAULT_LOCALE,
    theme,
    model: runtime.configuredModelSlots().default,
  };
}

/** The preferences a person has set. An unset or empty stored value is absent. */
export function ownPreferences(prefs: UserPreferences | undefined): OwnPreferences {
  const own: OwnPreferences = {};
  for (const key of SCALAR_KEYS) {
    const value = prefs?.[key]?.trim();
    if (value) own[key] = value;
  }
  const model = prefs?.models?.default?.trim();
  if (model) own.model = model;
  return own;
}

/**
 * Each preference in force: the person's own when they set it, else the
 * default. A stored value the runtime would not use is not in force: a
 * timezone `Intl` does not know, as in `effectiveTimezone`, and a model
 * `isModelPermitted` refuses, the check `Runtime.getModelSlots` applies on read.
 */
export function effectivePreferences(
  prefs: UserPreferences | undefined,
  defaults: PreferenceDefaults,
  isModelPermitted: (model: string) => boolean,
): EffectivePreferences {
  const own = ownPreferences(prefs);
  const pick = (value: string | undefined, fallback: string) =>
    value ? { value, source: "own" as const } : { value: fallback, source: "default" as const };
  const timezone = own.timezone && isKnownTimezone(own.timezone) ? own.timezone : undefined;
  const model = own.model && isModelPermitted(own.model) ? own.model : undefined;
  return {
    timezone: pick(timezone, defaults.timezone),
    locale: pick(own.locale, defaults.locale),
    theme: pick(own.theme, defaults.theme),
    model: pick(model, defaults.model),
  };
}

/**
 * Why the patch cannot apply, or null. `""` is never a clear: it is refused
 * with a message naming `null`, the one spelling of a clear.
 */
export function preferencesInputError(input: SetPreferencesInput): string | null {
  if (input.displayName !== undefined && !input.displayName.trim()) {
    return "displayName cannot be empty.";
  }
  for (const key of ["timezone", "locale", "theme", "model"] as const) {
    const value = input[key];
    if (typeof value === "string" && !value.trim()) {
      return `${key} cannot be empty. Pass null to clear it and use the default.`;
    }
  }
  if (typeof input.timezone === "string" && !isKnownTimezone(input.timezone.trim())) {
    return `Timezone "${input.timezone.trim()}" is not a known IANA timezone (e.g. "Pacific/Honolulu"). Pass null to use the default.`;
  }
  return null;
}

/** Whether the input names any preference at all. */
export function hasPreferenceFields(input: SetPreferencesInput): boolean {
  return (["displayName", "timezone", "locale", "theme", "model"] as const).some(
    (key) => input[key] !== undefined,
  );
}

/**
 * The stored preferences after the patch. A clear deletes the key, so the
 * default applies when read; a cleared model leaves no empty `models` behind.
 */
export function applyPreferencesPatch(
  prefs: UserPreferences,
  input: SetPreferencesInput,
): UserPreferences {
  const next: UserPreferences = { ...prefs };
  for (const key of SCALAR_KEYS) {
    const value = input[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value.trim();
  }
  if (input.model === null) {
    const { default: _cleared, ...rest } = next.models ?? {};
    if (Object.keys(rest).length > 0) next.models = rest;
    else delete next.models;
  } else if (input.model !== undefined) {
    next.models = { ...next.models, default: input.model.trim() };
  }
  return next;
}
