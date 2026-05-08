import { useState } from "react";
import { disconnectConnector, type InstalledConnector } from "../../api/client";

/**
 * Connection details for a remote OAuth connector — the *settings*
 * surface for an established connection. Renders only when the
 * connector is `running` AND remote-OAuth: anything else is either
 * the hero's responsibility (Connect / Reconnect / surface failures)
 * or simply not relevant (stdio bundles never connect).
 *
 * The visible content is intentionally minimal: a one-line "Connected
 * as ..." label plus a small Disconnect link for admins. Disconnect
 * lives here, not in the hero, because it's a destructive affordance
 * — the hero carries forward-motion CTAs only.
 */
export function OAuthConnectionSection({
  installed,
  canManage,
  onChanged,
}: {
  installed: InstalledConnector;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Render only on the happy path. needs_auth / failed / connecting
  // states are handled by the hero with the right CTA + status copy;
  // surfacing the same connection here would double-count.
  if (installed.type !== "remote" || !installed.url) return null;
  if (installed.state !== "running") return null;

  const onDisconnect = async () => {
    if (!confirm(`Disconnect "${installed.catalog?.name ?? installed.serverName}"?`)) return;
    setActing(true);
    setError(null);
    try {
      await disconnectConnector(installed.serverName, installed.scope);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const label = installed.identity?.email ?? installed.identity?.name;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-muted-foreground">
          {label ? (
            <>
              Connected as <span className="text-foreground font-medium">{label}</span>
            </>
          ) : (
            "Connected"
          )}
        </div>
        {canManage && (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={acting}
            className="text-xs text-muted-foreground hover:text-destructive hover:underline underline-offset-4 disabled:opacity-60"
          >
            {acting ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
