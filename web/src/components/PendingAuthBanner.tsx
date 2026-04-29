import { useState } from "react";
import { initiateMcpOAuth } from "../api/client";
import type { ConnectionStateChangedEvent } from "../types";

interface Props {
  /**
   * Connections currently in `pending_auth`, keyed by
   * `${serverName}|${principalId}`. Lifted from a workspace-level
   * `useState` driven by `connection.state_changed` SSE events.
   */
  pending: Map<string, ConnectionStateChangedEvent>;
}

/**
 * Workspace-shell banner shown when one or more URL bundles need
 * interactive OAuth. One row per (serverName, principalId) pair that is
 * currently in `pending_auth`. Clicking Connect calls
 * `POST /v1/mcp-auth/initiate` (which sets the session-bound state
 * cookie scoped to the callback path) and then navigates the browser
 * to the returned `authorizationUrl`.
 *
 * On return from the OAuth callback, the bundle's Connection
 * transitions to `running` and a fresh `connection.state_changed` event
 * removes the row from the map — banner clears itself with no
 * additional client-side bookkeeping.
 */
export function PendingAuthBanner({ pending }: Props) {
  const entries = [...pending.values()];
  if (entries.length === 0) return null;

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/40">
      <div className="px-4 py-2 space-y-1">
        {entries.map((evt) => (
          <PendingRow key={`${evt.serverName}|${evt.principalId}`} evt={evt} />
        ))}
      </div>
    </div>
  );
}

function PendingRow({ evt }: { evt: ConnectionStateChangedEvent }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { authorizationUrl } = await initiateMcpOAuth(evt.serverName, evt.principalId);
      // Whole-page navigation; the AS will redirect back to /v1/mcp-auth/callback
      // when the user completes auth, at which point the cookie set by the
      // POST is verified and the bundle transitions to running.
      window.location.assign(authorizationUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 text-sm text-amber-900 dark:text-amber-100">
      <span aria-hidden className="text-amber-600 dark:text-amber-400">
        ⚠
      </span>
      <span className="flex-1">
        <strong className="font-semibold">{evt.serverName}</strong> needs you to sign in.
        {err ? <span className="ml-2 text-red-700 dark:text-red-400">— {err}</span> : null}
      </span>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded border border-amber-400 bg-white px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/70"
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}
