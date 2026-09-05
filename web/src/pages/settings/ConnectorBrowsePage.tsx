import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type DirectoryEntry,
  getInstalledConnectors,
  type InstalledConnector,
  initiateComposioOAuth,
  initiateMcpOAuth,
  installConnector,
  listDirectory,
  type RemoteOAuthInstall,
} from "../../api/client";
import { ComposioApiKeyModal } from "../../components/connectors/ComposioApiKeyModal";
import { ConnectorIcon } from "../../components/connectors/ConnectorIcon";
import { OperatorSetupModal } from "../../components/connectors/OperatorSetupModal";
import { SecretHeadersModal } from "../../components/connectors/SecretHeadersModal";
import { Button } from "../../components/ui/button";
import { useCanWriteActiveWorkspace } from "../../hooks/useScopedRole";
import { installCompletesWithoutSignIn } from "../../lib/connector-auth-flow.ts";
import { type SecretHeaderField, secretHeaderFields } from "../../lib/secret-headers";

/**
 * Connector directory — what's available to install. The Browse page
 * is intentionally focused on *discovery*: already-installed
 * connectors are filtered out (they live on the Connectors list →
 * Configure page now), and registry attribution is dropped from each
 * card to reduce visual noise. Cards render in a two-column grid
 * because the catalog is long enough that a single column wastes
 * horizontal space.
 */
export function ConnectorBrowsePage() {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [errors, setErrors] = useState<Array<{ registryId: string; message: string }>>([]);
  const [installed, setInstalled] = useState<InstalledConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [setupModalEntry, setSetupModalEntry] = useState<DirectoryEntry | null>(null);
  // API-key Composio connector: after install we collect the key fields in a
  // modal (no OAuth redirect), then call connect_api_key. Holds the entry +
  // its installed serverName so success can route to Configure.
  const [apiKeyModal, setApiKeyModal] = useState<{
    entry: DirectoryEntry;
    serverName: string;
  } | null>(null);
  // A connector declaring `secretHeaders` needs its values BEFORE the install:
  // an `auth: "provider"` entry eager-starts at install, and a start with an
  // unresolvable reference fails with CredentialNotFoundError. Collecting
  // afterwards would show the user that failure and then ask them to fix it.
  const [secretsModal, setSecretsModal] = useState<{
    entry: DirectoryEntry;
    fields: SecretHeaderField[];
  } | null>(null);

  // Installing a connector writes workspace-owned state, so this is the
  // membership gate, not the reach gate — an org admin who is only a member
  // here is refused by `canWriteWorkspaceScoped` server-side.
  const canManage = useCanWriteActiveWorkspace();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();

  // Connectors are addressed by the URL slug — install targets whichever
  // workspace (personal or shared) the user is currently viewing.
  const backPath = `/w/${slug}/settings/connectors`;
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

  // Build the install lookup so we can drop already-installed entries from
  // the Browse list. A remote-oauth entry matches on URL.
  const installedUrls = useMemo(() => {
    const byUrl = new Set<string>();
    for (const ins of installed) {
      if (ins.url) byUrl.add(ins.url);
    }
    return byUrl;
  }, [installed]);

  // useCallback so the visibleEntries memo can depend on a stable isInstalled
  // (its identity changes only when installedUrls does — the same trigger the
  // memo needs to drop newly-installed connectors from the list).
  const isInstalled = useCallback(
    (entry: DirectoryEntry): boolean =>
      entry.install.kind === "remote-oauth" && installedUrls.has(entry.install.url),
    [installedUrls],
  );

  // One unified browse list: every connector is installable into any
  // workspace, so the only filtering is dropping already-installed
  // entries and applying the search query.
  const visibleEntries = useMemo(() => {
    const available = entries.filter((e) => !isInstalled(e));
    if (!query.trim()) return available;
    const q = query.trim().toLowerCase();
    return available.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [entries, query, isInstalled]);

  // Route a completed remote-OAuth install per its auth scheme: provider-auth to
  // Configure, API-key Composio to the key modal, and everything else into the
  // vendor's OAuth redirect.
  const routeRemoteOAuthInstall = async (
    entry: DirectoryEntry,
    install: RemoteOAuthInstall,
    serverName: string,
  ) => {
    // A provider-auth (platform) source has no user/operator OAuth — its
    // credential is minted server-side and it eager-starts `running` at install.
    // So there's no auth flow to launch: route to Configure, which renders it
    // `ready`. Launching initiateMcpOAuth here would spin a bogus OAuth flow
    // against a server that has none.
    //
    // A smithery-auth source is the same shape for the same reason: the broker
    // holds the credential, the transport carries a static header, and the
    // install eager-starts it `running`. Falling through would call
    // `initiateMcpOAuth`, which throws "already connected" on a running source
    // and surfaces as a 500 — a red error on an install that actually SUCCEEDED.
    if (installCompletesWithoutSignIn(install.auth)) {
      navigate(`${configureBasePath}/${serverName}`);
      return;
    }
    // API-key Composio connectors have no OAuth redirect — collect the declared
    // fields in a modal and call connect_api_key. The install already created the
    // bundle ref the connect step needs.
    if (install.auth === "composio" && install.composio?.authScheme === "API_KEY") {
      setApiKeyModal({ entry, serverName });
      setBusyId(null);
      return;
    }
    // Composio-backed connectors route through their own initiate endpoint (keyed
    // on catalog id, not server name). Everything else (dcr + static) stays on
    // /v1/mcp-auth.
    const { authorizationUrl } =
      install.auth === "composio"
        ? await initiateComposioOAuth(entry.id)
        : await initiateMcpOAuth(serverName);
    if (!authorizationUrl) {
      // Connected without an interactive flow (already authenticated) — route to
      // Configure like the provider-auth case rather than redirecting to a
      // nonexistent auth page (#679).
      navigate(`${configureBasePath}/${serverName}`);
      return;
    }
    window.location.assign(authorizationUrl);
  };

  // Install into the workspace the user is already in. The page is
  // mounted under `/w/<slug>/...`, so the route names an unambiguous
  // workspace; `installConnector` sends no explicit target and the server
  // installs into the request's workspace (X-Workspace-Id, derived from
  // that same route). That's the identical workspace the follow-up
  // `initiateMcpOAuth` / list_tools / status calls read — so an install
  // and its connect step can't land in different workspaces. (The prior
  // target-picker let them diverge, which surfaced as "Bundle not
  // installed" on Connect.)
  const runInstall = async (entry: DirectoryEntry) => {
    setLoadError(null);
    setBusyId(`${entry.registryId}::${entry.id}`);
    try {
      const result = await installConnector(entry);
      // Remote OAuth: kick the user into the vendor's auth flow.
      // direct-url not yet supported.
      if (entry.install.kind === "remote-oauth") {
        await routeRemoteOAuthInstall(entry, entry.install, result.serverName);
        return;
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
    }
  };

  // Install, asking for the entry's declared workspace secrets first when it has
  // any. Cancelling the dialog installs nothing, which is the honest outcome: a
  // connector that cannot reach its upstream was never added, so there is no
  // dead row on the Connectors list and nothing to clean up.
  //
  // The symmetry stops at cancel. If the install itself fails after the dialog
  // wrote the keys, those values stay in the store with no connector attached —
  // deliberately: a retry reuses them, and unwinding a write to the credential
  // store on an unrelated failure is a delete this path has no business making.
  const onInstall = async (entry: DirectoryEntry) => {
    const fields = secretHeaderFields(entry.install);
    if (fields.length > 0) {
      setLoadError(null);
      setSecretsModal({ entry, fields });
      return;
    }
    await runInstall(entry);
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
          Tools and services to add to this workspace.
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
              canManage={canManage}
              onInstall={() => onInstall(entry)}
              onSetUp={() => setSetupModalEntry(entry)}
            />
          ))}
        </div>
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

      {secretsModal && (
        <SecretHeadersModal
          connectorName={secretsModal.entry.name}
          fields={secretsModal.fields}
          open={true}
          onClose={() => setSecretsModal(null)}
          onStored={async () => {
            const entry = secretsModal.entry;
            setSecretsModal(null);
            await runInstall(entry);
          }}
        />
      )}

      {apiKeyModal && apiKeyModal.entry.install.kind === "remote-oauth" && (
        <ComposioApiKeyModal
          catalogId={apiKeyModal.entry.id}
          connectorName={apiKeyModal.entry.name}
          fields={apiKeyModal.entry.install.composio?.fields ?? []}
          open={true}
          onClose={() => setApiKeyModal(null)}
          onConnected={() => {
            const serverName = apiKeyModal.serverName;
            setApiKeyModal(null);
            navigate(`${configureBasePath}/${serverName}`);
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
  canManage,
  onInstall,
  onSetUp,
}: {
  entry: DirectoryEntry;
  busy: boolean;
  canManage: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  const isStaticAuth = entry.install.kind === "remote-oauth" && entry.install.auth === "static";
  const operatorReady = entry.operatorConfigured === true;
  // Say it on the card, not once the dialog appears. `operatorConfigured` already
  // distinguishes a static-auth entry that is ready from one that is not; this is
  // the same disclosure for the other thing an install can ask for.
  const secretCount = secretHeaderFields(entry.install).length;

  return (
    <div className="flex flex-col gap-3 p-4 border border-border/60 rounded-sm bg-background h-full">
      <div className="flex items-start gap-3">
        <ConnectorIcon name={entry.name} iconUrl={entry.iconUrl} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{entry.name}</div>
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 min-h-8">
            {entry.description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-end justify-between gap-2">
        {secretCount > 0 ? (
          <span className="text-2xs text-muted-foreground border border-border/60 rounded-sm px-1.5 py-0.5">
            {secretCount === 1 ? "Needs a credential" : `Needs ${secretCount} credentials`}
          </span>
        ) : (
          <span />
        )}
        <CardAction
          busy={busy}
          canManage={canManage}
          isStaticAuth={isStaticAuth}
          operatorReady={operatorReady}
          onInstall={onInstall}
          onSetUp={onSetUp}
        />
      </div>
    </div>
  );
}

/**
 * The card's action slot. Exported so the install gate is directly testable:
 * it is the only thing standing between a workspace member and an Install
 * button the server refuses.
 */
export function CardAction({
  busy,
  canManage,
  isStaticAuth,
  operatorReady,
  onInstall,
  onSetUp,
}: {
  busy: boolean;
  canManage: boolean;
  isStaticAuth: boolean;
  operatorReady: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  // Outline rather than filled: a grid of 30+ buttons reads as noise with a
  // bold primary fill on every card. The portal URL lives in
  // OperatorSetupModal, so no per-card hint is needed here.
  //
  // Static-auth flow:
  //   - not configured + admin     → Set up
  //   - not configured + non-admin → "Operator setup required"
  //   - configured                 → Install (rotation lives on Configure now)
  if (isStaticAuth && !operatorReady) {
    return canManage ? (
      <Button type="button" variant="outline" size="sm" onClick={onSetUp}>
        Set up
      </Button>
    ) : (
      <span className="text-xs text-muted-foreground">Operator setup required</span>
    );
  }
  // Every remaining path is an install, and installing is a workspace-scoped
  // write — `workspaceInstallAdmission` refuses a non-admin with "Workspace
  // admin role required to install connectors." An enabled button would move
  // that refusal to after the click. One gated return covers every install
  // path, so a new one can't miss the gate by being added elsewhere.
  return canManage ? (
    <Button type="button" variant="outline" size="sm" onClick={onInstall} disabled={busy}>
      {busy ? "Installing…" : "Install"}
    </Button>
  ) : (
    <span className="text-xs text-muted-foreground">Workspace admin required</span>
  );
}
