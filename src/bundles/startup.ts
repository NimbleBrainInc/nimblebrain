import { composioTransportConfig } from "../connectors/providers/composio/transport-credential.ts";
import type { EventSink } from "../engine/types.ts";
import type { HostResourcesRateLimit, HostResourcesResolver } from "../host-resources/index.ts";
import { resolveUserDisplayName } from "../identity/user.ts";
import { fleetIssuerOption } from "../oauth/fleet-assertion.ts";
import { mcpAuthCallbackUrl } from "../oauth/mcp-callback-url.ts";
import { isMintedFleetSource } from "../oauth/minted-credential-provider.ts";
import { log } from "../observability/log.ts";
import { FileCredentialStore } from "../tools/credential-store.ts";
import { personalConnectorWireName } from "../tools/identity-sources.ts";
import { type BundleMcpContext, McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  WorkspaceOAuthProvider,
  type WorkspaceOAuthProviderOptions,
} from "../tools/workspace-oauth-provider.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { resolveWorkspaceDisplayName } from "../workspace/workspace-store.ts";
import { bundleHasStaticAuth } from "./bundle-auth.ts";
import { defaultWorkDir, deriveServerName, validateServerName } from "./paths.ts";
import { notifyConnectionRunning } from "./pending-auth-buffer.ts";
import type { BundleRef, RemoteTransportConfig, StartBundleResult } from "./types.ts";
import { validateBundleUrl } from "./url-validator.ts";

/**
 * Per-spawn host-resources deps. Callers (lifecycle, workspace-ops) thread
 * these in when they know the workspace; `startBundleSource` composes the
 * full `BundleMcpContext` for each spawned source by adding the source name
 * as `bundleId`.
 *
 * Absent for in-process platform sources (which don't go through
 * `startBundleSource` anyway) and for paths that don't yet plumb the
 * deps (boot reload, connector eager-start — follow-up).
 */
export interface BundleMcpDeps {
  workspaceId: string;
  hostResources: HostResourcesResolver;
  rateLimit: HostResourcesRateLimit;
}

/**
 * Compose the per-source `BundleMcpContext` from the deps captured at
 * the workspace level plus the resolved source name. Exported so call
 * sites that construct an `McpSource` directly (the lifecycle's
 * on-demand source reconstruction) use the same four-field shape.
 */
export function composeBundleMcpContext(
  deps: BundleMcpDeps | undefined,
  sourceName: string,
): BundleMcpContext | undefined {
  if (!deps) return undefined;
  return {
    workspaceId: deps.workspaceId,
    bundleId: sourceName,
    hostResources: deps.hostResources,
    rateLimit: deps.rateLimit,
  };
}

/**
 * Reconcile the three workspace-identity inputs `startBundleSource` accepts:
 *
 *   1. `workspaceContext` (preferred) — typed handle, owns wsId + workDir.
 *   2. `wsId` + `workDir` (legacy) — separate fields the old callers pass.
 *   3. Neither (URL/local-path bundles without OAuth and without user_config).
 *
 * Returns a single `WorkspaceContext` (or undefined when no workspace is
 * in play). If both forms are passed, they must agree — otherwise we
 * silently pick one and the credential boundary becomes ambiguous, which
 * is the exact failure mode this whole refactor is meant to eliminate.
 */
function resolveWorkspaceContext(
  opts:
    | {
        workspaceContext?: WorkspaceContext;
        wsId?: string;
        workDir?: string;
      }
    | undefined,
): WorkspaceContext | undefined {
  if (!opts) return undefined;
  if (opts.workspaceContext) {
    if (opts.wsId !== undefined && opts.wsId !== opts.workspaceContext.workspaceId) {
      throw new Error(
        `[bundles] startBundleSource opts.wsId="${opts.wsId}" disagrees with ` +
          `opts.workspaceContext.workspaceId="${opts.workspaceContext.workspaceId}" — ` +
          `pass workspaceContext alone, or drop wsId.`,
      );
    }
    if (opts.workDir !== undefined && opts.workDir !== opts.workspaceContext.workDir) {
      throw new Error(
        `[bundles] startBundleSource opts.workDir disagrees with ` +
          `opts.workspaceContext.workDir — pass one form or the other.`,
      );
    }
    return opts.workspaceContext;
  }
  if (opts.wsId) {
    const workDir = opts.workDir ?? defaultWorkDir();
    return new WorkspaceContext({ wsId: opts.wsId, workDir });
  }
  return undefined;
}

/** Options accepted by `startBundleSource`. */
interface StartBundleOpts {
  allowInsecureRemotes?: boolean;
  /**
   * Keep a URL source REGISTERED (unstarted, `down`) when `start()` fails,
   * instead of leaving the registry without it. Off by default: a deliberate
   * reconnect / install flow wants `hasSource()` to answer "no" after a failed
   * start, because the caller is about to report that failure to a user who is
   * watching.
   *
   * The boot loop is the opposite case and opts in. An installed bundle whose
   * endpoint merely happened to be unreachable during startup is not gone, and
   * an absent source is invisible to every surface that enumerates the registry
   * — the agent's tool list, `nb__status`, `HealthMonitor`, and the
   * `nb_bundle_unhealthy` gauge. That combination is a trap: the one path that
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
   * rejected credential is retained too. That is deliberate but worth stating,
   * because it drops a brake: the old `removeSource` set `stopped`, which is what
   * made `HealthMonitor` treat the source as terminal. Retained sources instead
   * get its exponential-backoff bursts followed by the slow re-probe cooldown,
   * which is what bounds the cost of a source that will not come back on its own.
   * Classifying the failure here to keep only "retryable" ones was tried and
   * removed: a 401 arrives as a `ServerError`, not `UnauthorizedError`, so the
   * gate missed the common shape while implying a protection it did not provide.
   */
  keepRegisteredOnStartFailure?: boolean;
  /**
   * AbortSignal threaded into the OAuth provider's outbound fetches (the
   * redirect-probe / discovery / DCR chain). A give-up path — a `startAuth`
   * timeout — aborts it so the background start fails fast instead of lingering
   * for the network deadline. Threaded on the identity (`{type:"user"}`) arm of
   * the URL-bundle path; boot-start (the workspace arm) never sets it.
   */
  abortSignal?: AbortSignal;
  /**
   * Identity owner for a personal connector. When set, the URL bundle's OAuth
   * credentials bind to the user (the `WorkspaceOAuthProvider` `{type:"user"}`
   * arm) and live at `users/<userId>/credentials/mcp-oauth/<serverName>/`,
   * outside any workspace. Mutually exclusive with `workspaceContext` / `wsId`
   * — a personal connector belongs to no workspace — so it relies on
   * `workDir` (defaulted) rather than a workspace context for the path root.
   *
   * Honored ONLY on the URL-bundle path (a personal connector is a remote MCP
   * connection). A named/local ref ignores it and falls through to the
   * workspace path — the caller (`getIdentityConnectorSource`) already gates on
   * `"url" in ref`, so this is a documentation guard against a future caller,
   * not a live case.
   */
  identityOwner?: { userId: string };
  dataDir?: string;
  /**
   * Workspace context for credential resolution and on-disk path
   * derivation. Preferred over the legacy `wsId` + `workDir` pair —
   * carries both fields plus the credential store and is validated
   * once at construction. When provided, `wsId` and `workDir` MUST be
   * omitted or match (the function asserts consistency); the context
   * wins.
   */
  workspaceContext?: WorkspaceContext;
  /**
   * Workspace id for credential resolution. Required for named bundles — the
   * named-bundle path resolves `user_config` via `resolveUserConfig` which is
   * workspace-scoped by design. Unused for URL and local-path bundles, which
   * don't go through `prepareServer` for `user_config`.
   *
   * @deprecated Pass `workspaceContext` instead. Kept for incremental
   * migration; see a follow-up migration.
   */
  wsId?: string;
  /**
   * Work directory for credential resolution. Defaults to `NB_WORK_DIR` or
   * `~/.nimblebrain` — the same default the named-bundle branch already uses
   * for `bundleDataDir`.
   *
   * @deprecated Pass `workspaceContext` instead.
   */
  workDir?: string;
  /**
   * Optional callback fired when a URL bundle's OAuth provider determines
   * the flow requires a real browser. Threaded into
   * `WorkspaceOAuthProvider`; receivers typically transition the bundle's
   * Connection to `pending_auth` and emit a `connection.state_changed`
   * SSE event so the UI banner appears. No-op for non-URL bundles.
   */
  onInteractiveAuthRequired?: (authorizationUrl: string) => void;
  /**
   * Optional callback fired when an established connection loses its
   * authorization mid-session — a tool call threw `UnauthorizedError`
   * because the persisted refresh token was rejected. Threaded into
   * `WorkspaceOAuthProvider`; receivers transition the Connection to
   * `reauth_required` (the documented `running → reauth_required` step) so
   * the UI offers "Reconnect". No-op for non-URL bundles.
   */
  onAuthLost?: () => void;
  /**
   * Per-workspace host-resources deps. When present, the spawned
   * McpSource registers inbound handlers for
   * `ai.nimblebrain/resources/{read,list}` so the bundle can read
   * workspace files through the platform. Workspace-id-bearing
   * caller provides the resolver + rate-limit shared across all
   * bundles in this workspace; the source-name (composed inside
   * this function) supplies the `bundleId` half of the rate-limit
   * + audit key.
   */
  bundleMcp?: BundleMcpDeps;
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
function warnUnrecognizedUrlAuthType(ref: BundleRef, serverName: string): void {
  // Diagnostic (NOT back-compat): name the cause when a url source declares a
  // transport.auth.type the runtime doesn't recognize — otherwise it silently
  // gets no credential and 401s. The likeliest case is a config that predates
  // the provider-auth migration (e.g. the retired `tenant-key`).
  const declaredAuthType = ref.transport?.auth?.type;
  if (declaredAuthType && !["bearer", "header", "none", "provider"].includes(declaredAuthType)) {
    log.warn(
      `[bundles] source "${serverName}" declares an unrecognized transport.auth.type="${declaredAuthType}" ` +
        "(known: bearer, header, none, provider). No credential will be attached and the source will likely 401 — " +
        "if this config predates the provider-auth migration, re-register the source.",
    );
  }
}

/**
 * Resolve a URL bundle's pre-registered OAuth client (Track A), dereferencing
 * the client secret from the workspace credential store when present. Returns
 * undefined when the bundle has no static client config (DCR path).
 */
async function resolveStaticOAuthClient(
  ref: BundleRef,
  wsId: string,
  workDir: string,
): Promise<WorkspaceOAuthProviderOptions["staticClient"] | undefined> {
  // Track A: resolve pre-registered client config when present. The
  // oauthClient.clientSecret is a reference into the workspace
  // credential store; we resolve it to a string here so the provider
  // can stamp it into clientInformation()'s response. The catalog
  // boundary already enforced that the secret reference is well-
  // formed; here we just dereference it. Errors abort the boot of
  // this bundle (the connection enters dead) — user can fix the
  // credential and restart.
  if (!ref.oauthClient) return undefined;
  let resolvedSecret: string | undefined;
  if (ref.oauthClient.clientSecret) {
    const secretStore = new FileCredentialStore(workDir);
    const wrapped = await secretStore.get(wsId, ref.oauthClient.clientSecret.key);
    if (!wrapped) {
      throw new Error(
        `[bundles] OAuth client_secret not found at credential key "${ref.oauthClient.clientSecret.key}" — ` +
          `configure it in the workspace's Connections settings (web UI)`,
      );
    }
    resolvedSecret = wrapped.reveal();
  }
  return {
    clientId: ref.oauthClient.clientId,
    ...(resolvedSecret ? { clientSecret: resolvedSecret } : {}),
    ...(ref.oauthClient.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: ref.oauthClient.tokenEndpointAuthMethod }
      : {}),
  };
}

/**
 * The `{type:"user"}` arm of {@link buildUrlOAuthProvider} — a personal
 * connector's OAuth provider. Credentials live at
 * `users/<userId>/credentials/mcp-oauth/<serverName>/`, derived from `workDir`
 * with no `workspaceContext`. Static-client (non-DCR) resolution is
 * workspace-scoped and not wired for personal connectors here; the DCR /
 * provider auth paths apply.
 */
async function buildUserOAuthProvider(
  ref: BundleRef,
  serverName: string,
  identityOwner: { userId: string },
  opts: StartBundleOpts | undefined,
  onInteractiveAuthRequired: (authorizationUrl: string) => void,
): Promise<WorkspaceOAuthProvider> {
  const workDir = opts?.workDir ?? defaultWorkDir();
  // Human-readable owner for the vendor consent screen ("NimbleBrain (<name>)")
  // in place of the opaque `user:<id>`; mirrors the workspace arm's
  // `resolveWorkspaceDisplayName`. Best-effort — falls back to the id.
  const ownerDisplayName = await resolveUserDisplayName(workDir, identityOwner.userId);
  return new WorkspaceOAuthProvider({
    owner: { type: "user", userId: identityOwner.userId },
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
    serverName,
    workDir,
    callbackUrl: mcpAuthCallbackUrl(),
    allowInsecureRemotes: opts?.allowInsecureRemotes === true,
    headlessAuthProbe: ref.headlessAuthProbe === true,
    ...fleetIssuerOption(),
    onInteractiveAuthRequired,
    ...(opts?.onAuthLost ? { onAuthLost: opts.onAuthLost } : {}),
    ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(ref.scopes ? { scopes: ref.scopes } : {}),
    ...(ref.additionalAuthorizationParams
      ? { additionalAuthorizationParams: ref.additionalAuthorizationParams }
      : {}),
  });
}

/**
 * Build the OAuth provider for a URL bundle, or `undefined` when it carries
 * static auth (no OAuth). Owner-generic: an `opts.identityOwner` yields the
 * `{type:"user"}` arm (credentials under `users/<userId>/…`, see
 * {@link buildUserOAuthProvider}); otherwise a `wsContext` is REQUIRED and yields
 * the workspace-scoped provider (tokens under
 * `workspaces/<wsId>/credentials/mcp-oauth/<serverName>/`). The workspace id is
 * never defaulted — a silent `ws_default` fallback would pool OAuth tokens across
 * tenants.
 */
export async function buildUrlOAuthProvider(
  ref: BundleRef,
  serverName: string,
  wsContext: WorkspaceContext | undefined,
  opts: StartBundleOpts | undefined,
  onInteractiveAuthRequired: (authorizationUrl: string) => void,
): Promise<WorkspaceOAuthProvider | undefined> {
  // Attach an OAuthClientProvider only when no static auth is configured.
  if (bundleHasStaticAuth(ref)) return undefined;

  // Personal connector (identity owner): OAuth credentials bind to the user, at
  // users/<userId>/credentials/mcp-oauth/<serverName>/ — the {type:"user"} arm,
  // outside any workspace. Mutually exclusive with the workspace branch below.
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
      `[bundles] URL bundle "${serverName}" without static auth requires opts.workspaceContext ` +
        "(or the legacy opts.wsId) — OAuth credentials are workspace-scoped and silent defaults " +
        "would cross tenants. Thread workspaceContext through installRemote() or the caller " +
        "that invoked startBundleSource().",
    );
  }
  const wsId = wsContext.workspaceId;
  const workDir = wsContext.workDir;
  // Resolve the OAuth callback through the single source of truth
  // (bouncer-aware). Boot-start MUST register the same redirect_uri the
  // interactive `initiate` flow uses — otherwise the provider's DCR
  // drift check discards client.json, re-registration mints a new
  // client_id, and the stored refresh token is orphaned (silent refresh
  // then fails and the bundle falls into a headless interactive flow
  // that times out at boot). See src/oauth/mcp-callback-url.ts.
  const callbackUrl = mcpAuthCallbackUrl();
  // Startup warning when a URL-ref bundle is being wired with no externally
  // reachable origin and no bouncer — the callback resolved to localhost.
  // Only safe for local dev; in prod the authorization server would get a
  // redirect_uri pointing at the pod's localhost. One log per process.
  if (callbackUrl.startsWith("http://localhost")) {
    log.warn(
      `[bundles] public origin not configured; OAuth callback defaults to ${callbackUrl}. ` +
        "In production (NB behind a proxy / on a different host from the user's browser), " +
        "set the custom domain / platform host so publicOrigin() resolves to the externally " +
        "reachable URL.",
    );
  }

  const staticClient = await resolveStaticOAuthClient(ref, wsId, workDir);

  // Boot path is workspace-scope only — user-scope bundles aren't
  // started at boot (they're loaded into a workspace's registry
  // on-demand when their user enters the workspace, see lifecycle).
  // Human-readable workspace name for the vendor consent screen in
  // place of the opaque wsId; best-effort, falls back to the id.
  const ownerDisplayName = await resolveWorkspaceDisplayName(workDir, wsId);
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId },
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
    serverName,
    workDir,
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
  ref: BundleRef,
): Promise<StartBundleResult> {
  const tools = await source.tools();
  // Evict a dead squatter rather than skipping: a retained boot-failed source
  // under this name would otherwise keep routing while this live one is dropped.
  // A `false` return means a LIVE source already holds the name — a concurrent
  // start won the race. This one connected and is now unreachable by name, so
  // stop it rather than leaking its transport.
  if (!(await registry.adoptSource(source))) {
    log.warn(
      `[bundles] ${sourceName} lost a registration race to a live source; stopping the duplicate`,
    );
    await source.stop();
  }
  // Notify lifecycle that this Connection finished its OAuth
  // dance and is now running. For URL bundles that went through
  // pending_auth → running (background path after the user
  // completed auth), this transitions the BundleInstance's
  // Connection out of pending_auth and emits the
  // `connection.state_changed` SSE event so the UI banner
  // clears. For headless bundles that succeeded without ever
  // hitting pending_auth, this is just a confirming update.
  if (wsContext) {
    notifyConnectionRunning(wsContext.workspaceId, sourceName);
  }
  log.info(`[bundles] ✓ ${sourceName} ready (${tools.length} tools, remote)`);
  return {
    meta: {
      version: `remote (${tools.length} tools)`,
      ui: ref.ui ?? null,
      briefing: null,
    },
    sourceName,
  };
}

/** Start a remote (URL) bundle source: validate, wire OAuth, race `start()`
 *  against an interactive-auth early return, and register on success or
 *  pending-auth. */
/**
 * The transport config and SSRF posture a persisted ref resolves to.
 *
 * The two decisions travel together deliberately. They were separate reads once,
 * and drifted: the URL gate saw the raw ref while the transport saw the mapped
 * one, so a single ref got two trust verdicts. Deriving both here makes that
 * class of bug unrepresentable, and gives the pair one testable surface.
 *
 *   - **transport** — legacy Composio refs map forward to provider auth.
 *   - **fleetInternal** — the in-cluster plain-HTTP exception, granted only to
 *     the `minted` fleet rail. Provider auth alone does not earn it: a brokered
 *     connector names a provider too, but its URL comes from a vendor response.
 */
export function resolveRefTransport(ref: BundleRef): {
  transportConfig: RemoteTransportConfig | undefined;
  fleetInternal: boolean;
} {
  const transportConfig = composioTransportConfig(ref.transport);
  return { transportConfig, fleetInternal: isMintedFleetSource(transportConfig) };
}

async function startUrlBundleSource(
  ref: BundleRef,
  registry: ToolRegistry,
  eventSink: EventSink,
  wsContext: WorkspaceContext | undefined,
  opts: StartBundleOpts | undefined,
): Promise<StartBundleResult> {
  const serverName = ref.serverName ?? deriveServerName(ref.url);
  validateServerName(serverName);
  const sourceName = serverName;

  warnUnrecognizedUrlAuthType(ref, serverName);

  // SSRF protection: validate URL before connecting. Provider-auth sources are
  // the operator-provisioned fleet rail — the `minted` credential provider,
  // whose URL comes from the vetted catalog entry — so they may reach in-cluster
  // `.svc` services over plain HTTP. See `validateBundleUrl`'s `fleetInternal`
  // path. Keyed on the provider NAME, not on `auth.type === "provider"`: a
  // brokered connector also names a credential provider, but its URL comes from
  // the vendor's API response, so it carries no operator provenance.
  // One derivation feeds both the URL gate and the transport below — see
  // `resolveRefTransport` for why they must not be read separately.
  const { transportConfig, fleetInternal } = resolveRefTransport(ref);
  validateBundleUrl(new URL(ref.url), {
    allowInsecure: opts?.allowInsecureRemotes,
    fleetInternal,
  });
  log.info(`[bundles] Starting remote bundle ${ref.url} as ${sourceName}...`);

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
  // event and the bundle becomes fully usable.
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
    },
    eventSink,
    composeBundleMcpContext(opts?.bundleMcp, sourceName),
    // An identity-owned start is a personal connector, whose wire name carries
    // the marker. Its EVENTS must say so: a consumer that only sees the bare
    // name cannot tell this source apart from a workspace source installed under
    // the same name, and `data.changed` would refetch that unrelated app.
    // Registry lookups keep using the bare `sourceName`.
    opts?.identityOwner ? personalConnectorWireName(sourceName) : undefined,
  );

  // Kick off start() and finalize on completion. The promise's value
  // is the full `StartBundleResult` for the success path; on failure it
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
  // reflects the bundle exists. Tool calls against an unstarted source
  // throw cleanly until start() succeeds.
  const startPromise: Promise<StartBundleResult> = source
    .start()
    .then(() => finalizeUrlSourceStart(source, registry, sourceName, wsContext, ref))
    .catch((err) => {
      log.error(`[bundles] ${sourceName} start failed: ${err}`);
      if (opts?.keepRegisteredOnStartFailure) {
        // Leave it visible and self-healing. Deliberately NOT `removeSource` —
        // that calls `stop()`, which sets the durable `stopped` marker and makes
        // the source terminal to HealthMonitor, so removing it is what would
        // strand a bundle whose endpoint is merely down right now.
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
    // Register the source so the registry reflects the bundle exists.
    // Tool calls against the unstarted source throw cleanly until
    // start() succeeds (which happens after the user completes auth).
    await registry.adoptSource(source);
    // Don't await startPromise — it'll resolve when the user finishes
    // auth (could be minutes). Background-protect against unhandled
    // rejection if start ultimately fails.
    startPromise.catch(() => {});
    return {
      meta: {
        version: "remote (pending auth)",
        ui: ref.ui ?? null,
        briefing: null,
      },
      sourceName,
    };
  }

  // Headless path or already-completed auth. start() succeeded.
  return await startPromise;
}

/**
 * Create and start an `McpSource` for a `BundleRef`, then add it to the
 * registry. Every ref is a remote MCP endpoint: the runtime connects to a URL
 * with a credential. It never downloads, unpacks, or spawns server code.
 */
export async function startBundleSource(
  ref: BundleRef,
  registry: ToolRegistry,
  // Required. The runtime event sink is threaded into the McpSource so
  // task-augmented tool calls can emit `tool.progress` events that reach the
  // SSE broadcast path; the browser side of Synapse `useDataSync` depends on
  // it. Callers without a real sink (rare) must pass `new NoopEventSink()`
  // explicitly — the absence used to be silently valid, which broke live
  // updates across the entire platform.
  eventSink: EventSink,
  opts?: StartBundleOpts,
): Promise<StartBundleResult> {
  // Reconcile workspaceContext / wsId / workDir into a single context for
  // the rest of this function. Callers may pass either form; once
  // the follow-up migration lands, everyone passes workspaceContext.
  const wsContext: WorkspaceContext | undefined = resolveWorkspaceContext(opts);
  return startUrlBundleSource(ref, registry, eventSink, wsContext, opts);
}
