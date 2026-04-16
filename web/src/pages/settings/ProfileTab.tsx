import { Check, Copy, Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { TimezoneSelect } from "../../components/ui/timezone-select";
import { useSession } from "../../context/SessionContext";
import { useTheme } from "../../context/ThemeContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { cn } from "../../lib/utils";

type Theme = "system" | "light" | "dark";

interface Feedback {
  type: "success" | "error";
  message: string;
}

function parseConfig(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  if (res.structuredContent) return res.structuredContent;
  if (res.content?.[0]?.text) {
    try {
      return JSON.parse(res.content[0].text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
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
        const config = parseConfig(res);
        const prefs = (config.preferences ?? {}) as Record<string, unknown>;
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

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading profile...</div>;
  }

  const { activeWorkspace } = useWorkspaceContext();

  return (
    <div className="max-w-xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Display Name */}
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          {/* Email (read-only) */}
          <div className="space-y-1.5">
            <Label>Email</Label>
            <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>
          </div>

          {/* Role (read-only) */}
          <div className="space-y-1.5">
            <Label>Role</Label>
            <div>
              <Badge variant="secondary">{user?.orgRole ?? "member"}</Badge>
            </div>
          </div>

          {/* Timezone */}
          <div className="space-y-1.5">
            <Label>Timezone</Label>
            <TimezoneSelect value={timezone} onChange={setTimezone} />
          </div>

          {/* Theme */}
          <div className="space-y-2">
            <Label>Theme</Label>
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
                    <Icon
                      className={cn("w-5 h-5", selected ? "text-warm" : "text-muted-foreground")}
                    />
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
          </div>

          {/* Feedback */}
          {feedback && (
            <p
              className={
                feedback.type === "success"
                  ? "text-sm text-green-600 dark:text-green-400"
                  : "text-sm text-destructive"
              }
            >
              {feedback.message}
            </p>
          )}

          {/* Save */}
          <Button variant="warm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </CardContent>
      </Card>

      {/* MCP Connection — workspace ID for external client configuration */}
      {activeWorkspace && <McpConnectionCard workspaceId={activeWorkspace.id} />}
    </div>
  );
}

function McpConnectionCard({ workspaceId }: { workspaceId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(workspaceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Workspace ID</Label>
            <code className="block text-sm font-mono">{workspaceId}</code>
          </div>
          <Button variant="ghost" size="sm" onClick={handleCopy} className="h-8 w-8 p-0">
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use this ID as the <code className="text-[11px]">X-Workspace-Id</code> header when
          connecting external MCP clients.
        </p>
      </CardContent>
    </Card>
  );
}
