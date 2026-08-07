import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { TimezoneSelect } from "../../components/ui/timezone-select";
import { useSession } from "../../context/SessionContext";
import { useTheme } from "../../context/ThemeContext";
import { cn } from "../../lib/utils";
import { type ModelEntry, ModelSelect, Section, SettingsFormPage } from "./components";

type Theme = "system" | "light" | "dark";

interface Feedback {
  type: "success" | "error";
  message: string;
}

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

export function ProfileTab() {
  const session = useSession();
  const user = session?.user;
  const { applyPreference } = useTheme();

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [timezone, setTimezone] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [model, setModel] = useState("");
  const [availableModels, setAvailableModels] = useState<Record<string, ModelEntry[]>>({});
  const [configuredDefault, setConfiguredDefault] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const applyConfig = useCallback((config: ProfileConfig) => {
    const prefs = config.preferences ?? {};
    setAvailableModels(config.availableModels ?? {});
    // The configured default is what an unset preference resolves to, so it is
    // what the empty option has to name.
    setConfiguredDefault(config.resolved?.models?.default ?? "");
    if (typeof prefs.model === "string") setModel(prefs.model);
    if (typeof prefs.timezone === "string") setTimezone(prefs.timezone);
    if (prefs.theme === "light" || prefs.theme === "dark" || prefs.theme === "system") {
      setTheme(prefs.theme);
    }
    if (typeof prefs.displayName === "string" && prefs.displayName) {
      setDisplayName(prefs.displayName);
    }
  }, []);

  useEffect(() => {
    callTool("nb", "get_config")
      .then((res) => applyConfig(parseToolResult<ProfileConfig>(res)))
      .catch(() => {
        // Saving now would post the empty defaults this form fell back to, and
        // the server reads an empty model as a clear — so a failed read would
        // quietly wipe settings the person never touched.
        setLoadFailed(true);
        setFeedback({
          type: "error",
          message: "Couldn't load your settings. Reload to try again.",
        });
      })
      .finally(() => setLoading(false));
  }, [applyConfig]);

  const handleThemeChange = useCallback(
    (value: Theme) => {
      setTheme(value);
      applyPreference(value);
    },
    [applyPreference],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setFeedback(null);
    try {
      // Empty clears the choice — `set_preferences` reads it as "follow the
      // configured default", which is what the empty option offers.
      const res = await callTool("nb", "set_preferences", {
        displayName,
        timezone,
        theme,
        model,
      });
      // `callTool` resolves on an MCP tool error — only the HTTP call throws.
      // `set_preferences` refuses an impermissible model before writing
      // anything, so without this the whole save is dropped under a success
      // message.
      if (res.isError) throw new Error(res.content?.[0]?.text ?? "Failed to save preferences.");
      setFeedback({ type: "success", message: "Preferences saved." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save preferences.";
      setFeedback({ type: "error", message: msg });
    } finally {
      setSaving(false);
    }
  }, [displayName, timezone, theme, model]);

  return (
    <SettingsFormPage
      title="Profile"
      description="Identity and personal preferences. Workspace ID and shared settings live under This Workspace → General."
      loading={loading}
      loadingMessage="Loading profile..."
      feedback={feedback}
      save={{
        onSave: handleSave,
        saving,
        // Profile doesn't track dirty: a user reading their own settings
        // expects Save to be available without first re-typing a value.
        disabled: saving || loadFailed,
      }}
    >
      <Section flush>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />
          </div>

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

          <div className="space-y-1.5">
            <Label>Timezone</Label>
            <TimezoneSelect value={timezone} onChange={setTimezone} />
          </div>
        </div>
      </Section>

      <Section
        title="Model"
        description="Applies to conversations you start from now on. A conversation you are already in keeps the model it began with."
      >
        <ModelSelect
          id="preferred-model"
          label="Your model"
          value={model}
          onChange={setModel}
          availableModels={availableModels}
          // Names the option as *following* the default rather than picking a
          // model. Labelled with the model alone, choosing it to get that model
          // instead clears the preference — the same outcome today, and a
          // different one the moment an admin moves the default.
          placeholder={
            configuredDefault
              ? `Follow the organization default (now ${configuredDefault})`
              : "Follow the organization default"
          }
        />
      </Section>

      <Section title="Theme">
        <div className="grid grid-cols-3 gap-3">
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = theme === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleThemeChange(opt.value)}
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
      </Section>
    </SettingsFormPage>
  );
}
