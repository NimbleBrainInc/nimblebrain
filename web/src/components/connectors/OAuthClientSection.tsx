import { useMemo, useState } from "react";
import type { InstalledConnector } from "../../api/client";
import { Button } from "../ui/button";
import { OAuthClientSetupModal, type OAuthClientSetupTarget } from "./OAuthClientSetupModal";

/**
 * Admin-supplied OAuth client config for a static-auth connector
 * (Asana, HubSpot, Gmail, etc.). Renders only when:
 *   - The installed connector matches a catalog entry, AND
 *   - That catalog entry uses static auth, AND
 *   - The workspace has already configured the OAuth client (workspaceOAuthClient populated).
 *
 * For first-time setup the affordance lives on Browse; once installed,
 * rotation lives here. The Edit button reuses `OAuthClientSetupModal` with
 * the existing clientId pre-filled — same submit path as Browse, just
 * a different mount point.
 */
export function OAuthClientSection({
  installed,
  canManage,
  onChanged,
}: {
  installed: InstalledConnector;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const cat = installed.catalog;
  const op = installed.workspaceOAuthClient;

  // What the setup modal needs of this connector — the catalog carries all three.
  const oauthClientTarget = useMemo<OAuthClientSetupTarget | null>(() => {
    if (cat?.auth !== "static" || !cat.oauthClientSetup) return null;
    return { id: cat.id, name: cat.name, oauthClientSetup: cat.oauthClientSetup };
  }, [cat]);

  if (cat?.auth !== "static" || !op || !oauthClientTarget) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        OAuth client
      </h2>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>
            Configured {formatRelativeTime(op.configuredAt)}
            {op.configuredByLabel ? (
              <>
                {" "}
                by <span className="text-foreground font-medium">{op.configuredByLabel}</span>
              </>
            ) : null}
          </div>
          <div>
            Client ID:{" "}
            <span className="font-mono text-foreground">{truncateClientId(op.clientId)}</span>
          </div>
        </div>
        {canManage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setEditing(true)}
          >
            Edit OAuth client
          </Button>
        )}
      </div>
      {editing && (
        <OAuthClientSetupModal
          entry={oauthClientTarget}
          initialClientId={op.clientId}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/**
 * Render an ISO timestamp as "5 minutes ago", "2 days ago", etc. Falls
 * back to a date string if the timestamp is unparseable. Format is
 * minimal on purpose — the audit line is reference info, not the
 * primary content.
 */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "at an unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  // Past 30 days — switch to a date so the gap is concrete.
  return new Date(ts).toLocaleDateString();
}

/**
 * Show the first and last few characters of a clientId so the user can
 * confirm it's the right one without staring at a wall of mono. Most
 * vendor clientIds are >25 chars; under that we render in full.
 */
function truncateClientId(clientId: string): string {
  if (clientId.length <= 16) return clientId;
  return `${clientId.slice(0, 6)}…${clientId.slice(-6)}`;
}
