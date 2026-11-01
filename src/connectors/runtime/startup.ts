import { oauthClientIdentity } from "../../brand/index.ts";
import type { EventSink } from "../../engine/types.ts";
import type {
  HostResourcesRateLimit,
  HostResourcesResolver,
  ResourceArgumentsResolver,
} from "../../host-resources/index.ts";
import { resolveUserDisplayName } from "../../identity/user.ts";
import { fleetIssuerOption } from "../../oauth/fleet-assertion.ts";
import { mcpAuthCallbackUrl } from "../../oauth/mcp-callback-url.ts";
import { isMintedFleetSource } from "../../oauth/minted-credential-provider.ts";
import { log } from "../../observability/log.ts";
import { personalConnectorWireName } from "../../tools/identity-sources.ts";
import { type ConnectorMcpContext, McpSource } from "../../tools/mcp-source.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import { WorkspaceOAuthProvider } from "../../tools/workspace-oauth-provider.ts";
import type { WorkspaceContext } from "../../workspace/context.ts";
import { resolveWorkspaceDisplayName } from "../../workspace/workspace-store.ts";
import { type CatalogEntriesReader, resolveMintedTransport } from "../catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../catalog/types.ts";
import { connectorHasStaticAuth } from "./connector-auth.ts";
import { inBandAuthErrorsOption } from "./in-band-auth-errors.ts";
import { resolveStaticOAuthClient } from "./oauth-static-client.ts";
import { validateServerName } from "./paths.ts";
import { notifyConnectionRunning } from "./pending-auth-buffer.ts";
import type { ConnectorRef, RemoteTransportConfig, StartConnectorResult } from "./types.ts";
import { validateConnectorUrl } from "./url-validator.ts";

/**
 * Per-spawn host-resources deps. Callers (lifecycle, workspace-ops) thread
 * these in when they know the workspace; `startConnectorSource` composes the
 * full `ConnectorMcpContext` for each spawned source by adding the source name
 * as `connectorId`.
 *
 * Absent for in-process platform sources (which don't go through
 * `startConnectorSource` anyway) and for paths that don't yet plumb the
 * deps (boot reload, connector eager-start — follow-up).
 */
export interface ConnectorMcpDeps {
  workspaceId: string;
  hostResources: HostResourcesResolver;
  rateLimit: HostResourcesRateLimit;
  /** Resolves the `ai.nimblebrain/resource-arguments` a tool declares, in this workspace. */
  resourceArguments?: ResourceArgumentsResolver;
}

/**
 * Compose the per-source `ConnectorMcpContext` from the deps captured at
 * the workspace level plus the resolved source name. Exported so call
 * sites that construct an `McpSource` directly (the lifecycle's
 * on-demand source reconstruction) use the same four-field shape.
 */
export function composeConnectorMcpContext(
  deps: ConnectorMcpDeps | undefined,
  sourceName: string,
): ConnectorMcpContext | undefined {
  if (!deps) return undefined;
  return {
    workspaceId: deps.workspaceId,
    connectorId: sourceName,
    hostResources: deps.hostResources,
    rateLimit: deps.rateLimit,
    ...(deps.resourceArguments ? { resourceArguments: deps.resourceArguments } : {}),
  };
}

/** Options accepted by `startConnectorSource`. */
interface StartConnectorOpts {
  allowInsecureRemotes?: boolean;
  /**
   * The operator catalog. Required to start a minted fleet connector, whose
   * credential settings come from its catalog entry at every start
   * (`resolveRefTransport`); not read for any other connector.
   */
  readCatalog?: CatalogEntriesReader;
  /**
   * Keep a URL source REGISTERED (unstarted, `down`) when `start()` fails,
   * instead of leaving the registry without it. Off by default: a deliberate
   * reconnect / install flow wants `hasSource()` to answer "no" after a failed
   * start, because the caller is about to report that failure to a user who is
   * watching.
   *
   * The boot loop is the opposite case and opts in. An installed connector whose
   * endpoint merely happened to be unreachable during startup is not gone, and
   * an absent source is invisible to every surface that enumerates the registry
   * — the agent's tool list, `nb__status`, `HealthMonitor`, and the
   * `nb_connector_unhealthy` gauge. That combination is a trap: the one path that
   * revives it (`tryRecoverSource`) is reached from a tool-call source-miss, and
   * the model cannot call a tool that was never listed. Registered-and-down is
   * strictly better — the connector is visible, reports honestly, alerts, and
   * HealthMonitor reconnects it on its own schedule.
   *
   * Safe because a failed `start()` runs `cleanupOnStartFailure`, which sets
   * `stopping` but deliberately NOT `stopped` — a failed start is retryable, a
   * teardown is not. Removing the source is what made it terminal, since
   * `removeSource` calls `stop()`. This mirrors the pending-auth branch below,
   * which already registers an unstarted source for the same reason.
   *
   * Applies to EVERY boot failure mode, not only an unreachable endpoint — a
   * rejected credential is retained too. Removing the source would set
   * `stopped`, which is what makes `HealthMonitor` treat a source as terminal.
   * A retained source gets its exponential-backoff bursts followed by the slow
   * re-probe cooldown, unless its connection is `reauth_required`, which the
   * monitor leaves to the user's Reconnect. That brake is the lifecycle's
   * connection state, not a classification here: a 401 arrives as a
   * `ServerError`, not `UnauthorizedError`, so a gate on the error would miss
   * the common shape while implying a protection it does not provide.
   */
  keepRegisteredOnStartFailure?: boolean;
  /**
   * AbortSignal threaded into the OAuth provider's outbound fetches (the
   * redirect-probe / discovery / DCR chain). A give-up path — a `startAuth`
   * timeout — aborts it so the background start fails fast instead of lingering
   * for the network deadline. Threaded on the identity (`{type:"user"}`) arm of
   * the URL-connector path; boot-start (the workspace arm) never sets it.
   */
  abortSignal?: AbortSignal;
  /**
   * Identity owner for a personal connector. When set, the URL connector's OAuth
   * credentials bind to the user (the `WorkspaceOAuthProvider` `{type:"user"}`
   * arm) and live in the credential store at user scope, outside any
   * workspace. `workDir` is the instance work directory that holds the user's
   * records. Mutually exclusive with `workspaceContext` — a personal connector
   * belongs to no workspace.
   *
   * Read by the OAuth-provider step: when set, it takes the user arm and
   * `workspaceContext` is not consulted.
   */
  identityOwner?: { userId: string; workDir: string };
  dataDir?: string;
  /**
   * Workspace context for credential resolution and on-disk path derivation.
   * Required for a connector that opens an OAuth flow — its tokens are
   * workspace-scoped by design.
   */
  workspaceContext?: WorkspaceContext;
  /**
   * Optional callback fired when a URL connector's OAuth provider determines
   * the flow requires a real browser. Threaded into
   * `WorkspaceOAuthProvider`; receivers typically transition the connector's
   * Connection to `pending_auth` and emit a `connection.state_changed`
   * SSE event so the UI banner appears. No-op for non-URL connectors.
   */
  onInteractiveAuthRequired?: (authorizationUrl: string) => void;
  /**
   * Optional callback fired when an established connection loses its
   * authorization mid-session — a tool call threw `UnauthorizedError`
   * because the persisted refresh token was rejected. Threaded into
   * `WorkspaceOAuthProvider`; receivers transition the Connection to
   * `reauth_required` (the documented `running → reauth_required` step) so
   * the UI offers "Reconnect". No-op for non-URL connectors.
   */
  onAuthLost?: () => void;
  /**
   * Per-workspace host-resources deps. When present, the spawned
   * McpSource registers inbound handlers for
   * `ai.nimblebrain/resources/{read,list}` so the connector can read
   * workspace files through the platform. Workspace-id-bearing
   * caller provides the resolver + rate-limit shared across all
   * connectors in this workspace; the source-name (composed inside
   * this function) supplies the `connectorId` half of the rate-limit
   * + audit key.
   */
  connectorMcp?: ConnectorMcpDeps;
}

/** A resolvable promise handle: calling `resolve()` settles `promise`. Used to
 *  race an interactive-auth early return against a longer-running `start()`. */
function createDeferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

/** Warn when a URL source declares a `transport.auth.type` the runtime doesn't recognize. */
function warnUnrecognizedUrlAuthType(ref: ConnectorRef, serverName: string): void {
  // Diagnostic (NOT back-compat): name the cause when a url source declares a
  // transport.auth.type the runtime doesn't recognize — otherwise it silently
  // gets no credential and 401s. The likeliest case is a config that predates
  // the provider-auth migration (e.g. the retired `tenant-key`).
  const declaredAuthType = ref.transport?.auth?.type;
  if (declaredAuthType && !["bearer", "header", "none", "provider"].includes(declaredAuthType)) {
    log.warn(
      `[connectors] source "${serverName}" declares an unrecognized transport.auth.type="${declaredAuthType}" ` +
        "(known: bearer, header, none, provider). No credential will be attached and the source will likely 401 — " +
        "if this config predates the provider-auth migration, re-register the source.",
    );
  }
}

/**
 * The `{type:"user"}` arm of {@link buildUrlOAuthProvider} — a personal
 * connector's OAuth provider. Credentials live in the store at user scope,
 * with no `workspaceContext`. A pre-registered (non-DCR) client resolves only
 * when it is an instance OAuth client; a workspace's own client has no workspace
 * to read its secret from here, and `resolveStaticOAuthClient` refuses it.
 */
async function buildUserOAuthProvider(
  ref: ConnectorRef,
  serverName: string,
  identityOwner: { userId: string; workDir: string },
  opts: StartConnectorOpts | undefined,
  onInteractiveAuthRequired: (authorizationUrl: string) => void,
): Promise<WorkspaceOAuthProvider> {
  const { workDir } = identityOwner;
  // Human-readable owner for the vendor consent screen ("<brand> (<name>)")
  // in place of the opaque `user:<id>`; mirrors the workspace arm's
  // `resolveWorkspaceDisplayName`. Best-effort — falls back to the id.
  const ownerDisplayName = await resolveUserDisplayName(workDir, identityOwner.userId);
  const staticClient = await resolveStaticOAuthClient({ ref, serverName });
  return new WorkspaceOAuthProvider({
    clientIdentity: oauthClientIdentity(),
    owner: { type: "user", userId: identityOwner.userId },
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
    serverName,
    callbackUrl: mcpAuthCallbackUrl(),
    allowInsecureRemotes: opts?.allowInsecureRemotes === true,
    headlessAuthProbe: ref.headlessAuthProbe === true,
    ...fleetIssuerOption(),
    onInteractiveAuthRequired,
    ...(opts?.onAuthLost ? { onAuthLost: opts.onAuthLost } : {}),
    ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(staticClient ? { staticClient } : {}),
    ...(ref.scopes ? { scopes: ref.scopes } : {}),
    ...(ref.additionalAuthorizationParams
      ? { additionalAuthorizationParams: ref.additionalAuthorizationParams }
      : {}),
  });
}

/**
 * Build the OAuth provider for a URL connector, or `undefined` when it carries
 * static auth (no OAuth). Owner-generic: an `opts.identityOwner` yields the
 * `{type:"user"}` arm (credentials at user scope, see
 * {@link buildUserOAuthProvider}); otherwise a `wsContext` is REQUIRED and yields
 * the workspace-scoped provider (tokens at that workspace's credential scope).
 * The workspace id is never defaulted — a silent default-workspace fallback would
 * pool OAuth tokens across tenants.
 */
export async function buildUrlOAuthProvider(
  ref: ConnectorRef,
  serverName: string,
  wsContext: WorkspaceContext | undefined,
  opts: StartConnectorOpts | undefined,
  onInteractiveAuthRequired: (authorizationUrl: string) => void,
): Promise<WorkspaceOAuthProvider | undefined> {
  // Attach an OAuthClientProvider only when no static auth is configured.
  if (connectorHasStaticAuth(ref)) return undefined;

  // Personal connector (identity owner): OAuth credentials bind to the user, at
  // user credential scope — the {type:"user"} arm, outside any workspace.
  // Mutually exclusive with the workspace branch below.
  if (opts?.identityOwner) {
    return buildUserOAuthProvider(
      ref,
      serverName,
      opts.identityOwner,
      opts,
      onInteractiveAuthRequired,
    );
  }

  if (!wsContext) {
    throw new Error(
      `[connectors] URL connector "${serverName}" without static auth requires opts.workspaceContext ` +
        "— OAuth credentials are workspace-scoped and silent defaults " +
        "would cross tenants. Thread workspaceContext through the caller that invoked " +
        "startConnectorSource().",
    );
  }
  const wsId = wsContext.workspaceId;
  const workDir = wsContext.workDir;
  // Resolve the OAuth callback through the single source of truth
  // (bouncer-aware). Boot-start MUST register the same redirect_uri the
  // interactive `initiate` flow uses — otherwise the provider's DCR
  // drift check discards client.json, re-registration mints a new
  // client_id, and the stored refresh token is orphaned (silent refresh
  // then fails and the connector falls into a headless interactive flow
  // that times out at boot). See src/oauth/mcp-callback-url.ts.
  const callbackUrl = mcpAuthCallbackUrl();
  // Startup warning when a URL-ref connector is being wired with no externally
  // reachable origin and no bouncer — the callback resolved to localhost.
  // Only safe for local dev; in prod the authorization server would get a
  // redirect_uri pointing at the pod's localhost. One log per process.
  if (callbackUrl.startsWith("http://localhost")) {
    log.warn(
      `[connectors] public origin not configured; OAuth callback defaults to ${callbackUrl}. ` +
        "In production (NB behind a proxy / on a different host from the user's browser), " +
        "set the custom domain / platform host so publicOrigin() resolves to the externally " +
        "reachable URL.",
    );
  }

  const staticClient = await resolveStaticOAuthClient({
    ref,
    wsId,
    serverName,
  });

  // Boot path is workspace-scope only — user-scope connectors aren't
  // started at boot (they're loaded into a workspace's registry
  // on-demand when their user enters the workspace, see lifecycle).
  // Human-readable workspace name for the vendor consent screen in
  // place of the opaque wsId; best-effort, falls back to the id.
  const ownerDisplayName = await resolveWorkspaceDisplayName(workDir, wsId);
  return new WorkspaceOAuthProvider({
    clientIdentity: oauthClientIdentity(),
    owner: { type: "workspace", wsId },
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
    serverName,
    workspaceContext: wsContext,
    callbackUrl,
    allowInsecureRemotes: opts?.allowInsecureRemotes === true,
    headlessAuthProbe: ref.headlessAuthProbe === true,
    // Fleet tenant binding. Safe for every server: the provider only
    // attaches an assertion when the token endpoint's origin matches this
    // issuer (the fleet authorizer), never to a vendor.
    ...fleetIssuerOption(),
    onInteractiveAuthRequired,
    ...(opts?.onAuthLost ? { onAuthLost: opts.onAuthLost } : {}),
    ...(staticClient ? { staticClient } : {}),
    ...(ref.scopes ? { scopes: ref.scopes } : {}),
    ...(ref.additionalAuthorizationParams
      ? { additionalAuthorizationParams: ref.additionalAuthorizationParams }
      : {}),
  });
}

/**
 * Finalize a remote source once `start()` resolves: read its tools, register it
 * (idempotently), notify lifecycle it's running, and shape the success result.
 */
async function finalizeUrlSourceStart(
  source: McpSource,
  registry: ToolRegistry,
  sourceName: string,
  wsContext: WorkspaceContext | undefined,
  ref: ConnectorRef,
): Promise<StartConnectorResult> {
  const tools = await source.tools();
  // Evict a dead squatter rather than skipping: a retained boot-failed source
  // under this name would otherwise keep routing while this live one is dropped.
  // A `false` return means a LIVE source already holds the name — a concurrent
  // start won the race. This one connected and is now unreachable by name, so
  // stop it rather than leaking its transport.
  if (!(await registry.adoptSource(source))) {
    log.warn(
      `[connectors] ${sourceName} lost a registration race to a live source; stopping the duplicate`,
    );
    await source.stop();
  }
  // Notify lifecycle that this Connection finished its OAuth
  // dance and is now running. For URL connectors that went through
  // pending_auth → running (background path after the user
  // completed auth), this transitions the ConnectorInstance's
  // Connection out of pending_auth and emits the
  // `connection.state_changed` SSE event so the UI banner
  // clears. For headless connectors that succeeded without ever
  // hitting pending_auth, this is just a confirming update.
  if (wsContext) {
    notifyConnectionRunning(wsContext.workspaceId, sourceName);
  }
  log.info(`[connectors] ✓ ${sourceName} ready (${tools.length} tools, remote)`);
  return {
    meta: {
      // "remote" is the sentinel for "a remote connector declares no version"; the
      // tool count and the connection state are their own fields, never the version.
      version: "remote",
      ui: ref.ui ?? null,
    },
    sourceName,
  };
}

/**
 * A minted fleet connector the catalog no longer offers. It stays installed and
 * does not start: the catalog entry it binds to is the only source of the
 * credential settings it mints with (`resolveMintedTransport`).
 */
export class FleetConnectorUnavailableError extends Error {
  constructor(
    readonly serverName: string,
    readonly reason: string,
  ) {
    super(`[connectors] "${serverName}" is ${reason}; it stays installed and does not start`);
    this.name = "FleetConnectorUnavailableError";
  }
}

/**
 * The transport config and SSRF posture a persisted ref resolves to.
 *
 * The two decisions travel together deliberately: the URL gate and the
 * transport must judge the same config, so a single ref gets one trust verdict,
 * and the pair has one testable surface.
 *
 *   - **transport** — the ref's persisted transport config, except a minted
 *     fleet connector's `auth`, which comes from the catalog entry it binds to
 *     (`resolveMintedTransport`). Every path that builds a connection from an
 *     installed ref reads it here, so none can mint from the stored copy.
 *   - **fleetInternal** — the in-cluster plain-HTTP exception, granted only to
 *     the `minted` fleet rail. Provider auth alone does not earn it: a brokered
 *     connector names a provider too, but its URL comes from a vendor response.
 *
 * `readCatalog` is required for a minted ref and never read for any other. A
 * minted ref with no reader throws, so a caller cannot skip the catalog by
 * omission; one whose catalog cannot be read, or no longer offers it, throws
 * `FleetConnectorUnavailableError`.
 */
export async function resolveRefTransport(
  ref: ConnectorRef,
  readCatalog?: CatalogEntriesReader,
): Promise<{
  transportConfig: RemoteTransportConfig | undefined;
  fleetInternal: boolean;
}> {
  if (!isMintedFleetSource(ref.transport)) {
    return { transportConfig: ref.transport, fleetInternal: false };
  }
  if (!readCatalog) {
    throw new Error(
      `[connectors] "${ref.serverName}" is a minted fleet connector and was started without ` +
        "the connector catalog; its credential settings come only from the catalog entry it binds to",
    );
  }
  let entries: readonly ConnectorCatalogEntry[] | null;
  try {
    entries = await readCatalog();
  } catch (err) {
    log.warn("[connectors] catalog unreadable; minted fleet connectors cannot start", {
      server: ref.serverName,
      error: err instanceof Error ? err.message : String(err),
    });
    entries = null;
  }
  const resolved = resolveMintedTransport(ref, entries);
  if (resolved.kind === "unavailable") {
    throw new FleetConnectorUnavailableError(ref.serverName, resolved.reason);
  }
  return {
    transportConfig: resolved.transport,
    fleetInternal: isMintedFleetSource(resolved.transport),
  };
}

/**
 * Create and start an `McpSource` for a `ConnectorRef`, then add it to the
 * registry. Every ref is a remote MCP endpoint: the runtime connects to a URL
 * with a credential. It never downloads, unpacks, or spawns server code.
 *
 * Validates the ref, wires OAuth, races `start()` against an interactive-auth
 * early return, and registers the source on success or pending-auth.
 */
export async function startConnectorSource(
  ref: ConnectorRef,
  registry: ToolRegistry,
  // Required. The runtime event sink is threaded into the McpSource so
  // task-augmented tool calls can emit `tool.task_status` and a crashed or
  // restarted source its `connector.health`. Callers without a real sink
  // (rare) must pass `new NoopEventSink()` explicitly, so dropping events is a
  // decision rather than an omission.
  eventSink: EventSink,
  opts?: StartConnectorOpts,
): Promise<StartConnectorResult> {
  const wsContext = opts?.workspaceContext;
  const serverName = ref.serverName;
  validateServerName(serverName);
  const sourceName = serverName;

  warnUnrecognizedUrlAuthType(ref, serverName);

  // SSRF protection: validate URL before connecting. Provider-auth sources are
  // the operator-provisioned fleet rail — the `minted` credential provider,
  // whose URL comes from the vetted catalog entry — so they may reach in-cluster
  // `.svc` services over plain HTTP. See `validateConnectorUrl`'s `fleetInternal`
  // path. Keyed on the provider NAME, not on `auth.type === "provider"`: a
  // brokered connector also names a credential provider, but its URL comes from
  // the vendor's API response, so it carries no operator provenance.
  // One derivation feeds both the URL gate and the transport below — see
  // `resolveRefTransport` for why they must not be read separately.
  const { transportConfig, fleetInternal } = await resolveRefTransport(ref, opts?.readCatalog);
  validateConnectorUrl(new URL(ref.url), {
    allowInsecure: opts?.allowInsecureRemotes,
    fleetInternal,
  });
  log.info(`[connectors] Starting remote connector ${ref.url} as ${sourceName}...`);

  // Wrap the user's onInteractiveAuthRequired callback to also signal an
  // early-return path. Without this, `await source.start()` blocks
  // indefinitely while the user clicks Connect → completes browser auth
  // (could be minutes or never), which would hang both the install API
  // call and the workspace-startup loop. With it, the moment the
  // provider determines interactive auth is needed, the caller's
  // `onInteractiveAuthRequired` fires (lifecycle transitions Connection
  // to pending_auth and emits SSE so the banner appears), AND the
  // function returns early with a placeholder meta. `source.start()`
  // continues in the background; when it eventually resolves (user
  // completed auth), the connection state machine transitions via the
  // existing UnauthorizedError-retry path inside `mcp-source.ts`. The
  // lifecycle observes the eventual `connection.state_changed` running
  // event and the connector becomes fully usable.
  let pendingAuthDetected = false;
  const userCallback = opts?.onInteractiveAuthRequired;
  const earlyReturn = createDeferred();
  const wrappedCallback = (authorizationUrl: string) => {
    pendingAuthDetected = true;
    try {
      userCallback?.(authorizationUrl);
    } finally {
      earlyReturn.resolve();
    }
  };

  const authProvider = await buildUrlOAuthProvider(
    ref,
    serverName,
    wsContext,
    opts,
    wrappedCallback,
  );

  const source = new McpSource(
    sourceName,
    {
      type: "remote",
      url: new URL(ref.url),
      transportConfig,
      allowInsecure: opts?.allowInsecureRemotes === true,
      authProvider,
      ...(authProvider ? await inBandAuthErrorsOption(ref) : {}),
    },
    eventSink,
    composeConnectorMcpContext(opts?.connectorMcp, sourceName),
    // An identity-owned start is a personal connector, whose wire name carries
    // the marker. Its EVENTS must say so: a consumer that only sees the bare
    // name cannot tell this source apart from a workspace source installed under
    // the same name.
    // Registry lookups keep using the bare `sourceName`.
    opts?.identityOwner ? personalConnectorWireName(sourceName) : undefined,
  );

  // Kick off start() and finalize on completion. The promise's value
  // is the full `StartConnectorResult` for the success path; on failure it
  // logs and rethrows so the lifecycle can record the connection as
  // dead. We register the source with the registry from inside the
  // success branch; on failure (transport error, auth never completes)
  // the source is dropped from the registry so callers asserting
  // `registry.hasSource()` after a failed startup see the right shape —
  // unless the caller opted into `keepRegisteredOnStartFailure` (the
  // boot loop; see that option's doc for why the two want opposite
  // answers).
  //
  // Pending-auth registration happens later (below): if the early-
  // return signal fires, we register the source so the registry
  // reflects the connector exists. Tool calls against an unstarted source
  // throw cleanly until start() succeeds.
  const startPromise: Promise<StartConnectorResult> = source
    .start()
    .then(() => finalizeUrlSourceStart(source, registry, sourceName, wsContext, ref))
    .catch((err) => {
      log.error(`[connectors] ${sourceName} start failed: ${err}`);
      if (opts?.keepRegisteredOnStartFailure) {
        // Leave it visible and self-healing. Deliberately NOT `removeSource` —
        // that calls `stop()`, which sets the durable `stopped` marker and makes
        // the source terminal to HealthMonitor, so removing it is what would
        // strand a connector whose endpoint is merely down right now.
        //
        // `isStopped()` guards the race where a teardown (Connect / Disconnect /
        // uninstall) lands while this start is still in flight. Re-adding a
        // deliberately stopped instance would be worse than dropping it: the
        // fresh source's own registration guard skips a taken name, so the
        // stopped orphan would hold the name until the pod restarts. The old
        // `removeSource` converged to absent; `addSource` can diverge, so the
        // PR's own invariant has to be checked rather than assumed —
        // stopped is terminal, stopping is retryable.
        if (!source.isStopped() && !registry.hasSource(sourceName)) {
          registry.addSource(source);
        }
      } else {
        // Make sure the source isn't left in the registry if start
        // ultimately failed (background pending-auth path could have
        // added it). Best-effort — removeSource is idempotent.
        void registry.removeSource(sourceName).catch(() => {});
      }
      throw err;
    });

  // Race start against the early-return signal. If the provider hits
  // the interactive branch, `wrappedCallback` resolves earlyReturn before
  // start() rejects/awaits — earlyReturn.promise wins, we return a
  // placeholder meta, and startPromise continues in the background.
  // (Attach a no-op .catch so a delayed background failure doesn't
  // surface as an unhandled rejection.)
  await Promise.race([
    startPromise.then(() => undefined).catch(() => undefined),
    earlyReturn.promise,
  ]);

  if (pendingAuthDetected) {
    // Register the source so the registry reflects the connector exists.
    // Tool calls against the unstarted source throw cleanly until
    // start() succeeds (which happens after the user completes auth).
    await registry.adoptSource(source);
    // Don't await startPromise — it'll resolve when the user finishes
    // auth (could be minutes). Background-protect against unhandled
    // rejection if start ultimately fails.
    startPromise.catch(() => {});
    return {
      meta: {
        version: "remote",
        ui: ref.ui ?? null,
      },
      sourceName,
    };
  }

  // Headless path or already-completed auth. start() succeeded.
  return await startPromise;
}
