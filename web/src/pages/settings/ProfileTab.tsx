import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  preferences?: Record<string, unknown>;
  availableModels?: Record<string, ModelEntry[]>;
  /**
   * Effective values after defaults. The label here says what "use the default"
   * resolves to, which is the operator's default whether or not they set one —
   * so it reads `resolved`, not the operator-set group.
   */
  resolved?: { models?: { default?: string } };
}

interface ProfileValues {
  displayName: string;
  timezone: string;
  /** `""` follows the configured default. */
  model: string;
  theme: Theme;
}

type ProfileField = keyof ProfileValues;

const LABELS: Record<ProfileField, string> = {
  displayName: "Display Name",
  timezone: "Timezone",
  model: "Your model",
  theme: "Theme",
};

/** Every field reports its save with an Undo, like the org Model tab. */
const ALL_UNDO = Object.fromEntries(
  Object.keys(LABELS).map((field) => [field, { undo: true }]),
) as Record<ProfileField, { undo: true }>;

/**
 * The `set_preferences` patch for one field. An empty model is sent as `null`,
 * which clears the choice so the person follows the configured default.
 */
function profilePatch<K extends ProfileField>(
  field: K,
  value: ProfileValues[K],
): Record<string, unknown> {
  return field === "model" ? { model: value || null } : { [field]: value };
}

/** What the person set, as the form's field values. An unset field is empty. */
function toValues(prefs: Record<string, unknown>, sessionName: string): ProfileValues {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const theme = prefs.theme;
  return {
    displayName: text(prefs.displayName) || sessionName,
    timezone: text(prefs.timezone),
    model: text(prefs.model),
    theme: theme === "light" || theme === "dark" ? theme : "system",
  };
}

/**
 * Settings → Profile. Each field saves as it changes (`useAutosaveForm`): the
 * name on blur or Enter, every other field on choice.
 */
export function ProfileTab() {
  const session = useSession();
  const user = session?.user;
  const { applyPreference } = useTheme();

  const [availableModels, setAvailableModels] = useState<Record<string, ModelEntry[]>>({});
  const [configuredDefault, setConfiguredDefault] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const save = useCallback(async <K extends ProfileField>(field: K, value: ProfileValues[K]) => {
    const res = await callToolWithoutWorkspace("nb", "set_preferences", profilePatch(field, value));
    // A refusal (an impermissible model) comes back as a result, not a
    // throw; without this it would be reported as saved.
    if (res.isError) throw new Error(res.content?.[0]?.text ?? "The change was not saved.");
  }, []);

  const form = useAutosaveForm<ProfileValues>(
    { displayName: user?.displayName ?? "", timezone: "", model: "", theme: "system" },
    { save, labels: LABELS, notices: ALL_UNDO },
  );
  const { load } = form;

  useEffect(() => {
    callToolWithoutWorkspace("nb", "get_config")
      .then((res) => {
        const config = parseToolResult<ProfileConfig>(res);
        const prefs = config.preferences ?? {};
        setAvailableModels(config.availableModels ?? {});
        // The configured default is what an unset preference resolves to, so
        // it is what the empty option has to name.
        setConfiguredDefault(config.resolved?.models?.default ?? "");
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
  // switches it back too. The value the page loads is not applied: with no
  // theme stored it is the fallback "system", which would replace the theme
  // this browser holds, and with one stored the shell has applied it already.
  const theme = form.values.theme;
  const loadedThemeApplied = useRef(false);
  useEffect(() => {
    if (loading || loadError) return;
    if (!loadedThemeApplied.current) {
      loadedThemeApplied.current = true;
      return;
    }
    applyPreference(theme);
  }, [theme, loading, loadError, applyPreference]);

  return (
    <SettingsFormPage
      title="Profile"
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
              <TimezoneSelect
                value={form.values.timezone}
                onChange={(tz) => form.commit("timezone", tz)}
              />
            </AutosaveField>
          </div>
        </Section>

        <Section
          title="Model"
          description="Applies to conversations you start from now on. A conversation you are already in keeps the model it began with."
        >
          <AutosaveField id="preferred-model" label={LABELS.model} {...form.fieldState("model")}>
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
          </AutosaveField>
        </Section>

        <Section title="Theme">
          <AutosaveField id="theme" label={LABELS.theme} {...form.fieldState("theme")}>
            <div className="grid grid-cols-3 gap-3">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = theme === opt.value;
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
                      className={cn("w-5 h-5", selected ? "text-primary" : "text-muted-foreground")}
                    />
                    <div>
                      <div className="text-sm font-medium">{opt.label}</div>
                      <div className="text-2xs leading-tight text-muted-foreground mt-0.5">
                        {opt.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </AutosaveField>
        </Section>
      </fieldset>
    </SettingsFormPage>
  );
}
