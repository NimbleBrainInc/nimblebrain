import { useEffect, useState } from "react";
import {
  listRegistries,
  type RegistryConfig,
  setRegistryEnabled,
  setRegistryUrl,
} from "../../api/client";
import { SettingsPageHeader } from "./components";

/**
 * Admin surface for connector registries — the sources Browse pulls
 * from. Locked registries (curated) render a disabled toggle so it's
 * obvious they're permanent. Other registries can be enabled / disabled
 * and, when applicable, have their URL overridden (e.g., point mpak
 * at a private mpak instance).
 */
export function OrgRegistriesTab() {
  const [registries, setRegistries] = useState<RegistryConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const res = await listRegistries();
      setRegistries(res.registries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onToggle = async (id: string, next: boolean) => {
    setError(null);
    // Optimistic update
    setRegistries((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: next } : r)));
    try {
      await setRegistryEnabled(id, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Reload truth from server on failure
      refresh();
    }
  };

  const onUrlSubmit = async (id: string, url: string) => {
    setError(null);
    try {
      await setRegistryUrl(id, url);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Registries"
        description="Sources the Browse page pulls connectors from. Curated services are always available; mpak.dev and future registries can be enabled, disabled, or pointed elsewhere."
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="border-t border-border">
          {registries.map((r) => (
            <RegistryRow
              key={r.id}
              registry={r}
              onToggle={(next) => onToggle(r.id, next)}
              onUrlSubmit={(url) => onUrlSubmit(r.id, url)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RegistryRow({
  registry,
  onToggle,
  onUrlSubmit,
}: {
  registry: RegistryConfig;
  onToggle: (next: boolean) => void;
  onUrlSubmit: (url: string) => void;
}) {
  const [editingUrl, setEditingUrl] = useState(false);
  const [draftUrl, setDraftUrl] = useState(registry.url ?? "");
  const supportsUrl = registry.type === "mpak";

  const submit = () => {
    if (draftUrl.trim() && draftUrl !== registry.url) {
      onUrlSubmit(draftUrl.trim());
    }
    setEditingUrl(false);
  };

  return (
    <div className="flex items-start gap-4 py-4 border-b border-border">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{registry.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {registry.type}
          </span>
          {registry.locked && <span className="text-[10px] text-muted-foreground">locked</span>}
        </div>
        {supportsUrl && (
          <div className="mt-1 text-xs text-muted-foreground">
            {editingUrl ? (
              <span className="flex items-center gap-2">
                <input
                  type="url"
                  value={draftUrl}
                  onChange={(e) => setDraftUrl(e.target.value)}
                  onBlur={submit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                    if (e.key === "Escape") {
                      setDraftUrl(registry.url ?? "");
                      setEditingUrl(false);
                    }
                  }}
                  className="font-mono text-xs px-2 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraftUrl(registry.url ?? "");
                  setEditingUrl(true);
                }}
                className="font-mono text-xs hover:underline underline-offset-4"
              >
                {registry.url ?? "(no URL set — click to add)"}
              </button>
            )}
          </div>
        )}
      </div>
      <Toggle
        checked={registry.enabled}
        onChange={onToggle}
        disabled={registry.locked}
        label={registry.enabled ? "Enabled" : "Disabled"}
      />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
