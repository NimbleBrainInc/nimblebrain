import { Check, ChevronRight, Loader2, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Plugin } from "../../_generated/platform-schemas/plugins";
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
  listPlugins,
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
import { type CategoryCount, categoryCounts, matchesListing } from "../../lib/catalog-categories";
import { installCompletesWithoutSignIn } from "../../lib/connector-auth-flow.ts";
import { pluginPath, workspacePluginForServer } from "../../lib/plugins";
import { type SecretHeaderField, secretHeaderFields } from "../../lib/secret-headers";
import { cn } from "../../lib/utils";
import { toWsId } from "../../lib/workspace-slug";

type InstallResult = Awaited<ReturnType<typeof installConnector>>;

/**
 * Floor on the "Installing…" state for an install that finishes on this page.
 * A provider install can return in tens of milliseconds, and a button that
 * flips straight to "Installed" reads as a flicker rather than an action.
 * Paths that leave the page (a vendor sign-in) never wait on it.
 */
export const INSTALL_MIN_SPINNER_MS = 400;

/**
 * The address of a person's own connectors. It opens Plugins in the workspace
 * in focus (`ProfilePluginsRedirect`), where they are managed.
 */
export const PERSONAL_CONNECTORS_PATH = "/profile/connectors";

/**
 * The workspace's plugins, or none when there is no workspace or the read
 * fails: without the listing an installed entry still links, by its server name.
 */
async function workspacePlugins(wsId: string | undefined): Promise<Plugin[]> {
  if (!wsId) return [];
  try {
    return (await listPlugins(wsId)).plugins;
  } catch {
    return [];
  }
}

/**
 * Connector directory — what's available to install. Entries not yet in
 * this workspace fill the list; installed ones sit in their own section
 * below, so the directory answers "do we have this already?" without a trip
 * to the Installed tab. Each entry is a row that opens the entry's page
 * (`entryPath`); rows render in two columns once the directory's own
 * container is wide enough, since it renders beside the docked chat.
 *
 * `entryId` renders that page in place of the list: what the entry signs in
 * with, what installing asks for, and Install. The page is the only place an
 * install starts, so every entry installs the same way: one button, with any
 * step it needs first (an OAuth client, a credential, whom it is for) opening
 * from it. The page shares this component's state and dialogs.
 *
 * An install that needs no sign-in finishes on the page, which turns to
 * "Installed" in place. Back on the list, its row reads Installed and keeps
 * its place until the next visit, so nothing jumps out from under the cursor.
 *
 * With `offerPersonal`, an entry that can hold a per-person credential
 * (`personalInstallable`) asks whom the install is for: "Just me" (the
 * default) installs it on the viewer's own account and grants it into this
 * workspace in the same call (ADR-0069), then runs the personal sign-in;
 * "Everyone in <workspace>" is the workspace install below, offered only to a
 * member who may write the workspace and only while the workspace has no
 * install of it. An entry the workspace already has still offers "Just me": a
 * person's own install sits beside the workspace's. An entry that cannot hold
 * a per-person credential is a workspace install, and its row says why.
 */
export function ConnectorDirectory({
  offerPersonal = false,
  entryId,
  entryPath,
}: {
  offerPersonal?: boolean;
  /** The catalog id of the entry whose page to show instead of the list. */
  entryId?: string;
  /** Where an entry's page lives. Every row opens it; installing happens there. */
  entryPath: (entry: CatalogListing) => string;
}) {
  const [entries, setEntries] = useState<CatalogListing[]>([]);
  const [errors, setErrors] = useState<Array<{ file: string; message: string }>>([]);
  const [installed, setInstalled] = useState<InstalledConnector[]>([]);
  // The workspace's plugins, so an installed entry links to its plugin's page.
  const [plugins, setPlugins] = useState<Plugin[]>([]);
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
  // The category the list is narrowed to; null shows every category.
  const [category, setCategory] = useState<string | null>(null);
  const categories = useMemo(() => categoryCounts(entries), [entries]);
  // The entry whose install is asking whom it is for, and whether the workspace
  // already has its own install of it.
  const [audienceEntry, setAudienceEntry] = useState<CatalogListing | null>(null);
  const [audienceWorkspaceInstalled, setAudienceWorkspaceInstalled] = useState(false);
  // The entry whose OAuth client an admin is setting up on the way to installing
  // it: saving the client carries straight on into the install.
  const [setupEntry, setSetupEntry] = useState<CatalogListing | null>(null);
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
  const { slug } = useParams<{ slug: string }>();
  const wsId = slug ? toWsId(slug) : undefined;
  const { workspaces } = useWorkspaceContext();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";

  // Connectors are addressed by the URL slug — install targets whichever
  // workspace the user is currently viewing. A connector's address under it
  // opens the page of the plugin that holds it (`ConnectorPageRedirect`); it
  // serves an install made on this visit, which the listing read on load
  // predates.
  const configureBasePath = `/w/${slug}/settings/connectors`;
  // An installed entry opens its plugin's page, found in the listing.
  const installedPath = (serverName: string): string => {
    const plugin = workspacePluginForServer(plugins, serverName);
    return plugin && slug ? pluginPath(slug, plugin) : `${configureBasePath}/${serverName}`;
  };

  // One fetcher for the page. Stable identity across renders via
  // useCallback so we can wire it both to the mount effect (with
  // cancellation) and the post-modal-save refresh from the same source.
  const fetchDirectory = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        setLoading(true);
        const [dirRes, insRes, pluginsRes] = await Promise.all([
          listDirectory(),
          getInstalledConnectors({ scope: "workspace" }),
          workspacePlugins(wsId),
        ]);
        if (signal?.cancelled) return;
        setEntries(dirRes.entries);
        setErrors(dirRes.errors);
        setInstalled(insRes.installed);
        setPlugins(pluginsRes);
      } catch (err) {
        if (signal?.cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    },
    [wsId],
  );

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
    const matches = (e: CatalogListing) => matchesListing(e, query, category);
    const available: CatalogListing[] = [];
    const installedEntries: Array<{ entry: CatalogListing; serverName: string }> = [];
    for (const entry of entries) {
      if (!matches(entry)) continue;
      const serverName = installedServerName(entry);
      if (serverName && !justInstalled.has(entry.id)) installedEntries.push({ entry, serverName });
      else available.push(entry);
    }
    return { available, installedEntries };
  }, [entries, query, category, installedServerName, justInstalled]);

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
  // dead row on Plugins and nothing to clean up.
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
  // person never finishes it (the connector then reads Not signed in on their
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
    const { authorizationUrl } =
      entry.install.kind === "remote-oauth" && entry.install.auth === "composio"
        ? await initiateComposioIdentityConnect(entry.id, wsId)
        : await initiateIdentityConnect(result.serverName, wsId);
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

  // Whether the directory offers this entry a personal install; undefined when
  // it never does. An entry installed just now for the viewer alone offers no
  // second one.
  const personalFor = (entry: CatalogListing, configurePath: string | undefined) =>
    offerPersonal
      ? Boolean(entry.personalInstallable) && configurePath !== PERSONAL_CONNECTORS_PATH
      : undefined;

  // The entry page's action: the one place an install starts.
  const actionFor = (entry: CatalogListing, configurePath: string | undefined) => {
    // Installed in this workspace, as opposed to installed just now for
    // the viewer alone. The former still offers the viewer's own install.
    const workspaceInstalled =
      configurePath !== undefined && configurePath !== PERSONAL_CONNECTORS_PATH;
    return (
      <EntryAction
        busy={busyId === entry.id}
        canManage={canManage}
        personalOffered={personalFor(entry, configurePath) === true}
        configurePath={configurePath}
        isStaticAuth={entry.install.kind === "remote-oauth" && entry.install.auth === "static"}
        oauthClientReady={entry.oauthClientConfigured === true}
        onInstall={() => onInstallClick(entry, workspaceInstalled)}
        onSetUpAndInstall={() => setSetupEntry(entry)}
      />
    );
  };

  // The entry `entryId` names, and where it is managed if it is installed.
  const pageEntry = entries.find((e) => e.id === entryId);
  const pageConfigurePath = (entry: CatalogListing): string | undefined => {
    const recent = justInstalled.get(entry.id);
    if (recent) return recent;
    const serverName = installedServerName(entry);
    return serverName ? installedPath(serverName) : undefined;
  };

  return (
    <div className="@container/directory space-y-6">
      {!entryId && (
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            data-tour="catalog"
            className="w-full text-sm px-3 py-2 rounded border border-border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <CategoryFilter categories={categories} selected={category} onSelect={setCategory} />
          <CatalogReadErrors errors={errors} />
        </>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : entryId ? (
        <DirectoryEntryPage
          entry={pageEntry}
          action={pageEntry && actionFor(pageEntry, pageConfigurePath(pageEntry))}
        />
      ) : (
        <DirectoryResults
          query={query}
          category={category}
          available={available}
          installedEntries={installedEntries}
          renderCard={(entry, configurePath) => (
            <DirectoryRow
              key={entry.id}
              entry={entry}
              personal={personalFor(entry, configurePath)}
              configurePath={configurePath}
              detailPath={entryPath(entry)}
            />
          )}
          configurePathFor={(entry) => justInstalled.get(entry.id)}
          installedPathFor={installedPath}
        />
      )}

      {setupEntry && (
        <OAuthClientSetupModal
          entry={oauthClientSetupTarget(setupEntry)}
          saveLabel="Save and install"
          // Pre-filling the existing clientId across renders is a v2
          // concern — list_installed doesn't echo the clientId today
          // (intentional: secret-or-not, surfacing identifiers from
          // workspace.json deserves its own response shape). For now
          // the admin re-enters on rotate.
          open={true}
          onClose={() => setSetupEntry(null)}
          onSaved={async () => {
            const entry = setupEntry;
            setSetupEntry(null);
            await fetchDirectory();
            // The client was the first step of the install, not a separate task.
            await onInstall({ ...entry, oauthClientConfigured: true });
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
 * Narrows the list to one category. Built from the categories the catalog's entries
 * state, so it is absent when they state fewer than two: there is nothing to narrow.
 * Choosing the selected category again shows every category.
 */
function CategoryFilter({
  categories,
  selected,
  onSelect,
}: {
  categories: CategoryCount[];
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  if (categories.length < 2) return null;
  const chip = (label: string, count: number | null, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
        active
          ? "border-foreground/20 bg-foreground/10 font-medium text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== null && <span className="tabular-nums text-muted-foreground">{count}</span>}
    </button>
  );
  return (
    <fieldset
      aria-label="Filter by category"
      data-testid="category-filter"
      className="flex flex-wrap gap-1.5"
    >
      {chip("All", null, selected === null, () => onSelect(null))}
      {categories.map(({ name, count }) =>
        chip(name, count, selected === name, () => onSelect(selected === name ? null : name)),
      )}
    </fieldset>
  );
}

/** Catalog files the directory could not read, named so an operator can fix them. */
function CatalogReadErrors({ errors }: { errors: Array<{ file: string; message: string }> }) {
  if (errors.length === 0) return null;
  return (
    <div className="text-xs text-amber-600">
      {errors.map((e) => (
        <div key={e.file}>
          Couldn't read <span className="font-medium">{e.file}</span>: {e.message}
        </div>
      ))}
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
  category,
  available,
  installedEntries,
  renderCard,
  configurePathFor,
  installedPathFor,
}: {
  query: string;
  category: string | null;
  available: CatalogListing[];
  installedEntries: Array<{ entry: CatalogListing; serverName: string }>;
  renderCard: (entry: CatalogListing, configurePath: string | undefined) => ReactNode;
  configurePathFor: (entry: CatalogListing) => string | undefined;
  installedPathFor: (serverName: string) => string;
}) {
  if (available.length === 0 && installedEntries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {query
          ? `No results for "${query}".`
          : category
            ? `Nothing in ${category} is available to this workspace.`
            : "No connectors are available to this workspace."}
      </p>
    );
  }
  return (
    <>
      {available.length > 0 ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 @md/directory:grid-cols-2">
          {available.map((entry) => renderCard(entry, configurePathFor(entry)))}
        </div>
      ) : (
        !query && (
          <p className="text-sm text-muted-foreground">
            {category
              ? `Everything in ${category} is already installed.`
              : "Everything available here is already installed."}
          </p>
        )
      )}
      {installedEntries.length > 0 && (
        <section className="space-y-3 pt-2">
          <h2 className="text-sm font-medium text-muted-foreground">Installed</h2>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 @md/directory:grid-cols-2">
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
 * The entry's logo in a fixed square slot. Catalog logos arrive in every shape
 * (a bare glyph, a wordmark, an icon that is already a tile), so the slot fixes
 * the footprint and keeps every name on the same edge. It draws no frame of its
 * own: a border around a logo that is already a tile reads as a box in a box.
 */
function EntryIcon({ entry, size }: { entry: CatalogListing; size: "row" | "page" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "row" ? "size-10" : "size-14",
      )}
    >
      <ConnectorIcon
        name={entry.name}
        iconUrl={entry.iconUrl}
        className="size-full rounded-lg object-contain text-sm"
      />
    </span>
  );
}

/**
 * One entry in the directory, as a row:
 *
 *   [icon]  Name                                   Installed / >
 *           One-line description
 *           Whose account it uses · Needs a credential
 *
 * The whole row opens the entry's page (the name's link stretches over it),
 * and that page is the only place an install starts, so every entry is
 * installed the same way whatever its sign-in needs. The row says only what
 * helps choose which page to open: whose account the plugin signs in with,
 * whether it needs a credential, and whether it is already installed.
 */
function DirectoryRow({
  entry,
  personal,
  configurePath,
  detailPath,
}: {
  entry: CatalogListing;
  /** Whether the directory offers a personal install of this entry; undefined when it never does. */
  personal?: boolean;
  /** Set when the entry is installed: the page that manages the install. */
  configurePath?: string;
  detailPath: string;
}) {
  const secretCount = configurePath ? 0 : secretHeaderFields(entry.install).length;
  const accountNote = configurePath
    ? null
    : personal === true
      ? "Signs in with your own account"
      : personal === false
        ? // Why there is no "Just me": the server signs in with one account
          // the workspace or operator holds, never a person's own.
          "Uses one account for the workspace"
        : null;

  return (
    <div
      data-testid="directory-entry"
      className="relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/5 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring"
    >
      <EntryIcon entry={entry} size="row" />
      <div className="min-w-0 flex-1">
        <Link
          to={detailPath}
          className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-md"
        >
          {entry.name}
        </Link>
        <p className="truncate text-xs text-muted-foreground">{entry.description}</p>
        {(accountNote || secretCount > 0) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
            {accountNote && <span>{accountNote}</span>}
            {secretCount > 0 && (
              <span className="rounded-sm border border-border/60 px-1.5">
                {secretCount === 1 ? "Needs a credential" : `Needs ${secretCount} credentials`}
              </span>
            )}
          </div>
        )}
      </div>
      {configurePath ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3.5" />
          Installed
        </span>
      ) : (
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
    </div>
  );
}

/**
 * What installing an entry will ask of the person, in the order they meet it.
 * Read from the listing alone, so it is what the install flow will actually
 * do: an OAuth client an admin must set up first, credentials entered before
 * the install, then a sign-in unless the platform or a broker holds the
 * credential. Empty for an install kind the directory cannot run yet.
 */
export function installAsks(entry: CatalogListing): string[] {
  const install = entry.install;
  if (install.kind !== "remote-oauth") return [];
  const asks: string[] = [];
  if (install.auth === "static" && entry.oauthClientConfigured !== true) {
    asks.push("A workspace admin sets up an OAuth client for it first.");
  }
  const fields = secretHeaderFields(install);
  if (fields.length > 0) {
    asks.push(`${fields.map((f) => f.label).join(", ")}, entered before it installs.`);
  }
  if (install.auth === "composio" && install.composio?.authScheme === "API_KEY") {
    asks.push(`An API key for ${entry.name}.`);
  } else if (!installCompletesWithoutSignIn(install.auth)) {
    asks.push(`A sign-in to ${entry.name}, where you approve the access it requests.`);
  } else if (asks.length === 0) {
    asks.push("Nothing more. It connects as soon as it's installed.");
  }
  return asks;
}

/**
 * One entry's page before install, at `/w/:slug/plugins/browse/<catalog id>`.
 * It carries what the row has no room for: whose account the entry uses,
 * what installing will ask for, and the access it requests. The action is the
 * page's one filled button. Everything here is read from the catalog listing,
 * so the page says nothing the install flow will not bear out.
 */
function DirectoryEntryPage({
  entry,
  action,
}: {
  /** Undefined when the directory has no entry by the page's id. */
  entry: CatalogListing | undefined;
  action: ReactNode;
}) {
  if (!entry) {
    return <p className="text-sm text-muted-foreground">This plugin isn't in the directory.</p>;
  }
  const asks = installAsks(entry);
  const scopes = entry.install.kind === "remote-oauth" ? (entry.install.requiredScopes ?? []) : [];
  return (
    <article data-testid="directory-entry-page" className="space-y-8">
      <header className="flex flex-wrap items-center gap-4">
        <EntryIcon entry={entry} size="page" />
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{entry.name}</h1>
          <p className="text-sm text-muted-foreground">{entry.description}</p>
          {entry.category && <p className="text-xs text-muted-foreground">{entry.category}</p>}
        </div>
        <div className="shrink-0">{action}</div>
      </header>

      <EntrySection title="Whose account it uses">
        {entry.personalInstallable
          ? `Install it for just you, and it uses your own ${entry.name} account. Install it for everyone here, and it uses one ${entry.name} account that everyone shares.`
          : `It uses one ${entry.name} account for the whole workspace, not each person's own.`}
      </EntrySection>

      {asks.length > 0 && (
        <EntrySection title="What installing asks for">
          <ul className="list-disc space-y-1 pl-5">
            {asks.map((ask) => (
              <li key={ask}>{ask}</li>
            ))}
          </ul>
        </EntrySection>
      )}

      {scopes.length > 0 && (
        <EntrySection title="Access it requests">
          <div className="flex flex-wrap gap-1.5">
            {scopes.map((scope) => (
              <code key={scope} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                {scope}
              </code>
            ))}
          </div>
        </EntrySection>
      )}
    </article>
  );
}

function EntrySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

/**
 * The entry page's action, the one place an install starts. Exported so the
 * install gate is directly testable: it is the only thing standing between a
 * workspace member and an Install button the server refuses.
 *
 * Every entry offers the same button, Install, whatever its sign-in needs. What
 * an install asks for first (an OAuth client, a credential, whom it is for)
 * opens as a step of that one install, not as a different button. Where the
 * viewer cannot install, the button stays, disabled, with the reason beneath.
 */
export function EntryAction({
  busy,
  canManage,
  personalOffered = false,
  configurePath,
  isStaticAuth,
  oauthClientReady,
  onInstall,
  onSetUpAndInstall,
}: {
  busy: boolean;
  canManage: boolean;
  /**
   * The install can be for the viewer alone, which needs no workspace write, so
   * a member who may not write the workspace still gets Install.
   */
  personalOffered?: boolean;
  /** Set when the entry is installed: the page that manages the install. */
  configurePath?: string;
  isStaticAuth: boolean;
  oauthClientReady: boolean;
  onInstall: () => void;
  /** Install a static-auth entry whose OAuth client is not set up yet: set it up first. */
  onSetUpAndInstall: () => void;
}) {
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
          <InstallButton busy={busy} onClick={onInstall} label="Install for me" />
        ) : (
          <Button type="button" variant="outline" size="lg" disabled>
            <Check />
            Installed
          </Button>
        )}
      </div>
    );
  }
  // A static-auth entry needs the workspace's OAuth client before anyone can
  // sign in. An admin's Install sets it up and carries on into the install; no
  // member can supply it, so naming that blocker beats naming their role.
  if (isStaticAuth && !oauthClientReady) {
    return canManage ? (
      <InstallButton busy={busy} onClick={onSetUpAndInstall} />
    ) : (
      <BlockedInstall reason="Needs an OAuth client" />
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
  if (!canManage && !personalOffered) {
    return <BlockedInstall reason="Workspace admin required" />;
  }
  return <InstallButton busy={busy} onClick={onInstall} />;
}

function InstallButton({
  busy,
  onClick,
  label = "Install",
}: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button type="button" size="lg" onClick={onClick} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Plus />}
      {busy ? "Installing…" : label}
    </Button>
  );
}

/** Install the viewer cannot use, with why beneath it. */
function BlockedInstall({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="lg" disabled>
        <Plus />
        Install
      </Button>
      <span className="text-xs text-muted-foreground">{reason}</span>
    </div>
  );
}
