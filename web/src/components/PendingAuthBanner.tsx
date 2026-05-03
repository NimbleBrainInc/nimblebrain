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

  // `fixed` + high z-index so the banner sits above the chat panel
  // (which is `fixed top-0 right-0 z-10` in AppWithChat). When the
  // chat slides in, the right portion of the banner — including the
  // Connect button — would otherwise be hidden under it. The
  // ShellLayout below us pads its main content via the spacer that
  // App.tsx renders alongside this component.
  return (
    <div className="fixed inset-x-0 top-0 z-50 border-b border-amber-300/60 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/40">
      <div className="px-4 py-2 space-y-1">
        {entries.map((evt) => (
          <PendingRow key={`${evt.serverName}|${evt.principalId}`} evt={evt} />
        ))}
      </div>
    </div>
  );
}

/**
 * Spacer to push the main shell down by the banner's height when one
 * or more banner rows are present. Sized to match a single-row banner
 * (~40px); for multi-row stacks Step 3 will need to measure dynamically.
 */
export function PendingAuthBannerSpacer({ pending }: Props) {
  if (pending.size === 0) return null;
  // 40px = py-2 (16px vertical) + ~24px content + 1px border. Matches a
  // single row; multi-row banners will under-pad until we measure.
  return <div className="h-10 shrink-0" aria-hidden />;
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
