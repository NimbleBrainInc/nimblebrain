import { useEffect, useState } from "react";
import { listRegistries, type RegistryConfig, setRegistryEnabled } from "../../api/client";
import { SettingsPageHeader } from "./components";

/**
 * Admin surface for connector registries — the sources Browse pulls
 * from. Locked registries (curated) render a disabled toggle so it's
 * obvious they're permanent. Other registries can be enabled or
 * disabled here. Registry URLs (e.g., pointing mpak at a self-hosted
 * instance) are deployment configuration — set via the `NB_REGISTRIES`
 * env var or `registries.json` — not a runtime UI knob.
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

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Registries"
        description="Sources the Browse page pulls connectors from. Curated services are always available; mpak.dev and future registries can be enabled or disabled here. URL overrides (e.g., a self-hosted mpak) are deployment config — set via NB_REGISTRIES."
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="border-t border-border">
          {registries.map((r) => (
            <RegistryRow key={r.id} registry={r} onToggle={(next) => onToggle(r.id, next)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RegistryRow({
  registry,
  onToggle,
}: {
  registry: RegistryConfig;
  onToggle: (next: boolean) => void;
}) {
  const supportsUrl = registry.type === "mpak";

  return (
    <div className="flex items-start gap-4 py-4 border-b border-border">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{registry.name}</span>
          <span className="text-3xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {registry.type}
          </span>
          {registry.locked && <span className="text-3xs text-muted-foreground">locked</span>}
        </div>
        {supportsUrl && (
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {registry.url ?? "(using default)"}
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
    // The off-state track and thumb must both stay visible on the off-white
    // canvas: bg-input gives the track a form-control gray with real contrast in
    // both themes, and shadow-sm lifts the thumb off whichever track it sits on.
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-primary" : "bg-input"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-background shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
