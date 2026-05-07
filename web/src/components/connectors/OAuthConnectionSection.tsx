import { useState } from "react";
import { disconnectConnector, initiateMcpOAuth, type InstalledConnector } from "../../api/client";

/**
 * The live OAuth connection lifecycle for a remote URL connector.
 * Renders only when the connector has a `url` (i.e. is a remote-OAuth
 * install). Owns the Connect / Reconnect / Disconnect affordances —
 * the parent page just refreshes after a state change.
 *
 * State→affordance mapping mirrors the prompt's state table:
 *   running           → "Connected as ..." + Disconnect
 *   reauth_required   → amber notice + Reconnect
 *   crashed | dead    → red "Failed: <lastError>" + Reconnect
 *   not_authenticated → "Not connected" + Connect
 *   pending_auth | starting → "Connecting…" (no action)
 *   stopped           → "Disconnected" (no action)
 *
 * Non-admin members see the same status text but no buttons. The OAuth
 * flow itself is initiated via window.location.assign — same redirect
 * idiom the Browse install path uses.
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
  const [acting, setActing] = useState<null | "connect" | "disconnect">(null);
  const [error, setError] = useState<string | null>(null);

  if (installed.type !== "remote" || !installed.url) return null;

  const onConnect = async () => {
    setActing("connect");
    setError(null);
    try {
      const { authorizationUrl } = await initiateMcpOAuth(installed.serverName);
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(null);
    }
  };

  const onDisconnect = async () => {
    if (!confirm(`Disconnect "${installed.catalog?.name ?? installed.serverName}"?`)) return;
    setActing("disconnect");
    setError(null);
    try {
      await disconnectConnector(installed.serverName, installed.scope);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  };

  const status = renderStatus(installed);
  const action = renderAction({ installed, acting, canManage, onConnect, onDisconnect });

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        OAuth connection
      </h2>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-sm">{status}</div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

function renderStatus(installed: InstalledConnector): React.ReactNode {
  switch (installed.state) {
    case "running": {
      const label = installed.identity?.email ?? installed.identity?.name;
      return label ? (
        <span>
          Connected as <span className="font-medium">{label}</span>
        </span>
      ) : (
        <span>Connected</span>
      );
    }
    case "reauth_required":
      return (
        <span className="text-amber-600">Reconnection needed — your session has expired.</span>
      );
    case "crashed":
    case "dead":
      return (
        <span className="text-destructive">
          Failed{installed.lastError ? `: ${installed.lastError}` : ""}
        </span>
      );
    case "not_authenticated":
      return <span className="text-muted-foreground">Not connected</span>;
    case "pending_auth":
    case "starting":
      return <span className="text-muted-foreground">Connecting…</span>;
    case "stopped":
      return <span className="text-muted-foreground">Disconnected</span>;
    default:
      return <span className="text-muted-foreground">{installed.state}</span>;
  }
}

function renderAction({
  installed,
  acting,
  canManage,
  onConnect,
  onDisconnect,
}: {
  installed: InstalledConnector;
  acting: null | "connect" | "disconnect";
  canManage: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}): React.ReactNode | null {
  if (!canManage) return null;
  switch (installed.state) {
    case "running":
      return (
        <button
          type="button"
          onClick={onDisconnect}
          disabled={acting !== null}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-60"
        >
          {acting === "disconnect" ? "Disconnecting…" : "Disconnect"}
        </button>
      );
    case "reauth_required":
    case "crashed":
    case "dead":
      return (
        <button
          type="button"
          onClick={onConnect}
          disabled={acting !== null}
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {acting === "connect" ? "Reconnecting…" : "Reconnect"}
        </button>
      );
    case "not_authenticated":
      return (
        <button
          type="button"
          onClick={onConnect}
          disabled={acting !== null}
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {acting === "connect" ? "Connecting…" : "Connect"}
        </button>
      );
    default:
      // pending_auth / starting / stopped — no actionable affordance from here.
      return null;
  }
}
