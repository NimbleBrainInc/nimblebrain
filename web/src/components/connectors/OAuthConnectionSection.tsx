import { useState } from "react";
import { disconnectConnector, type InstalledConnector } from "../../api/client";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * Connection details for a remote OAuth connector — the *settings*
 * surface for an established connection. Renders only when the
 * connector is `running` AND remote-OAuth: anything else is either
 * the hero's responsibility (Connect / Reconnect / surface failures)
 * or simply not relevant (a connector authenticated by a static
 * header has no connection to show).
 *
 * The visible content is intentionally minimal: a one-line "Connected
 * as ..." label plus a small Disconnect link for admins. Disconnect
 * lives here, not in the hero, because it's a destructive affordance
 * — the hero carries forward-motion CTAs only.
 *
 * Disconnect asks first, and says what it leaves: the connection is shared,
 * so it goes for everyone, while the install and its tool permissions stay
 * and Uninstall is what removes them. Without that, a disconnected connector
 * reads as something to clean up rather than a connector at rest.
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
  const [confirming, setConfirming] = useState(false);

  // Render only on the happy path. needs_auth / failed / connecting
  // states are handled by the hero with the right CTA + status copy;
  // surfacing the same connection here would double-count.
  if (!installed.url) return null;
  if (installed.state !== "running") return null;

  const name = installed.catalog?.name ?? installed.connectorName ?? installed.serverName;
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
            onClick={() => setConfirming(true)}
            className="text-xs text-muted-foreground hover:text-destructive hover:underline underline-offset-4"
          >
            Disconnect
          </button>
        )}
      </div>
      {canManage && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Disconnect ${name}?`}
          description="Disconnects it for everyone in this workspace. Its tools stop working in chats and automations until someone connects it again."
          confirmLabel="Disconnect"
          pendingLabel="Disconnecting…"
          onConfirm={async () => {
            await disconnectConnector(installed.serverName, installed.scope);
            setConfirming(false);
            onChanged();
          }}
        >
          <p className="text-muted-foreground">
            {name} stays installed, with its tool permissions and settings. To remove it, use
            Uninstall.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
