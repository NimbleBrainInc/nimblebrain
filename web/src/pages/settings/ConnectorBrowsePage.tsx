import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type DirectoryEntry,
  getInstalledConnectors,
  initiateComposioOAuth,
  initiateMcpOAuth,
  type InstalledConnector,
  listDirectory,
} from "../../api/client";
import { ConnectorIcon } from "../../components/connectors/ConnectorIcon";
import { InstallConnectorDialog } from "../../components/connectors/InstallConnectorDialog";
import { OperatorSetupModal } from "../../components/connectors/OperatorSetupModal";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";

/**
 * Connector directory — what's available to install. The Browse page
 * is intentionally focused on *discovery*: already-installed
 * connectors are filtered out (they live on the Connectors list →
 * Configure page now), and registry attribution is dropped from each
 * card to reduce visual noise. Cards render in a two-column grid
 * because the catalog is long enough that a single column wastes
 * horizontal space.
 */
export function ConnectorBrowsePage({ mode }: { mode: "personal" | "workspace" }) {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [errors, setErrors] = useState<Array<{ registryId: string; message: string }>>([]);
  const [installed, setInstalled] = useState<InstalledConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [setupModalEntry, setSetupModalEntry] = useState<DirectoryEntry | null>(null);

  const role = useScopedRole();
  const isWsAdmin = roleAtLeast(role, "ws_admin");
  const navigate = useNavigate();

  const backPath =
    mode === "personal" ? "/settings/personal/connectors" : "/settings/workspace/connectors";
  const configureBasePath = backPath;

  // One fetcher for the page. Stable identity across renders via
  // useCallback so we can wire it both to the mount effect (with
  // cancellation) and the post-modal-save refresh from the same source.
  const fetchDirectory = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      setLoading(true);
      const [dirRes, insRes] = await Promise.all([
        listDirectory(),
        getInstalledConnectors({ scope: "workspace" }),
      ]);
      if (signal?.cancelled) return;
      setEntries(dirRes.entries);
      setErrors(dirRes.errors);
      setInstalled(insRes.installed);
    } catch (err) {
      if (signal?.cancelled) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    fetchDirectory(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchDirectory]);

  // Build install lookups so we can drop already-installed entries
  // from the Browse list. remote-oauth matches on URL, mpak-bundle on
  // package name (== InstalledConnector.bundleName).
  const installedByKey = useMemo(() => {
    const byUrl = new Set<string>();
    const byBundleName = new Set<string>();
    for (const ins of installed) {
      if (ins.url) byUrl.add(ins.url);
      byBundleName.add(ins.bundleName);
    }
    return { byUrl, byBundleName };
  }, [installed]);

  function isInstalled(entry: DirectoryEntry): boolean {
    if (entry.install.kind === "remote-oauth") return installedByKey.byUrl.has(entry.install.url);
    if (entry.install.kind === "mpak-bundle")
      return installedByKey.byBundleName.has(entry.install.package);
    return false;
  }

  // Filter to mode, drop installed, apply search. The UI `mode` is a
  // page-view discriminator (`"personal"` vs `"workspace"`) — both
  // values map 1:1 onto the catalog entry's `defaultBinding`. The
  // legacy `"user"` literal was renamed in T009 (Group D audit) because
  // a route/page mode indicator is not an oauthScope.
  const visibleEntries = useMemo(() => {
    const inScope = entries.filter((e) => e.defaultBinding === mode && !isInstalled(e));
    if (!query.trim()) return inScope;
    const q = query.trim().toLowerCase();
    return inScope.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
    // installedByKey is captured by isInstalled via closure; re-running
    // when it changes is what lets newly-installed connectors disappear.
  }, [entries, mode, query, installedByKey]);

  // The pre-T010 install was a one-click side-effect with implicit
  // scope. Stage 2 splits that into two steps: open the dialog, which
  // forces the user to pick a target workspace; on confirm the dialog
  // itself calls `installConnector(entry, wsId)` and reports back.
  // The dialog returns the picked `wsId` so post-install routing is
  // workspace-aware (Composio / DCR OAuth flow targets the picked
  // workspace, not the session's current header value).
  const [installDialogEntry, setInstallDialogEntry] = useState<DirectoryEntry | null>(null);

  const openInstallDialog = (entry: DirectoryEntry) => {
    setLoadError(null);
    setInstallDialogEntry(entry);
  };

  const onInstalled = async (
    entry: DirectoryEntry,
    result: { serverName: string; wsId: string },
  ) => {
    setInstallDialogEntry(null);
    setBusyId(`${entry.registryId}::${entry.id}`);
    try {
      // Remote OAuth: kick the user into the vendor's auth flow.
      // Stdio (mpak-bundle): install completes in-process; route to
      // Configure so the user can fill in any user_config fields.
      if (entry.install.kind === "remote-oauth") {
        // Composio-backed connectors route through their own initiate
        // endpoint (keyed on catalog id, not server name). Everything
        // else (dcr + static) stays on /v1/mcp-auth.
        const { authorizationUrl } =
          entry.install.auth === "composio"
            ? await initiateComposioOAuth(entry.id)
            : await initiateMcpOAuth(result.serverName);
        window.location.assign(authorizationUrl);
        return;
      }
      if (entry.install.kind === "mpak-bundle") {
        navigate(`${configureBasePath}/${result.serverName}`);
        return;
      }
      // direct-url not yet supported.
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <Link to={backPath} className="text-xs text-muted-foreground hover:underline">
          ← Installed connectors
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">Browse connectors</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {mode === "personal"
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

      {errors.length > 0 && (
        <div className="text-xs text-amber-600">
          {errors.map((e) => (
            <div key={e.registryId}>
              Couldn't reach <span className="font-medium">{e.registryId}</span>: {e.message}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : visibleEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? `No results for "${query}".` : "Everything available here is already installed."}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {visibleEntries.map((entry) => (
            <DirectoryCard
              key={`${entry.registryId}::${entry.id}`}
              entry={entry}
              busy={busyId === `${entry.registryId}::${entry.id}`}
              isWsAdmin={isWsAdmin}
              onInstall={() => openInstallDialog(entry)}
              onSetUp={() => setSetupModalEntry(entry)}
            />
          ))}
        </div>
      )}

      {installDialogEntry && (
        <InstallConnectorDialog
          entry={installDialogEntry}
          open={true}
          onClose={() => setInstallDialogEntry(null)}
          onInstalled={(result) => onInstalled(installDialogEntry, result)}
        />
      )}

      {setupModalEntry && (
        <OperatorSetupModal
          entry={setupModalEntry}
          // Pre-filling the existing clientId across renders is a v2
          // concern — list_installed doesn't echo the clientId today
          // (intentional: secret-or-not, surfacing identifiers from
          // workspace.json deserves its own response shape). For now
          // the operator re-enters on rotate.
          open={true}
          onClose={() => setSetupModalEntry(null)}
          onSaved={() => {
            setSetupModalEntry(null);
            fetchDirectory();
          }}
        />
      )}
    </div>
  );
}

/**
 * One card in the Browse grid. Layout:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ [icon] Bundle name                         │
 *   │        Short description, two lines max.   │
 *   │                                            │
 *   │                              [Install / …] │
 *   └────────────────────────────────────────────┘
 *
 * Two invariants keep the grid visually consistent regardless of
 * content length:
 *
 *   1. The description block reserves space for two lines (`min-h-8`,
 *      = 2 × 16px line-height for text-xs). A one-line description
 *      pads to the same height as a two-line one, so the action row's
 *      vertical position never depends on copy length.
 *
 *   2. The action row uses `mt-auto`, pinning it to the bottom of the
 *      card's flex column. If something later disturbs the math
 *      (longer titles, an extra meta line), the button still sticks
 *      to the bottom — the card just grows uniformly.
 *
 * Belt and suspenders. Either alone would work; together they're
 * resilient to future content shifts.
 */
function DirectoryCard({
  entry,
  busy,
  isWsAdmin,
  onInstall,
  onSetUp,
}: {
  entry: DirectoryEntry;
  busy: boolean;
  isWsAdmin: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  const isMpak = entry.install.kind === "mpak-bundle";
  const isStaticAuth = entry.install.kind === "remote-oauth" && entry.install.auth === "static";
  const operatorReady = entry.operatorConfigured === true;

  return (
    <div className="flex flex-col gap-3 p-4 border border-border/50 rounded-md bg-background h-full">
      <div className="flex items-start gap-3">
        <ConnectorIcon name={entry.name} iconUrl={entry.iconUrl} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{entry.name}</div>
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 min-h-8">
            {entry.description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-end justify-end">
        <CardAction
          entry={entry}
          busy={busy}
          isWsAdmin={isWsAdmin}
          isStaticAuth={isStaticAuth}
          operatorReady={operatorReady}
          isMpakStub={isMpak}
          onInstall={onInstall}
          onSetUp={onSetUp}
        />
      </div>
    </div>
  );
}

function CardAction({
  entry,
  busy,
  isWsAdmin,
  isStaticAuth,
  operatorReady,
  isMpakStub,
  onInstall,
  onSetUp,
}: {
  entry: DirectoryEntry;
  busy: boolean;
  isWsAdmin: boolean;
  isStaticAuth: boolean;
  operatorReady: boolean;
  isMpakStub: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  // Tailwind classes shared by every action button on the card. Outline
  // style — the previous bold primary fill made the grid feel
  // overstimulating with 30+ "Install" buttons stacked. The portal URL
  // surfaces inside OperatorSetupModal, so the small `app.asana.com`
  // hint that used to live under each Set up button is intentionally
  // gone here.
  const btnClass =
    "text-xs px-3 py-1.5 rounded border border-border bg-background hover:bg-muted disabled:opacity-60";

  // Static-auth flow:
  //   - not configured + admin     → Set up
  //   - not configured + non-admin → "Operator setup required"
  //   - configured                 → Install (rotation lives on Configure now)
  if (isStaticAuth && entry.install.kind === "remote-oauth") {
    if (!operatorReady) {
      if (isWsAdmin) {
        return (
          <button type="button" onClick={onSetUp} className={btnClass}>
            Set up
          </button>
        );
      }
      return <span className="text-xs text-muted-foreground">Operator setup required</span>;
    }
    return (
      <button type="button" onClick={onInstall} disabled={busy} className={btnClass}>
        {busy ? "Installing…" : "Install"}
      </button>
    );
  }
  if (isMpakStub) {
    return (
      <button type="button" onClick={onInstall} disabled={busy} className={btnClass}>
        {busy ? "Installing…" : "Install"}
      </button>
    );
  }
  return (
    <button type="button" onClick={onInstall} disabled={busy} className={btnClass}>
      {busy ? "Installing…" : "Install"}
    </button>
  );
}
