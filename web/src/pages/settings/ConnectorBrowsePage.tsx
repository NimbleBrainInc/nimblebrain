import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type DirectoryEntry,
  getInstalledConnectors,
  initiateMcpOAuth,
  type InstalledConnector,
  installConnector,
  listDirectory,
} from "../../api/client";
import { OperatorSetupModal } from "../../components/connectors/OperatorSetupModal";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";
import { safeHostname } from "../../lib/safe-url";

/**
 * Connector directory — browse what's available to install across
 * every enabled registry. v1 surfaces:
 *
 *   - Curated services (the platform's hand-vetted catalog)
 *   - mpak.dev (stub entries for now — install action pending the
 *     real mpak fetch + bundle install pipeline)
 *
 * Per-org admins control which registries are enabled at
 * Settings → Organization → Registries.
 */
export function ConnectorBrowsePage({ scope }: { scope: "user" | "workspace" }) {
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

  const backPath =
    scope === "user" ? "/settings/personal/connectors" : "/settings/workspace/connectors";
  const configureBasePath = backPath;

  // One fetcher for the page. Stable identity across renders via
  // useCallback so we can wire it both to the mount effect (with
  // cancellation) and the post-modal-save refresh from the same source.
  const fetchDirectory = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        setLoading(true);
        const [dirRes, insRes] = await Promise.all([
          listDirectory(),
          getInstalledConnectors({ scope }),
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
    },
    [scope],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    fetchDirectory(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchDirectory]);

  // Match installed bundles back to directory entries:
  //   - remote-oauth  → match by URL
  //   - mpak-bundle   → match by package name (== bundleName for now)
  const installedByKey = useMemo(() => {
    const byUrl = new Map<string, InstalledConnector>();
    const byBundleName = new Map<string, InstalledConnector>();
    for (const ins of installed) {
      if (ins.url) byUrl.set(ins.url, ins);
      byBundleName.set(ins.bundleName, ins);
    }
    return { byUrl, byBundleName };
  }, [installed]);

  function findInstalled(entry: DirectoryEntry): InstalledConnector | undefined {
    if (entry.install.kind === "remote-oauth") return installedByKey.byUrl.get(entry.install.url);
    if (entry.install.kind === "mpak-bundle")
      return installedByKey.byBundleName.get(entry.install.package);
    return undefined;
  }

  // Filter to scope + search, then split installed vs not. Sort
  // not-installed up top so users find new things first.
  const groups = useMemo(() => {
    const inScope = entries.filter((e) => e.defaultScope === scope);
    const matched = !query.trim()
      ? inScope
      : inScope.filter((e) => {
          const q = query.trim().toLowerCase();
          return (
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
          );
        });
    const notInstalled: DirectoryEntry[] = [];
    const installedEntries: Array<{ entry: DirectoryEntry; installed: InstalledConnector }> = [];
    for (const e of matched) {
      const ins = findInstalled(e);
      if (ins) installedEntries.push({ entry: e, installed: ins });
      else notInstalled.push(e);
    }
    return { notInstalled, installedEntries };
  }, [entries, scope, query, installedByKey]);

  const onInstall = async (entry: DirectoryEntry) => {
    if (entry.install.kind !== "remote-oauth") return; // only remote-oauth supported in v1
    setBusyId(`${entry.registryId}::${entry.id}`);
    setLoadError(null);
    try {
      const res = await installConnector(entry.id);
      const { authorizationUrl } = await initiateMcpOAuth(res.serverName);
      window.location.assign(authorizationUrl);
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
      ) : groups.notInstalled.length === 0 && groups.installedEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? `No results for "${query}".` : "No connectors available in this scope."}
        </p>
      ) : (
        <>
          {groups.notInstalled.length > 0 && (
            <div className="border-t border-border">
              {groups.notInstalled.map((entry) => (
                <DirectoryRow
                  key={`${entry.registryId}::${entry.id}`}
                  entry={entry}
                  installed={undefined}
                  configureBasePath={configureBasePath}
                  busy={busyId === `${entry.registryId}::${entry.id}`}
                  isWsAdmin={isWsAdmin}
                  onInstall={() => onInstall(entry)}
                  onSetUp={() => setSetupModalEntry(entry)}
                />
              ))}
            </div>
          )}

          {groups.installedEntries.length > 0 && (
            <div className="mt-4">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Already installed
              </h2>
              <div className="border-t border-border">
                {groups.installedEntries.map(({ entry, installed: ins }) => (
                  <DirectoryRow
                    key={`${entry.registryId}::${entry.id}`}
                    entry={entry}
                    installed={ins}
                    configureBasePath={configureBasePath}
                    busy={false}
                    isWsAdmin={isWsAdmin}
                    onInstall={() => onInstall(entry)}
                    onSetUp={() => setSetupModalEntry(entry)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <FutureSourcesNote />

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

function DirectoryRow({
  entry,
  installed,
  configureBasePath,
  busy,
  isWsAdmin,
  onInstall,
  onSetUp,
}: {
  entry: DirectoryEntry;
  installed: InstalledConnector | undefined;
  configureBasePath: string;
  busy: boolean;
  isWsAdmin: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  const isInstalled = !!installed;
  const isMpak = entry.install.kind === "mpak-bundle";
  const isStaticAuth = entry.install.kind === "remote-oauth" && entry.install.auth === "static";
  const operatorReady = entry.operatorConfigured === true;

  return (
    <div className="flex items-center gap-3 py-3 border-b border-border">
      {entry.iconUrl ? (
        <img
          src={entry.iconUrl}
          alt=""
          className={`h-7 w-7 rounded shrink-0 ${isInstalled ? "opacity-60" : ""}`}
          onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
        />
      ) : (
        <div className="h-7 w-7 rounded bg-muted shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{entry.name}</span>
          <RegistryBadge type={entry.registryType} />
        </div>
        <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
      </div>
      <RowAction
        entry={entry}
        installed={installed}
        configureBasePath={configureBasePath}
        busy={busy}
        isWsAdmin={isWsAdmin}
        isStaticAuth={isStaticAuth}
        operatorReady={operatorReady}
        isMpakStub={isMpak}
        onInstall={onInstall}
        onSetUp={onSetUp}
      />
    </div>
  );
}

function RowAction({
  entry,
  installed,
  configureBasePath,
  busy,
  isWsAdmin,
  isStaticAuth,
  operatorReady,
  isMpakStub,
  onInstall,
  onSetUp,
}: {
  entry: DirectoryEntry;
  installed: InstalledConnector | undefined;
  configureBasePath: string;
  busy: boolean;
  isWsAdmin: boolean;
  isStaticAuth: boolean;
  operatorReady: boolean;
  isMpakStub: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  if (installed) {
    return (
      <Link
        to={`${configureBasePath}/${installed.serverName}`}
        className="text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:bg-muted shrink-0"
      >
        Installed · Configure
      </Link>
    );
  }
  // Static-auth flow:
  //   - not configured + admin   → Set up (opens modal)
  //   - not configured + non-admin → "Operator setup required" + portal link
  //   - configured + admin       → Install + small "Edit setup" link
  //   - configured + non-admin   → Install
  if (isStaticAuth && entry.install.kind === "remote-oauth") {
    if (!operatorReady) {
      if (isWsAdmin) {
        return (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              type="button"
              onClick={onSetUp}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Set up
            </button>
            {entry.install.operatorSetup?.portalUrl && (
              <a
                href={entry.install.operatorSetup.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-muted-foreground underline"
              >
                {safeHostname(entry.install.operatorSetup.portalUrl)}
              </a>
            )}
          </div>
        );
      }
      return (
        <div className="flex flex-col items-end text-right shrink-0">
          <span className="text-xs text-amber-600">Operator setup required</span>
          {entry.install.operatorSetup?.portalUrl && (
            <a
              href={entry.install.operatorSetup.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted-foreground underline"
            >
              {safeHostname(entry.install.operatorSetup.portalUrl)}
            </a>
          )}
        </div>
      );
    }
    // Configured: Install only. Rotation moved to Configure → OAuth
    // client section now that the Configure page reads operator audit
    // metadata and serves as the single canonical home for credential
    // edits. Browse stays focused on discovery + first-time setup.
    return (
      <button
        type="button"
        onClick={onInstall}
        disabled={busy}
        className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 shrink-0"
      >
        {busy ? "Installing…" : "Install"}
      </button>
    );
  }
  if (isMpakStub) {
    const mpakUrl = entry.install.kind === "mpak-bundle" ? entry.install.mpakUrl : undefined;
    return (
      <div className="flex flex-col items-end text-right shrink-0">
        <span className="text-xs text-muted-foreground">Install via mpak — coming soon</span>
        {mpakUrl && (
          <a
            href={mpakUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted-foreground underline"
          >
            View on mpak.dev
          </a>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onInstall}
      disabled={busy}
      className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 shrink-0"
    >
      {busy ? "Installing…" : "Install"}
    </button>
  );
}

function RegistryBadge({ type }: { type: DirectoryEntry["registryType"] }) {
  // Lowercase, subtle, no border — registry attribution is secondary
  // information; the badge is only here for users who want to know
  // where something came from.
  const label = type === "curated" ? "Curated" : type === "mpak" ? "mpak.dev" : type;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">
      {label}
    </span>
  );
}

function FutureSourcesNote() {
  return (
    <div className="mt-4 pt-4 border-t border-border">
      <p className="text-xs text-muted-foreground">
        Configure registries at{" "}
        <Link to="/settings/org/registries" className="underline-offset-4 hover:underline">
          Settings → Organization → Registries
        </Link>
        .
      </p>
    </div>
  );
}
