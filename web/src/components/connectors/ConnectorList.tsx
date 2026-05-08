import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getAuthToken, getInstalledConnectors, type InstalledConnector } from "../../api/client";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useEvents } from "../../hooks/useEvents";
import { EmptyState } from "../../pages/settings/components";
import { ConnectorIcon } from "./ConnectorIcon";

/**
 * Lists installed connectors for a single scope (Personal or
 * Workspace). The list is intentionally minimal — icon, name, status
 * + action verb when something needs attention, chevron link to
 * Configure. Type / interactive / version metadata is deferred to
 * the Configure page so the list stays scannable.
 *
 * Browsing for new connectors lives on a separate /browse page
 * reached via the action in the page header — the list itself only
 * shows what's already installed.
 */
export function ConnectorList({
  scope,
  configureBasePath,
}: {
  scope: "user" | "workspace";
  configureBasePath: string;
}) {
  const [installed, setInstalled] = useState<InstalledConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const wsCtx = useWorkspaceContext();

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const ins = await getInstalledConnectors({ scope });
        setInstalled(ins.installed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // SSE-driven refresh: after the OAuth round-trip the user is
  // redirected back here while the backend code-exchange + tools/list
  // is still settling. Without a state-changed listener the row sticks
  // at "Connecting…" until reload.
  const token = getAuthToken() ?? "";
  useEvents(token, wsCtx.activeWorkspace?.id, {
    onConnectionStateChanged: () => {
      refresh({ silent: true });
    },
  });

  const filtered = useMemo(() => {
    // Sort alphabetically by display name first, then filter — keeps
    // the rendered order stable regardless of whether the user is
    // searching. localeCompare with `sensitivity: "base"` does the
    // right thing for accented chars (É sorts with E) and ignores
    // case ("github" / "GitHub" don't fight each other).
    const displayName = (c: InstalledConnector): string => c.catalog?.name ?? c.serverName;
    const sorted = [...installed].sort((a, b) =>
      displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }),
    );
    if (!query.trim()) return sorted;
    const q = query.trim().toLowerCase();
    return sorted.filter((c) => {
      const name = displayName(c).toLowerCase();
      return name.includes(q) || c.bundleName.toLowerCase().includes(q);
    });
  }, [installed, query]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return <EmptyState message={`Unable to load connectors: ${error}. Reload to retry.`} />;
  }
  if (installed.length === 0) {
    return <EmptyState message="No connectors installed yet. Browse the directory to add one." />;
  }

  // Show the search input only when there are enough rows for it to
  // pull weight. Below that, the visual cost outweighs the benefit.
  const showSearch = installed.length > 5;

  return (
    <div className="flex flex-col gap-3">
      {showSearch && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connectors…"
          className="w-full max-w-xs text-sm px-3 py-1.5 rounded border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      )}

      <div className="border-t border-border">
        {filtered.map((ins) => (
          <ConnectorRow
            key={`${ins.scope}:${ins.serverName}`}
            installed={ins}
            configureBasePath={configureBasePath}
          />
        ))}
        {filtered.length === 0 && query && (
          <p className="text-xs text-muted-foreground py-3">No connectors match "{query}".</p>
        )}
      </div>
    </div>
  );
}

/**
 * One installed connector. The whole row is a link to Configure;
 * status + action verb only render when there's something the user
 * should notice. A clean (ready) row shows just name + chevron — the
 * chevron is the affordance, no extra noise.
 */
function ConnectorRow({
  installed,
  configureBasePath,
}: {
  installed: InstalledConnector;
  configureBasePath: string;
}) {
  const name = installed.catalog?.name ?? installed.serverName;
  const iconUrl = installed.catalog?.iconUrl;
  const summary = listSummary(installed);

  return (
    <Link
      to={`${configureBasePath}/${installed.serverName}`}
      className="flex items-center gap-3 px-2 py-2.5 -mx-2 rounded hover:bg-muted/50 transition-colors border-b border-border"
    >
      <ConnectorIcon name={name} iconUrl={iconUrl} className="h-7 w-7 rounded text-xs" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{name}</div>
      </div>
      {summary && (
        <span className={`flex items-center gap-1.5 text-xs ${summary.tone}`}>
          {summary.dot && <span className={`h-1.5 w-1.5 rounded-full ${summary.dotColor}`} />}
          <span>{summary.label}</span>
        </span>
      )}
      <span className="text-muted-foreground" aria-hidden>
        ›
      </span>
    </Link>
  );
}

/**
 * Per-row summary derived from the connector's status. Only renders
 * something for non-ready states — clean rows stay clean (just name
 * + chevron). Action verbs lead the user to the right next step:
 *
 *   needs_setup + missingOperatorSetup → "Set up"
 *   needs_setup + unpopulated user_config → "Configure"
 *   needs_auth + state=not_authenticated → "Connect"
 *   needs_auth + state=reauth_required → "Reconnect"
 *   failed → "Failed" (no verb — admin investigates on the detail page)
 *   connecting / starting → "Connecting…" (no verb, no chevron action)
 *
 * Returns `null` for the ready state so the row renders without
 * any status block — that's the visual signal "this one's fine,
 * nothing to do."
 */
function listSummary(installed: InstalledConnector): {
  label: string;
  tone: string;
  dot: boolean;
  dotColor: string;
} | null {
  switch (installed.status) {
    case "ready":
      return null;
    case "needs_setup": {
      const verb = installed.missingOperatorSetup ? "Set up" : "Configure";
      return { label: verb, tone: "text-amber-600", dot: true, dotColor: "bg-amber-500" };
    }
    case "needs_auth": {
      const verb = installed.state === "reauth_required" ? "Reconnect" : "Connect";
      return { label: verb, tone: "text-amber-600", dot: true, dotColor: "bg-amber-500" };
    }
    case "connecting":
    case "starting":
      return {
        label: "Connecting…",
        tone: "text-muted-foreground",
        dot: true,
        dotColor: "bg-blue-500 animate-pulse",
      };
    case "failed":
      return { label: "Failed", tone: "text-destructive", dot: true, dotColor: "bg-rose-500" };
  }
}
