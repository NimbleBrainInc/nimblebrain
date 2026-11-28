import { Monitor, Moon, Sun, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PreferenceDefaults } from "../../_generated/platform-schemas/preferences";
import { callToolWithoutWorkspace } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { TimezoneSelect } from "../../components/ui/timezone-select";
import { useSession } from "../../context/SessionContext";
import { useTheme } from "../../context/ThemeContext";
import { useAutosaveForm } from "../../hooks/useAutosaveForm";
import { cn } from "../../lib/utils";
import {
  AutosaveField,
  type ModelEntry,
  ModelSelect,
  Section,
  SettingsFormPage,
} from "./components";

type Theme = "system" | "light" | "dark";

const THEME_OPTIONS: { value: Theme; label: string; description: string; icon: typeof Monitor }[] =
  [
    { value: "system", label: "System", description: "Follow your OS preference", icon: Monitor },
    { value: "light", label: "Light", description: "Warm paper-like interface", icon: Sun },
    { value: "dark", label: "Dark", description: "Warm charcoal interface", icon: Moon },
  ];

interface ProfileConfig {
  /** What the person set; a preference they have not set is absent. */
  preferences?: Record<string, unknown>;
  /** What each unset preference falls back to. */
  preferenceDefaults?: PreferenceDefaults;
  availableModels?: Record<string, ModelEntry[]>;
}

/** `""` in a clearable field means unset: the deployment's default applies. */
interface ProfileValues {
  displayName: string;
  timezone: string;
  model: string;
  theme: Theme | "";
}

type ProfileField = keyof ProfileValues;

const LABELS: Record<ProfileField, string> = {
  displayName: "Display name",
  timezone: "Timezone",
  model: "Your model",
  theme: "Theme",
};

/** Every field reports its save with an Undo, like the org Model tab. */
const ALL_UNDO = Object.fromEntries(
  Object.keys(LABELS).map((field) => [field, { undo: true }]),
) as Record<ProfileField, { undo: true }>;

/** The fields a person can clear, so the deployment's default applies again. */
const CLEARABLE: ReadonlySet<ProfileField> = new Set(["timezone", "model", "theme"]);

/**
 * The `set_preferences` patch for one field. An empty clearable field is sent
 * as `null`, the tool's clear, so the deployment's default applies again.
 */
export function profilePatch<K extends ProfileField>(
  field: K,
  value: ProfileValues[K],
): Record<string, unknown> {
  return { [field]: CLEARABLE.has(field) && value === "" ? null : value };
}

const THEME_LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * A control with the clear beside it: shown only while the person has set the
 * field, and it returns the field to the deployment's default.
 */
function Clearable({
  set,
  onClear,
  children,
}: {
  set: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      {set && (
        <button
          type="button"
          aria-label="Use default"
          title="Use default"
          onClick={onClear}
          className="mt-1 shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** What the person set, as the form's field values. An unset field is empty. */
function toValues(prefs: Record<string, unknown>, sessionName: string): ProfileValues {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const theme = prefs.theme;
  return {
    displayName: text(prefs.displayName) || sessionName,
    timezone: text(prefs.timezone),
    model: text(prefs.model),
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : "",
  };
}

/**
 * Settings → Profile. Each field saves as it changes (`useAutosaveForm`): the
 * name on blur or Enter, every other field on choice.
 */
export function ProfileTab() {
  const session = useSession();
  const user = session?.user;
  const { applyPreference, clearPreference } = useTheme();

  const [availableModels, setAvailableModels] = useState<Record<string, ModelEntry[]>>({});
  const [defaults, setDefaults] = useState<PreferenceDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const save = useCallback(async <K extends ProfileField>(field: K, value: ProfileValues[K]) => {
    const res = await callToolWithoutWorkspace("nb", "set_preferences", profilePatch(field, value));
    // A refusal (an impermissible model) comes back as a result, not a
    // throw; without this it would be reported as saved.
    if (res.isError) throw new Error(res.content?.[0]?.text ?? "The change was not saved.");
  }, []);

  const form = useAutosaveForm<ProfileValues>(
    { displayName: user?.displayName ?? "", timezone: "", model: "", theme: "" },
    { save, labels: LABELS, notices: ALL_UNDO },
  );
  const { load } = form;

  useEffect(() => {
    callToolWithoutWorkspace("nb", "get_config")
      .then((res) => {
        const config = parseToolResult<ProfileConfig>(res);
        const prefs = config.preferences ?? {};
        setAvailableModels(config.availableModels ?? {});
        // What an unset preference resolves to, so each empty field can name
        // the default that applies.
        setDefaults(config.preferenceDefaults ?? null);
        load(toValues(prefs, user?.displayName ?? ""));
      })
      .catch(() => {
        // The fields would hold fallbacks, not the person's settings; editing
        // one would save a choice made against values that were never theirs.
        setLoadError("Couldn't load your settings. Reload to try again.");
      })
      .finally(() => setLoading(false));
  }, [load, user?.displayName]);

  // The theme follows the field once the person changes it, so an Undo
  // switches it back too. The value the page loads is not applied: the shell
  // has applied the stored theme, or the default when none is stored. A
  // cleared theme drops this browser's copy, so the default applies.
  const theme = form.values.theme;
  const shownTheme: Theme = theme || defaults?.theme || "system";
  const configuredDefault = defaults?.model ?? "";
  const loadedThemeApplied = useRef(false);
  useEffect(() => {
    if (loading || loadError) return;
    if (!loadedThemeApplied.current) {
      loadedThemeApplied.current = true;
      return;
    }
    if (theme === "") clearPreference();
    else applyPreference(theme);
  }, [theme, loading, loadError, applyPreference, clearPreference]);

  return (
    <SettingsFormPage
      title="General"
      description="Identity and personal preferences. Workspace ID and shared settings live under This Workspace → General."
      loading={loading}
      loadingMessage="Loading profile..."
      loadError={loadError}
    >
      <fieldset disabled={loadError !== null} className="min-w-0 space-y-6">
        <Section flush>
          <div className="space-y-4">
            <AutosaveField
              id="displayName"
              label={LABELS.displayName}
              {...form.fieldState("displayName")}
            >
              <Input id="displayName" placeholder="Your name" {...form.inputProps("displayName")} />
            </AutosaveField>

            <div className="space-y-1.5">
              <Label>Email</Label>
              <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>
            </div>

            <div className="space-y-1.5">
              <Label>Role</Label>
              <div>
                <Badge variant="secondary">{user?.orgRole ?? "member"}</Badge>
              </div>
            </div>

            <AutosaveField id="timezone" label={LABELS.timezone} {...form.fieldState("timezone")}>
              <Clearable
                set={form.values.timezone !== ""}
                onClear={() => form.commit("timezone", "")}
              >
                <TimezoneSelect
                  id="timezone"
                  value={form.values.timezone}
                  onChange={(tz) => form.commit("timezone", tz)}
                  defaultLabel={defaults ? `Default (${defaults.timezone})` : "Default"}
                />
              </Clearable>
            </AutosaveField>
          </div>
        </Section>

        <Section
          title="Model"
          description="Applies to conversations you start from now on. A conversation you are already in keeps the model it began with."
        >
          <AutosaveField id="preferred-model" label={LABELS.model} {...form.fieldState("model")}>
            <Clearable set={form.values.model !== ""} onClear={() => form.commit("model", "")}>
              <ModelSelect
                id="preferred-model"
                value={form.values.model}
                onChange={(v) => form.commit("model", v)}
                invalid={form.fieldState("model").status === "error"}
                availableModels={availableModels}
                // Names the option as *following* the default rather than
                // picking a model. Labelled with the model alone, choosing it to
                // get that model instead clears the preference — the same
                // outcome today, and a different one the moment the default
                // moves.
                //
                // Deliberately does not say *whose* default: `resolved.models` is
                // the instance's, and a workspace that overrides the slot
                // resolves to a different model than this names.
                placeholder={
                  configuredDefault
                    ? `Follow the default (now ${configuredDefault})`
                    : "Follow the default"
                }
              />
            </Clearable>
          </AutosaveField>
        </Section>

        <Section title="Theme">
          <AutosaveField id="theme" label={LABELS.theme} {...form.fieldState("theme")}>
            <Clearable set={theme !== ""} onClear={() => form.commit("theme", "")}>
              <div className="grid grid-cols-3 gap-3">
                {THEME_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const selected = shownTheme === opt.value;
                  const isDefault = theme === "" && selected;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => form.commit("theme", opt.value)}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-sm border-2 p-4 text-center transition-all",
                        selected
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:border-muted-foreground/20 hover:bg-muted/50",
                      )}
                    >
                      <Icon
                        className={cn(
                          "w-5 h-5",
                          selected ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      <div>
                        <div className="text-sm font-medium">
                          {isDefault ? `Default (${THEME_LABEL[opt.value]})` : opt.label}
                        </div>
                        <div className="text-2xs leading-tight text-muted-foreground mt-0.5">
                          {opt.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Clearable>
          </AutosaveField>
        </Section>
      </fieldset>
    </SettingsFormPage>
  );
}
