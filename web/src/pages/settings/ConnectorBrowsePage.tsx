import { Check, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  type CatalogListing,
  getInstalledConnectors,
  type InstalledConnector,
  initiateComposioIdentityConnect,
  initiateComposioOAuth,
  initiateIdentityConnect,
  initiateMcpOAuth,
  installConnector,
  installPersonalConnector,
  listDirectory,
  listPersonalConnectors,
  type RemoteOAuthInstall,
} from "../../api/client";
import { ComposioApiKeyModal } from "../../components/connectors/ComposioApiKeyModal";
import { ConnectorIcon } from "../../components/connectors/ConnectorIcon";
import {
  type InstallAudience,
  InstallAudienceDialog,
} from "../../components/connectors/InstallAudienceDialog";
import {
  OAuthClientSetupModal,
  type OAuthClientSetupTarget,
} from "../../components/connectors/OAuthClientSetupModal";
import { SecretHeadersModal } from "../../components/connectors/SecretHeadersModal";
import { Button } from "../../components/ui/button";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useCanWriteActiveWorkspace } from "../../hooks/useScopedRole";
import { installCompletesWithoutSignIn } from "../../lib/connector-auth-flow.ts";
import { shellPath } from "../../lib/plugins";
import { type SecretHeaderField, secretHeaderFields } from "../../lib/secret-headers";
import { toWsId } from "../../lib/workspace-slug";

type InstallResult = Awaited<ReturnType<typeof installConnector>>;

/**
 * Floor on the "Installing…" state for an install that finishes on this page.
 * A provider install can return in tens of milliseconds, and a button that
 * flips straight to "Installed" reads as a flicker rather than an action.
 * Paths that leave the page (a vendor sign-in) never wait on it.
 */
export const INSTALL_MIN_SPINNER_MS = 400;

/** Where a person's own connectors are managed: sign-in, workspaces, tools. */
export const PERSONAL_CONNECTORS_PATH = "/profile/connectors";

/**
 * The Browse connectors page under workspace settings: a way back to the
 * installed list, a header, and the directory.
 */
export function ConnectorBrowsePage() {
  const { slug } = useParams<{ slug: string }>();
  const backPath = `/w/${slug}/settings/connectors`;
  return (
    <div className="space-y-6">
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

      <ConnectorDirectory />
    </div>
  );
}

/**
 * Connector directory — what's available to install. Entries not yet in
 * this workspace fill the grid; installed ones sit in their own section
 * below, muted, with a link to their Configure page, so the directory
 * answers "do we have this already?" without a trip to the Connectors
 * list. Registry attribution is dropped from each card to reduce visual
 * noise. Cards render in a two-column grid because the catalog is long
 * enough that a single column wastes horizontal space. The grid steps on
 * its own container, since it renders both in settings and on the Plugins
 * page.
 *
 * An install that needs no sign-in finishes here: the card turns to
 * "Installed" in place. It moves to the Installed section on the next
 * visit, not mid-visit, so nothing jumps out from under the cursor.
 *
 * With `offerPersonal`, an entry that can hold a per-person credential
 * (`personalInstallable`) asks whom the install is for: "Just me" (the
 * default) installs it on the viewer's own account and grants it into this
 * workspace in the same call (ADR-0069), then runs the personal sign-in;
 * "Everyone in <workspace>" is the workspace install below, offered only to a
 * member who may write the workspace and only while the workspace has no
 * install of it. An entry the workspace already has still offers "Just me": a
 * person's own install sits beside the workspace's. An entry that cannot hold
 * a per-person credential is a workspace install, and its card says why.
 */
export function ConnectorDirectory({ offerPersonal = false }: { offerPersonal?: boolean } = {}) {
  const [entries, setEntries] = useState<CatalogListing[]>([]);
  const [errors, setErrors] = useState<Array<{ file: string; message: string }>>([]);
  const [installed, setInstalled] = useState<InstalledConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Entries installed during this visit, catalog id → the page that manages
  // the install (the workspace's Configure page, or the viewer's own
  // connectors for a personal one). Kept apart
  // from `installed` so a directory refetch (after OAuth client setup) cannot move
  // a card the user just installed into the Installed section.
  const [justInstalled, setJustInstalled] = useState<ReadonlyMap<string, string>>(new Map());
  const [query, setQuery] = useState("");
  // The entry whose install is asking whom it is for, and whether the workspace
  // already has its own install of it.
  const [audienceEntry, setAudienceEntry] = useState<CatalogListing | null>(null);
  const [audienceWorkspaceInstalled, setAudienceWorkspaceInstalled] = useState(false);
  const [setupModalEntry, setSetupModalEntry] = useState<OAuthClientSetupTarget | null>(null);
  // API-key Composio connector: after install we collect the key fields in a
  // modal (no OAuth redirect), then call connect_api_key. Holds the entry +
  // its installed serverName so success can route to Configure.
  const [apiKeyModal, setApiKeyModal] = useState<{
    entry: CatalogListing;
    serverName: string;
  } | null>(null);
  // A connector declaring `secretHeaders` needs its values BEFORE the install:
  // an `auth: "provider"` entry eager-starts at install, and a start with an
  // unresolvable reference fails with CredentialNotFoundError. Collecting
  // afterwards would show the user that failure and then ask them to fix it.
  const [secretsModal, setSecretsModal] = useState<{
    entry: CatalogListing;
    fields: SecretHeaderField[];
  } | null>(null);

  // Installing a connector writes workspace-owned state, so this is the
  // membership gate, not the reach gate — an org admin who is only a member
  // here is refused by `canWriteWorkspaceScoped` server-side.
  const canManage = useCanWriteActiveWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const { slug } = useParams<{ slug: string }>();
  const wsId = slug ? toWsId(slug) : undefined;
  const { workspaces } = useWorkspaceContext();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";

  // Connectors are addressed by the URL slug — install targets whichever
  // workspace the user is currently viewing.
  const configureBasePath = `/w/${slug}/settings/connectors`;

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

  // Which installed connector, if any, each directory entry already is. Catalog
  // id first: a brokered install (Composio, Smithery) stores a per-install
  // session URL that never equals the catalog URL, which is also why the server
  // resolves its catalog entry by id. URL covers an install whose catalog match
  // didn't resolve.
  const installedServerName = useMemo(() => {
    const byCatalogId = new Map<string, string>();
    const byUrl = new Map<string, string>();
    for (const ins of installed) {
      if (ins.catalogId) byCatalogId.set(ins.catalogId, ins.serverName);
      if (ins.url) byUrl.set(ins.url, ins.serverName);
    }
    return (entry: CatalogListing): string | undefined =>
      byCatalogId.get(entry.id) ??
      (entry.install.kind === "remote-oauth" ? byUrl.get(entry.install.url) : undefined);
  }, [installed]);

  // Two sections, one search: the query filters both. An entry installed
  // during this visit stays in `available` (rendered as Installed) so it
  // doesn't jump sections under the cursor.
  const { available, installedEntries } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (e: CatalogListing) =>
      !q ||
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q));
    const available: CatalogListing[] = [];
    const installedEntries: Array<{ entry: CatalogListing; serverName: string }> = [];
    for (const entry of entries) {
      if (!matches(entry)) continue;
      const serverName = installedServerName(entry);
      if (serverName && !justInstalled.has(entry.id)) installedEntries.push({ entry, serverName });
      else available.push(entry);
    }
    return { available, installedEntries };
  }, [entries, query, installedServerName, justInstalled]);

  const markInstalled = (entry: CatalogListing, managePath: string) => {
    setJustInstalled((prev) => new Map(prev).set(entry.id, managePath));
    setBusyId(null);
  };

  // An install with nothing left to do finishes on this page — unless it came
  // back with a warning. Then the connector is installed but not working (an
  // eager start that threw), and "Installed" on the card would hide that:
  // Configure is where its failed state and reason render.
  const finishesInPage = (install: InstallResult): boolean => {
    if (!install.warning) return true;
    navigate(`${configureBasePath}/${install.serverName}`);
    return false;
  };

  // Route a completed remote-OAuth install per its auth scheme: provider-auth
  // finishes here, API-key Composio opens the key modal, and everything else
  // goes into the vendor's OAuth redirect. Returns true when the install
  // finished here.
  const routeRemoteOAuthInstall = async (
    entry: CatalogListing,
    install: RemoteOAuthInstall,
    result: InstallResult,
  ): Promise<boolean> => {
    const { serverName } = result;
    // A provider-auth (platform) source has no user OAuth and no OAuth client — its
    // credential is minted server-side and it eager-starts `running` at install.
    // So there's no auth flow to launch. Launching initiateMcpOAuth here would
    // spin a bogus OAuth flow against a server that has none.
    //
    // A smithery-auth source is the same shape for the same reason: the broker
    // holds the credential, the transport carries a static header, and the
    // install eager-starts it `running`. Falling through would call
    // `initiateMcpOAuth`, which throws "already connected" on a running source
    // and surfaces as a 500 — a red error on an install that actually SUCCEEDED.
    if (installCompletesWithoutSignIn(install.auth)) return finishesInPage(result);
    // API-key Composio connectors have no OAuth redirect — collect the declared
    // fields in a modal and call connect_api_key. The install already created the
    // connector ref the connect step needs.
    if (install.auth === "composio" && install.composio?.authScheme === "API_KEY") {
      setApiKeyModal({ entry, serverName });
      setBusyId(null);
      return false;
    }
    // Composio-backed connectors route through their own initiate endpoint (keyed
    // on catalog id, not server name). Everything else (dcr + static) stays on
    // mcp-auth.
    const { authorizationUrl } =
      install.auth === "composio"
        ? await initiateComposioOAuth(entry.id)
        : await initiateMcpOAuth(serverName);
    // Connected without an interactive flow (already authenticated) — finish
    // like the provider-auth case rather than redirecting to a nonexistent auth
    // page (#679).
    if (!authorizationUrl) return finishesInPage(result);
    window.location.assign(authorizationUrl);
    return false;
  };

  // Install into the workspace the user is already in. The page is
  // mounted under `/w/<slug>/...`, so the route names an unambiguous
  // workspace; `installConnector` sends no explicit target and the server
  // installs into the request's workspace (the one in its path, derived
  // from that same route). That's the identical workspace the follow-up
  // `initiateMcpOAuth` / list_tools / status calls read — so an install
  // and its connect step can't land in different workspaces. (The prior
  // target-picker let them diverge, which surfaced as "Connector not
  // installed" on Connect.)
  const runInstall = async (entry: CatalogListing) => {
    setLoadError(null);
    setBusyId(entry.id);
    // Started beside the request, not after it, so the floor adds nothing to an
    // install slower than it. Only an install that finishes here awaits it.
    const minSpinner = new Promise((resolve) => setTimeout(resolve, INSTALL_MIN_SPINNER_MS));
    try {
      const result = await installConnector(entry);
      // direct-url not yet supported.
      if (entry.install.kind === "remote-oauth") {
        if (await routeRemoteOAuthInstall(entry, entry.install, result)) {
          await minSpinner;
          markInstalled(entry, `${configureBasePath}/${result.serverName}`);
        }
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
  const onInstall = async (entry: CatalogListing) => {
    const fields = secretHeaderFields(entry.install);
    if (fields.length > 0) {
      setLoadError(null);
      setSecretsModal({ entry, fields });
      return;
    }
    await runInstall(entry);
  };

  // Install on the viewer's own account, granted into this workspace by the
  // same call, then sign in. The grant needs only the install, so it is
  // already in place when the sign-in's callback lands, and stands if the
  // person never finishes it (the connector then reads Not connected on their
  // profile, with Connect). A connector already connected needs no sign-in: a
  // Connect on a live connection is refused as busy. Throws, so the dialog
  // shows the failure beside the choice that caused it.
  const runPersonalInstall = async (entry: CatalogListing) => {
    if (!wsId) throw new Error("No workspace to turn it on in.");
    const result = await installPersonalConnector(entry, wsId);
    if (result.alreadyInstalled) {
      const { connectors } = await listPersonalConnectors();
      const mine = connectors.find((c) => c.serverName === result.serverName);
      if (mine?.state === "running") {
        setAudienceEntry(null);
        markInstalled(entry, PERSONAL_CONNECTORS_PATH);
        return;
      }
    }
    // The Connect route follows the auth, as on the profile: a brokered
    // connector keys on its catalog id, everything else on its server name.
    // The sign-in returns to this page, where the install started.
    const returnTo = shellPath(location);
    const { authorizationUrl } =
      entry.install.kind === "remote-oauth" && entry.install.auth === "composio"
        ? await initiateComposioIdentityConnect(entry.id, returnTo)
        : await initiateIdentityConnect(result.serverName, returnTo);
    if (authorizationUrl) {
      window.location.assign(authorizationUrl);
      return;
    }
    setAudienceEntry(null);
    markInstalled(entry, PERSONAL_CONNECTORS_PATH);
  };

  // The card's Install: ask whom it is for where a personal install is
  // possible, otherwise install into the workspace as before.
  const onInstallClick = (entry: CatalogListing, workspaceInstalled: boolean) => {
    if (offerPersonal && entry.personalInstallable) {
      setLoadError(null);
      setAudienceWorkspaceInstalled(workspaceInstalled);
      setAudienceEntry(entry);
      return;
    }
    void onInstall(entry);
  };

  const onAudienceChosen = async (audience: InstallAudience) => {
    const entry = audienceEntry;
    if (!entry) return;
    if (audience === "personal") {
      await runPersonalInstall(entry);
      return;
    }
    setAudienceEntry(null);
    await onInstall(entry);
  };

  return (
    <div className="@container/directory space-y-6">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the directory…"
        data-tour="catalog"
        className="w-full text-sm px-3 py-2 rounded border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      {errors.length > 0 && (
        <div className="text-xs text-amber-600">
          {errors.map((e) => (
            <div key={e.file}>
              Couldn't read <span className="font-medium">{e.file}</span>: {e.message}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : (
        <DirectoryResults
          query={query}
          available={available}
          installedEntries={installedEntries}
          renderCard={(entry, configurePath) => {
            // Installed in this workspace, as opposed to installed just now for
            // the viewer alone. The former still offers the viewer's own install.
            const workspaceInstalled =
              configurePath !== undefined && configurePath !== PERSONAL_CONNECTORS_PATH;
            return (
              <DirectoryCard
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                canManage={canManage}
                personal={
                  offerPersonal
                    ? Boolean(entry.personalInstallable) &&
                      configurePath !== PERSONAL_CONNECTORS_PATH
                    : undefined
                }
                configurePath={configurePath}
                onInstall={() => onInstallClick(entry, workspaceInstalled)}
                onSetUp={() => setSetupModalEntry(oauthClientSetupTarget(entry))}
              />
            );
          }}
          configurePathFor={(entry) => justInstalled.get(entry.id)}
          installedPathFor={(serverName) => `${configureBasePath}/${serverName}`}
        />
      )}

      {setupModalEntry && (
        <OAuthClientSetupModal
          entry={setupModalEntry}
          // Pre-filling the existing clientId across renders is a v2
          // concern — list_installed doesn't echo the clientId today
          // (intentional: secret-or-not, surfacing identifiers from
          // workspace.json deserves its own response shape). For now
          // the admin re-enters on rotate.
          open={true}
          onClose={() => setSetupModalEntry(null)}
          onSaved={() => {
            setSetupModalEntry(null);
            fetchDirectory();
          }}
        />
      )}

      {audienceEntry && (
        <InstallAudienceDialog
          open={true}
          connectorName={audienceEntry.name}
          workspaceName={workspaceName}
          canWriteWorkspace={canManage}
          installedForEveryone={audienceWorkspaceInstalled}
          onOpenChange={(open) => {
            if (!open) setAudienceEntry(null);
          }}
          onInstall={onAudienceChosen}
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
            markInstalled(apiKeyModal.entry, `${configureBasePath}/${apiKeyModal.serverName}`);
            setApiKeyModal(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The directory body: entries not yet installed in the grid, installed ones in
 * a muted section beneath. `configurePathFor` marks an entry installed during
 * this visit, which renders as Installed but keeps its place in the grid.
 */
function DirectoryResults({
  query,
  available,
  installedEntries,
  renderCard,
  configurePathFor,
  installedPathFor,
}: {
  query: string;
  available: CatalogListing[];
  installedEntries: Array<{ entry: CatalogListing; serverName: string }>;
  renderCard: (entry: CatalogListing, configurePath: string | undefined) => ReactNode;
  configurePathFor: (entry: CatalogListing) => string | undefined;
  installedPathFor: (serverName: string) => string;
}) {
  if (available.length === 0 && installedEntries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {query ? `No results for "${query}".` : "No connectors are available to this workspace."}
      </p>
    );
  }
  return (
    <>
      {available.length > 0 ? (
        <div className="grid grid-cols-1 @md/directory:grid-cols-2 gap-3">
          {available.map((entry) => renderCard(entry, configurePathFor(entry)))}
        </div>
      ) : (
        !query && (
          <p className="text-sm text-muted-foreground">
            Everything available here is already installed.
          </p>
        )
      )}
      {installedEntries.length > 0 && (
        <section className="space-y-3 pt-2">
          <h2 className="text-sm font-medium text-muted-foreground">Installed</h2>
          <div className="grid grid-cols-1 @md/directory:grid-cols-2 gap-3">
            {installedEntries.map(({ entry, serverName }) =>
              renderCard(entry, installedPathFor(serverName)),
            )}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * What Set up hands the OAuth client dialog. A catalog listing carries the vendor
 * portal and secret key under `install`, only on a remote-OAuth install; the
 * dialog reads a top-level `oauthClientSetup` and renders nothing without one.
 */
export function oauthClientSetupTarget(entry: CatalogListing): OAuthClientSetupTarget {
  return {
    id: entry.id,
    name: entry.name,
    oauthClientSetup:
      entry.install.kind === "remote-oauth" ? entry.install.oauthClientSetup : undefined,
  };
}

/**
 * One card in the Browse grid. Layout:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ [icon] Connector name                         │
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
  personal,
  configurePath,
  onInstall,
  onSetUp,
}: {
  entry: CatalogListing;
  busy: boolean;
  canManage: boolean;
  /** Whether the directory offers a personal install of this entry; undefined when it never does. */
  personal?: boolean;
  /** Set when the entry is installed in this workspace: its Configure page. */
  configurePath?: string;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  const isStaticAuth = entry.install.kind === "remote-oauth" && entry.install.auth === "static";
  const oauthClientReady = entry.oauthClientConfigured === true;
  // Say it on the card, not once the dialog appears. `oauthClientConfigured` already
  // distinguishes a static-auth entry that is ready from one that is not; this is
  // the same disclosure for the other thing an install can ask for.
  const secretCount = configurePath ? 0 : secretHeaderFields(entry.install).length;

  return (
    <div className="flex flex-col gap-3 p-4 border border-border/60 rounded-sm bg-background h-full">
      <div className={`flex items-start gap-3 ${configurePath ? "opacity-60" : ""}`}>
        <ConnectorIcon name={entry.name} iconUrl={entry.iconUrl} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{entry.name}</div>
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 min-h-8">
            {entry.description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-end justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {secretCount > 0 ? (
            <span className="text-2xs text-muted-foreground border border-border/60 rounded-sm px-1.5 py-0.5">
              {secretCount === 1 ? "Needs a credential" : `Needs ${secretCount} credentials`}
            </span>
          ) : null}
          {personal === false && !configurePath ? (
            // Why there is no "Just me": the server signs in with one account
            // the workspace or operator holds, never a person's own.
            <span className="text-2xs text-muted-foreground">
              Uses one account for the workspace
            </span>
          ) : null}
        </div>
        <CardAction
          busy={busy}
          canManage={canManage}
          personalOffered={personal === true}
          configurePath={configurePath}
          isStaticAuth={isStaticAuth}
          oauthClientReady={oauthClientReady}
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
  personalOffered = false,
  configurePath,
  isStaticAuth,
  oauthClientReady,
  onInstall,
  onSetUp,
}: {
  busy: boolean;
  canManage: boolean;
  /**
   * The install can be for the viewer alone, which needs no workspace write, so
   * a member who may not write the workspace still gets Install.
   */
  personalOffered?: boolean;
  /** Set when the entry is installed in this workspace: its Configure page. */
  configurePath?: string;
  isStaticAuth: boolean;
  oauthClientReady: boolean;
  onInstall: () => void;
  onSetUp: () => void;
}) {
  // Outline rather than filled: a grid of 30+ buttons reads as noise with a
  // bold primary fill on every card. The portal URL lives in
  // OAuthClientSetupModal, so no per-card hint is needed here.
  //
  // Static-auth flow:
  //   - not configured + admin     → Set up
  //   - not configured + non-admin → "Needs an OAuth client"
  //   - configured                 → Install (rotation lives on Configure now)
  //
  // Installed comes first, for every role: it is a fact about the workspace,
  // not an action, so a member sees it too and no setup state outranks it.
  // Where a personal install is offered, the viewer can still add their own
  // beside the workspace's, so the action stays.
  if (configurePath) {
    return (
      <div className="flex items-center gap-3">
        <Link to={configurePath} className="text-xs text-muted-foreground hover:underline">
          Configure
        </Link>
        {personalOffered ? (
          <Button type="button" variant="outline" size="sm" onClick={onInstall} disabled={busy}>
            Install for me
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled>
            <Check />
            Installed
          </Button>
        )}
      </div>
    );
  }
  if (isStaticAuth && !oauthClientReady) {
    return canManage ? (
      <Button type="button" variant="outline" size="sm" onClick={onSetUp}>
        Set up
      </Button>
    ) : (
      <span className="text-xs text-muted-foreground">Needs an OAuth client</span>
    );
  }
  // Every remaining path is an install, and installing is a workspace-scoped
  // write — `workspaceInstallAdmission` refuses a non-admin with "Workspace
  // admin role required to install connectors." An enabled button would move
  // that refusal to after the click. One gated return covers every install
  // path, so a new one can't miss the gate by being added elsewhere. A personal
  // install is the one install that writes nothing of the workspace's but the
  // viewer's own grant, so it opens the gate; the choice that follows offers
  // "Everyone here" only under the same `canManage`.
  return canManage || personalOffered ? (
    <Button type="button" variant="outline" size="sm" onClick={onInstall} disabled={busy}>
      {busy ? (
        <>
          <Loader2 className="animate-spin" />
          Installing…
        </>
      ) : (
        "Install"
      )}
    </Button>
  ) : (
    <span className="text-xs text-muted-foreground">Workspace admin required</span>
  );
}
