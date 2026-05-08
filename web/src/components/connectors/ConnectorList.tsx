import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getAuthToken, getInstalledConnectors, type InstalledConnector } from "../../api/client";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useEvents } from "../../hooks/useEvents";
import { EmptyState } from "../../pages/settings/components";

/**
 * Lists installed connectors for a single scope (Personal or
 * Workspace). The list is intentionally minimal — icon, name, status
 * dot when something needs attention, and a chevron link to Configure.
 * Type / interactive / version metadata is deferred to the Configure
 * page so the list stays scannable.
 *
 * Browsing for new connectors lives on a separate /browse page reached
 * via the action in the page header — the list itself only shows
 * what's already installed.
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
    // searching or not. localeCompare with `sensitivity: "base"` does
    // the right thing for accented characters (É sorts with E) and
    // ignores case ("github" / "GitHub" don't fight each other).
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
 * status nudges only render when there's something the user should
 * notice (reauth needed, crashed). A clean row stays clean.
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
  const status = readableStatus(installed.state);
  const showStatusText = status.show;

  return (
    <Link
      to={`${configureBasePath}/${installed.serverName}`}
      className="flex items-center gap-3 px-2 py-2.5 -mx-2 rounded hover:bg-muted/50 transition-colors border-b border-border"
    >
      <ConnectorIcon iconUrl={iconUrl} name={name} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{name}</div>
      </div>
      {showStatusText && <span className={`text-xs ${status.color}`}>{status.label}</span>}
      <span className="text-muted-foreground" aria-hidden>
        ›
      </span>
    </Link>
  );
}

/**
 * Compact icon — uses the catalog's iconUrl when available, falls
 * back to a colored initial for local bundles or anything without an
 * icon. Square, ~28px, rounded — same visual weight regardless of
 * source so the list reads uniformly.
 */
function ConnectorIcon({ iconUrl, name }: { iconUrl: string | undefined; name: string }) {
  const [broken, setBroken] = useState(false);
  if (iconUrl && !broken) {
    return (
      <img
        src={iconUrl}
        alt=""
        onError={() => setBroken(true)}
        className="h-7 w-7 rounded shrink-0"
      />
    );
  }
  // Stable hash → palette index so the same bundle always gets the
  // same color. Keeps the list visually tidy when the user scans.
  const palette = [
    "bg-blue-200 text-blue-900",
    "bg-green-200 text-green-900",
    "bg-amber-200 text-amber-900",
    "bg-purple-200 text-purple-900",
    "bg-pink-200 text-pink-900",
    "bg-teal-200 text-teal-900",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const color = palette[Math.abs(hash) % palette.length] ?? palette[0];
  const initial = name.charAt(0).toUpperCase() || "•";
  return (
    <div
      className={`h-7 w-7 rounded shrink-0 flex items-center justify-center text-xs font-semibold ${color}`}
      aria-hidden
    >
      {initial}
    </div>
  );
}

/**
 * Map raw connection states to a user-readable status. `show: false`
 * means the row should render no status text at all — healthy rows
 * stay quiet. Only states the user should act on (reauth, crashed,
 * not connected, connecting) surface.
 */
function readableStatus(state: string): {
  show: boolean;
  label: string;
  color: string;
} {
  switch (state) {
    case "running":
      return { show: false, label: "Connected", color: "" };
    case "pending_auth":
    case "starting":
      return { show: true, label: "Connecting…", color: "text-muted-foreground" };
    case "reauth_required":
      return { show: true, label: "Reconnect needed", color: "text-amber-600" };
    case "crashed":
    case "dead":
      return { show: true, label: "Failed", color: "text-destructive" };
    case "stopped":
      return { show: true, label: "Stopped", color: "text-muted-foreground" };
    case "not_authenticated":
      return { show: true, label: "Not connected", color: "text-muted-foreground" };
    default:
      return { show: false, label: state, color: "" };
  }
}
