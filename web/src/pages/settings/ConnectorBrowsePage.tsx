import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ConnectorCatalogEntry,
  getConnectorsCatalog,
  initiateMcpOAuth,
  installConnector,
} from "../../api/client";

/**
 * Connector directory — browse what's available to install.
 *
 * v1: shows the curated catalog (DCR-ready remote OAuth services like
 * Granola, Notion, HubSpot, etc.) filtered by scope. Future sources
 * planned but not yet wired:
 *
 *   - mpak.dev — open registry of MCP bundles (search, download)
 *   - Per-org bundle directories — operators ship their own catalog
 *   - Custom URL — paste a remote MCP server URL
 *
 * Each catalog entry has an Install action. For DCR connectors,
 * Install does the install + OAuth round-trip in one click. For
 * static-auth (HubSpot, Gmail, Outlook, Zoom), operator setup is
 * required first — surfaced inline.
 */
export function ConnectorBrowsePage({ scope }: { scope: "user" | "workspace" }) {
  const [catalog, setCatalog] = useState<ConnectorCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const backPath =
    scope === "user" ? "/settings/personal/connectors" : "/settings/workspace/connectors";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await getConnectorsCatalog();
        if (!cancelled) setCatalog(res.catalog);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = catalog
    .filter((e) => e.defaultScope === scope)
    .filter((e) => {
      if (!query.trim()) return true;
      const q = query.trim().toLowerCase();
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });

  const onInstall = async (entry: ConnectorCatalogEntry) => {
    setBusyId(entry.id);
    setError(null);
    try {
      const res = await installConnector(entry.id);
      const { authorizationUrl } = await initiateMcpOAuth(res.serverName);
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 md:py-8 flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← Installed connectors
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">Browse connectors</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {scope === "user"
            ? "Personal services to connect to your account."
            : "Tools and services to add to this workspace."}
        </p>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the directory…"
        className="w-full text-sm px-3 py-2 rounded border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? `No results for "${query}".` : "No connectors available in this scope."}
        </p>
      ) : (
        <div className="border-t border-border">
          {filtered.map((entry) => (
            <DirectoryRow
              key={entry.id}
              entry={entry}
              busy={busyId === entry.id}
              onInstall={() => onInstall(entry)}
            />
          ))}
        </div>
      )}

      <FutureSourcesNote />
    </div>
  );
}

function DirectoryRow({
  entry,
  busy,
  onInstall,
}: {
  entry: ConnectorCatalogEntry;
  busy: boolean;
  onInstall: () => void;
}) {
  const requiresOperatorSetup = entry.auth === "static";
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border">
      {entry.iconUrl ? (
        <img src={entry.iconUrl} alt="" className="h-7 w-7 rounded shrink-0" />
      ) : (
        <div className="h-7 w-7 rounded bg-muted shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{entry.name}</div>
        <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
      </div>
      {requiresOperatorSetup ? (
        <div className="flex flex-col items-end text-right">
          <span className="text-xs text-amber-600">Operator setup required</span>
          {entry.operatorSetup?.portalUrl && (
            <a
              href={entry.operatorSetup.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted-foreground underline"
            >
              {new URL(entry.operatorSetup.portalUrl).hostname}
            </a>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 shrink-0"
        >
          {busy ? "Installing…" : "Install"}
        </button>
      )}
    </div>
  );
}

/**
 * Placeholder for the directory sources we plan to wire up: mpak,
 * per-org bundle directories, and a "paste a URL" path. Visible so
 * users (and us) know the curated catalog isn't the only future
 * surface.
 */
function FutureSourcesNote() {
  return (
    <div className="mt-4 pt-4 border-t border-border">
      <p className="text-xs text-muted-foreground">
        More sources coming soon:{" "}
        <a
          href="https://mpak.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-4 hover:underline"
        >
          mpak.dev registry
        </a>
        , per-organization directories, and custom URLs for any remote MCP server.
      </p>
    </div>
  );
}
