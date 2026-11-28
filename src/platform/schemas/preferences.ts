import { type Static, Type } from "@sinclair/typebox";
import { clearable, StringEnum } from "./_shared.ts";

// ── nb__set_preferences ────────────────────────────────────────────────────
//
// A patch (src/platform/AGENTS.md §1.3): an omitted field is left alone, a
// value sets it, and `null` clears it, so the deployment's default applies
// again. `""` is not a clear; the handler refuses it and names `null`.

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const SetPreferencesInput = Type.Object(
  {
    displayName: Type.Optional(
      Type.String({
        description:
          "User's display name (e.g., 'Matt'). Not clearable: a person always has a name.",
      }),
    ),
    timezone: clearable(
      Type.String(),
      "IANA timezone (e.g., 'Pacific/Honolulu'). null clears it, so the deployment's default timezone applies.",
    ),
    locale: clearable(
      Type.String(),
      "BCP 47 locale (e.g., 'en-US'). null clears it, so the deployment's default locale applies.",
    ),
    theme: clearable(
      StringEnum(THEMES),
      "Color theme. null clears it, so the deployment's default theme applies.",
    ),
    model: clearable(
      Type.String(),
      "Model for this user's new conversations, as `provider:model-id`. Applies to conversations started after the change; an existing one keeps the model it was created with. null clears the choice and follows the configured default. Auxiliary models (title generation, briefing, compaction) are operator-configured and not settable here.",
    ),
  },
  { additionalProperties: false },
);
export type SetPreferencesInput = Static<typeof SetPreferencesInput>;

/** A preference that has a deployment default to fall back to. */
export type DefaultablePreference = "timezone" | "locale" | "theme" | "model";

/**
 * What each preference resolves to for a person who has not set it: the
 * operator's `NB_TIMEZONE` (else UTC), `en-US`, the brand's `defaultTheme`
 * (else `system`), and the configured default model.
 */
export const PreferenceDefaults = Type.Object({
  timezone: Type.String(),
  locale: Type.String(),
  theme: StringEnum(THEMES),
  model: Type.String(),
});
export type PreferenceDefaults = Static<typeof PreferenceDefaults>;

/** A preference in force: its value, and whether the person set it or it is the default. */
export const EffectivePreference = Type.Object({
  value: Type.String(),
  source: StringEnum(["own", "default"] as const),
});
export type EffectivePreference = Static<typeof EffectivePreference>;

export const EffectivePreferences = Type.Object({
  timezone: EffectivePreference,
  locale: EffectivePreference,
  theme: EffectivePreference,
  model: EffectivePreference,
});
export type EffectivePreferences = Static<typeof EffectivePreferences>;

/** The preferences a person has set; a field is absent when they have not set it. */
export const OwnPreferences = Type.Object({
  timezone: Type.Optional(Type.String()),
  locale: Type.Optional(Type.String()),
  theme: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});
export type OwnPreferences = Static<typeof OwnPreferences>;

/** `nb__set_preferences`'s structured result. */
export const SetPreferencesOutput = Type.Object({
  success: Type.Literal(true),
  displayName: Type.String({ description: "The person's display name after the change." }),
  /** What the person has set after the change. */
  preferences: OwnPreferences,
  /** Each preference in force after the change: the person's own, else the default. */
  effective: EffectivePreferences,
});
export type SetPreferencesOutput = Static<typeof SetPreferencesOutput>;
