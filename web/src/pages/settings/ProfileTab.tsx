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
import { Section, SettingsFormPage } from "./components";

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

export function ProfileTab() {
  const session = useSession();
  const user = session?.user;
  const { applyPreference } = useTheme();

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [timezone, setTimezone] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    callTool("nb", "get_config")
      .then((res) => {
        const config = parseToolResult<{ preferences?: Record<string, unknown> }>(res);
        const prefs = config.preferences ?? {};
        if (typeof prefs.timezone === "string") setTimezone(prefs.timezone);
        if (prefs.theme === "light" || prefs.theme === "dark" || prefs.theme === "system") {
          setTheme(prefs.theme);
        }
        if (typeof prefs.displayName === "string" && prefs.displayName) {
          setDisplayName(prefs.displayName);
        }
      })
      .catch(() => {
        // Keep defaults from session
      })
      .finally(() => setLoading(false));
  }, []);

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
      await callTool("nb", "set_preferences", { displayName, timezone, theme });
      setFeedback({ type: "success", message: "Preferences saved." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save preferences.";
      setFeedback({ type: "error", message: msg });
    } finally {
      setSaving(false);
    }
  }, [displayName, timezone, theme]);

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
        disabled: saving,
        variant: "warm",
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
                  "flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-center transition-all",
                  selected
                    ? "border-warm bg-warm/5 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-muted-foreground/30 hover:bg-muted/50",
                )}
              >
                <Icon className={cn("w-5 h-5", selected ? "text-warm" : "text-muted-foreground")} />
                <div>
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-[11px] leading-tight text-muted-foreground mt-0.5">
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
