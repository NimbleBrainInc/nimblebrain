import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../cli/log.ts";
import {
  friendlyMpakConfigError,
  type UserConfigFieldDef,
} from "../config/workspace-credentials.ts";
import type { EventSink } from "../engine/types.ts";
import {
  assertHostCapabilitiesAvailable,
  HostManifestGateError,
  type HostResourcesRateLimit,
  type HostResourcesResolver,
} from "../host-resources/index.ts";
import { fleetIssuerOption } from "../oauth/fleet-assertion.ts";
import { mcpAuthCallbackUrl } from "../oauth/mcp-callback-url.ts";
import { FileCredentialStore } from "../tools/credential-store.ts";
import { type BundleMcpContext, McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import {
  WorkspaceOAuthProvider,
  type WorkspaceOAuthProviderOptions,
} from "../tools/workspace-oauth-provider.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { resolveWorkspaceDisplayName } from "../workspace/workspace-store.ts";
import { extractBundleMeta } from "./defaults.ts";
import { filterEnvForBundle } from "./env-filter.ts";
import { validateManifest } from "./manifest.ts";
import { getMpak } from "./mpak.ts";
import {
  defaultWorkDir,
  deriveBundleDataDir,
  deriveServerName,
  validateServerName,
} from "./paths.ts";
import { notifyConnectionRunning } from "./pending-auth-buffer.ts";
import { resolveLocalBundle } from "./resolve.ts";
import type {
  BundleManifest,
  BundleRef,
  InternalBundleEnv,
  LocalBundleMeta,
  StartBundleResult,
} from "./types.ts";
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
 * the workspace level plus the resolved source name. Exported so the
 * one other call site that constructs an `McpSource` directly
 * (`lifecycle.installRemote`, which doesn't go through this function)
 * uses the same four-field shape.
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
 * Platform-side context every bundle subprocess needs at spawn time,
 * regardless of how it was installed (registry vs. sideloaded local path).
 *
 * Typed deliberately: this is the contract between the platform and a bundle
 * for "what does it know about its host." Adding a field here is the single
 * edit needed to surface a new platform fact to bundles — TypeScript then
 * forces every spawn site to provide it.
 */
export interface PlatformContext {
  /** Workspace this bundle is being spawned for. Undefined outside a workspace. */
  workspaceId: string | undefined;
  /** Browser-facing origin of the platform (e.g. https://hq.platform.nimblebrain.ai). */
  publicOrigin: string;
}

/**
 * Build the NB_* env vars every bundle subprocess receives.
 *
 * Both spawn paths in this file (registry + local) call this so the contract
 * cannot drift.
 */
export function buildPlatformEnv(ctx: PlatformContext): Record<string, string> {
  const env: Record<string, string> = {};

  if (ctx.workspaceId) {
    env.NB_WORKSPACE_ID = ctx.workspaceId;
  }

  if (ctx.publicOrigin) {
    env.NB_PUBLIC_ORIGIN = ctx.publicOrigin;
  }

  return env;
}

/**
 * Resolve the platform's browser-facing origin from process env.
 * Operators set `NB_PUBLIC_ORIGIN` explicitly; ALLOWED_ORIGINS is a best-effort
 * dev fallback. Empty result → bundles simply don't declare host-side CSP entries.
 */
export function resolvePublicOrigin(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return env.NB_PUBLIC_ORIGIN ?? env.ALLOWED_ORIGINS?.split(",")[0]?.trim() ?? "";
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

/** Create and start a McpSource for a BundleRef, then add to registry.
 *  Returns manifest metadata and actual source name for local bundles. */
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
  configDir?: string,
  opts?: {
    allowInsecureRemotes?: boolean;
    internalEnv?: InternalBundleEnv;
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
  },
): Promise<StartBundleResult> {
  // Reconcile workspaceContext / wsId / workDir into a single context for
  // the rest of this function. Callers may pass either form; once
  // the follow-up migration lands, everyone passes workspaceContext.
  const wsContext: WorkspaceContext | undefined = resolveWorkspaceContext(opts);
  if ("url" in ref) {
    const serverName = ref.serverName ?? deriveServerName(ref.url);
    validateServerName(serverName);
    const sourceName = serverName;
    // SSRF protection: validate URL before connecting
    validateBundleUrl(new URL(ref.url), { allowInsecure: opts?.allowInsecureRemotes });
    log.info(`[bundles] Starting remote bundle ${ref.url} as ${sourceName}...`);

    // Attach an OAuthClientProvider when no static auth is configured. The
    // provider is workspace-scoped: tokens and DCR credentials live under
    // <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/.
    //
    // `wsId` is REQUIRED here — not defaulted — to match the named-bundle
    // branch's behavior at the credential boundary. A silent `ws_default`
    // fallback would cause cross-tenant credential leakage: URL bundles
    // installed from different workspaces would share OAuth tokens under
    // the same default id. Callers must thread workspace context through
    // `installRemote` / `startBundleSource`.
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
    const earlyReturn: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    })();
    const wrappedCallback = (authorizationUrl: string) => {
      pendingAuthDetected = true;
      try {
        userCallback?.(authorizationUrl);
      } finally {
        earlyReturn.resolve();
      }
    };

    let authProvider: WorkspaceOAuthProvider | undefined;
    const hasStaticAuth = ref.transport?.auth && ref.transport.auth.type !== "none";
    if (!hasStaticAuth) {
      if (!wsContext) {
        throw new Error(
          `[bundles] URL bundle "${sourceName}" without static auth requires opts.workspaceContext ` +
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

      // Track A: resolve pre-registered client config when present. The
      // oauthClient.clientSecret is a reference into the workspace
      // credential store; we resolve it to a string here so the provider
      // can stamp it into clientInformation()'s response. The catalog
      // boundary already enforced that the secret reference is well-
      // formed; here we just dereference it. Errors abort the boot of
      // this bundle (the connection enters dead) — user can fix the
      // credential and restart.
      let staticClient: WorkspaceOAuthProviderOptions["staticClient"] | undefined;
      if (ref.oauthClient) {
        let resolvedSecret: string | undefined;
        if (ref.oauthClient.clientSecret) {
          const secretStore = new FileCredentialStore(workDir);
          const wrapped = await secretStore.get(wsId, ref.oauthClient.clientSecret.key);
          if (!wrapped) {
            throw new Error(
              `[bundles] OAuth client_secret not found at credential key "${ref.oauthClient.clientSecret.key}" — ` +
                `run \`nb credential set ${wsId} ${ref.oauthClient.clientSecret.key} <value>\` to seed it`,
            );
          }
          resolvedSecret = wrapped.reveal();
        }
        staticClient = {
          clientId: ref.oauthClient.clientId,
          ...(resolvedSecret ? { clientSecret: resolvedSecret } : {}),
          ...(ref.oauthClient.tokenEndpointAuthMethod
            ? { tokenEndpointAuthMethod: ref.oauthClient.tokenEndpointAuthMethod }
            : {}),
        };
      }

      // Boot path is workspace-scope only — user-scope bundles aren't
      // started at boot (they're loaded into a workspace's registry
      // on-demand when their user enters the workspace, see lifecycle).
      // Human-readable workspace name for the vendor consent screen in
      // place of the opaque wsId; best-effort, falls back to the id.
      const ownerDisplayName = await resolveWorkspaceDisplayName(workDir, wsId);
      authProvider = new WorkspaceOAuthProvider({
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
        onInteractiveAuthRequired: wrappedCallback,
        ...(opts?.onAuthLost ? { onAuthLost: opts.onAuthLost } : {}),
        ...(staticClient ? { staticClient } : {}),
        ...(ref.scopes ? { scopes: ref.scopes } : {}),
        ...(ref.additionalAuthorizationParams
          ? { additionalAuthorizationParams: ref.additionalAuthorizationParams }
          : {}),
      });
    }

    const source = new McpSource(
      sourceName,
      {
        type: "remote",
        url: new URL(ref.url),
        transportConfig: ref.transport,
        authProvider,
      },
      eventSink,
      composeBundleMcpContext(opts?.bundleMcp, sourceName),
    );

    // Kick off start() and finalize on completion. The promise's value
    // is the full `StartBundleResult` for the success path; on failure it
    // logs and rethrows so the lifecycle can record the connection as
    // dead. We register the source with the registry from inside the
    // success branch; on failure (transport error, auth never completes)
    // the source is never registered so callers asserting
    // `registry.hasSource()` after a failed startup see the right shape.
    //
    // Pending-auth registration happens later (below): if the early-
    // return signal fires, we register the source so the registry
    // reflects the bundle exists. Tool calls against an unstarted source
    // throw cleanly until start() succeeds.
    const startPromise: Promise<StartBundleResult> = source
      .start()
      .then(async () => {
        const tools = await source.tools();
        if (!registry.hasSource(sourceName)) {
          registry.addSource(source);
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
            type: "plain" as const,
          },
          sourceName,
          manifest: null,
        };
      })
      .catch((err) => {
        log.error(`[bundles] ${sourceName} start failed: ${err}`);
        // Make sure the source isn't left in the registry if start
        // ultimately failed (background pending-auth path could have
        // added it). Best-effort — removeSource is idempotent.
        void registry.removeSource(sourceName).catch(() => {});
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
      if (!registry.hasSource(sourceName)) {
        registry.addSource(source);
      }
      // Don't await startPromise — it'll resolve when the user finishes
      // auth (could be minutes). Background-protect against unhandled
      // rejection if start ultimately fails.
      startPromise.catch(() => {});
      return {
        meta: {
          version: "remote (pending auth)",
          ui: ref.ui ?? null,
          briefing: null,
          type: "plain" as const,
        },
        sourceName,
        manifest: null,
      };
    }

    // Headless path or already-completed auth. start() succeeded.
    return await startPromise;
  }
  const label = "name" in ref ? ref.name : ref.path;
  log.info(`[bundles] Starting ${label}...`);

  let source: ToolSource;
  let meta: LocalBundleMeta | null = null;
  let manifest: BundleManifest | null = null;
  if ("name" in ref) {
    // Honor the canonical-form serverName persisted on the ref by the
    // catalog install path (`slugifyServerName(entry.id)`); fall back
    // to the legacy short slug (`deriveServerName(ref.name)`) for
    // pre-#195 installs whose ref doesn't carry the field. Mirrors the
    // URL-branch pattern below — without this the registered source
    // name would diverge from what install persisted, breaking
    // uninstall for every catalog-installed mpak bundle
    // whose canonical id and package name produce different slugs
    // (e.g. `dev.mpak.nimblebraininc/echo` vs `@nimblebraininc/echo`).
    const serverName = ref.serverName ?? deriveServerName(ref.name);
    validateServerName(serverName);
    const sourceName = serverName;

    // Named bundles are workspace-scoped. The caller must supply
    // `workspaceContext` (or the legacy `wsId`); without it we have no
    // workspace to resolve credentials against and no way to pick a
    // consistent data dir. This throw is the end of the named-bundle
    // path — the platform has a bug if a caller reaches here without a
    // workspace context.
    if (!wsContext) {
      throw new Error(
        `Cannot start ${ref.name}: a workspace ID is required (platform bug — please report).`,
      );
    }

    // Data dir derives from the workspace context. Callers only pass
    // `opts.dataDir` to override for test fixtures. This is the single
    // source of truth for the layout — lifecycle.installNamed,
    // workspace-ops, and workspace-runtime all produce paths matching
    // this derivation, so there is no drift class between "where a bundle
    // gets installed" and "where it spawns when restarted."
    const bundleDataDir =
      opts?.dataDir ?? wsContext.getDataPath("data", deriveBundleDataDir(ref.name));

    const mpakHome = process.env.MPAK_HOME ?? join(homedir(), ".mpak");
    const mpak = getMpak(mpakHome);

    // Warm the mpak cache so the up-front manifest read below is a hit on a
    // cold/first-ever install. Without this, getBundleManifest() returns null
    // the first time a bundle is installed on a pod; meta/manifest stay null,
    // so placement registration AND user_config resolution silently no-op
    // until a process restart re-reads the now-warm cache (#60 — the bundle
    // shows under Connectors but never under Apps). Doing it here, at the one
    // chokepoint every named install/respawn path funnels through (connector
    // UI, installNamed, boot reload, JIT), fixes the whole class instead of
    // relying on each caller to pre-warm — a contract callers silently broke.
    //
    // Guard on getBundleManifest (the same manifest.json the read below uses),
    // NOT on loadBundle's own short-circuit: loadBundle keys its no-op on a
    // separate .mpak-meta.json, so a manifest-only cache (offline-warm starts,
    // test fixtures) would wrongly trigger a network pull. Skipping when the
    // manifest is already on disk keeps warm boots and offline starts
    // network-free, exactly as today; prepareServer re-reads and re-validates.
    if (!mpak.bundleCache.getBundleManifest(ref.name)) {
      await mpak.bundleCache.loadBundle(ref.name);
    }

    // Read cached manifest up-front so we can discover the user_config schema
    // and resolve credentials BEFORE prepareServer validates them. The warm
    // step above guarantees the manifest is present here on every path that
    // can reach the registry; a miss now means a genuinely unexpected state.
    let cachedManifest = mpak.bundleCache.getBundleManifest(ref.name) as BundleManifest | null;
    if (cachedManifest) {
      meta = extractBundleMeta(cachedManifest as unknown as Record<string, unknown>);
      manifest = cachedManifest;
    } else {
      // With no manifest in cache we can't read `_meta` capability
      // declarations, so host_capabilities gets silently skipped at spawn.
      // Surface it loudly instead of letting operators chase phantom UI bugs.
      //
      // The cache-warm step above (#60) closes the common cause of this —
      // a cold first-install no longer reaches here, since the warm either
      // populates the manifest or throws on a truly cold + offline cache.
      // Reaching this branch now means an unexpected state (e.g. the cache
      // dir was wiped between the warm and this read), not the normal
      // first-install path. We still fall through rather than fail-closed:
      // refusing the spawn would break workspaces that were valid before a
      // restart, and the terminal host-capability gate below re-checks the
      // manifest once prepareServer has re-populated it.
      log.warn(
        `[bundles] manifest cache miss for ${ref.name} — capability declarations ` +
          "(host_capabilities, etc.) will be skipped at spawn, including " +
          "the install-time host-resources gate. Reinstall the bundle to repopulate.",
      );
    }

    // Boot / re-spawn self-heal for the name-only mpak cache. The cache dir is
    // keyed by bundle name with no version, so a pod that cached a bad version
    // re-spawns it on every boot — and if that manifest fails the host-manifest
    // gate, the bundle is rejected forever even after a fixed version ships
    // (the manual workaround was deleting the cache dir on the pod + restart).
    // Detect the gate failure here, against the cached manifest, and force ONE
    // re-pull from the registry so a published fix self-heals on restart. This
    // sits before prepareServer so the fresh artifact is what gets spawned, and
    // covers every named re-spawn path (boot reload, JIT install, configure-
    // restart) since they all funnel through here. We do NOT re-assert the gate
    // after refreshing — the terminal gate below (post-prepareServer) re-runs on
    // the refreshed manifest and throws for real if the latest published
    // version is still invalid.
    if (cachedManifest) {
      try {
        assertHostCapabilitiesAvailable(cachedManifest, cachedManifest.name);
      } catch (err) {
        if (!(err instanceof HostManifestGateError)) throw err;
        log.warn(
          `[bundles] ${ref.name} failed the host-manifest gate from cache ` +
            `(${err.reason}); force-refreshing from the registry and retrying.`,
        );
        try {
          await mpak.bundleCache.loadBundle(ref.name, { force: true });
          const refreshed = mpak.bundleCache.getBundleManifest(ref.name) as BundleManifest | null;
          if (refreshed) {
            cachedManifest = refreshed;
            meta = extractBundleMeta(refreshed as unknown as Record<string, unknown>);
            manifest = refreshed;
          }
        } catch (refreshErr) {
          // Registry unreachable or pull failed: leave the cached copy intact
          // and fall through. The terminal gate re-throws the original gate
          // error, surfacing the actionable "Refusing to install" message
          // rather than a transient network error — so we're never worse off
          // than skipping the heal entirely.
          const detail = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          log.warn(
            `[bundles] force-refresh of ${ref.name} failed (${detail}); keeping cached copy.`,
          );
        }
      }
    }

    // Read host-side credentials from the workspace credential store. The
    // mpak SDK does the rest of the resolution chain: manifest-declared
    // mcp_config.env aliases (so a bundle with
    // `"NEWSAPI_API_KEY": "${user_config.api_key}"` is satisfied by a host
    // NEWSAPI_API_KEY export) and manifest defaults. Any still-missing
    // required field surfaces as MpakConfigError, which we translate to
    // the familiar `nb config set -w <wsId>` hint.
    const userConfig = await wsContext.getCredentialStore().resolveUserConfig({
      bundleName: ref.name,
      userConfigSchema: cachedManifest?.user_config,
    });

    let server: Awaited<ReturnType<typeof mpak.prepareServer>>;
    try {
      server = await mpak.prepareServer(
        { name: ref.name },
        { workspaceDir: bundleDataDir, userConfig },
      );
    } catch (err) {
      // MpakConfigError (0.5.0+) carries envAliases per missing field,
      // so friendlyMpakConfigError can name `export ANTHROPIC_API_KEY`
      // hints without us threading the manifest through.
      throw friendlyMpakConfigError(err, wsContext.workspaceId);
    }

    // Subprocess env contract is unchanged: NB_WORKSPACE_ID is the
    // bundle-visible workspace id. Derived through the context so the
    // workspace's identity flows through one validated path.
    const platformEnv = buildPlatformEnv({
      workspaceId: wsContext.workspaceId,
      publicOrigin: resolvePublicOrigin(),
    });

    source = new McpSource(
      sourceName,
      {
        type: "stdio",
        spawn: {
          command: server.command,
          args: server.args,
          env: {
            ...server.env,
            ...filterEnvForBundle(process.env as Record<string, string>, undefined, ref.allowedEnv),
            ...(ref.env ?? {}),
            MPAK_WORKSPACE: bundleDataDir,
            UPJACK_ROOT: bundleDataDir,
            ...platformEnv,
          },
          cwd: server.cwd,
        },
      },
      eventSink,
      composeBundleMcpContext(opts?.bundleMcp, sourceName),
    );
  } else {
    const internalEnv = ref.protected && opts?.internalEnv ? opts.internalEnv : undefined;
    const result = buildLocalSource(
      ref,
      configDir,
      internalEnv,
      opts?.dataDir,
      eventSink,
      wsContext?.workspaceId,
      opts?.bundleMcp,
    );
    source = result.source;
    meta = result.meta;
    manifest = result.manifest;
  }

  // Refuse to spawn a bundle whose `host_capabilities` declares required
  // capabilities the platform doesn't advertise. Single chokepoint for
  // every named/local install + re-spawn path: lifecycle install, the
  // hot workspace install (`installBundleInWorkspace`), connector eager-
  // start, configure-restart, boot reload — all reach this point with
  // the manifest loaded but before the subprocess is started, so a
  // refused install never leaves a leaked process behind. URL bundles
  // have `manifest = null` and are skipped (they have no MCPB manifest).
  if (manifest) {
    assertHostCapabilitiesAvailable(manifest, manifest.name);
  }

  await source.start();
  const tools = await source.tools();
  registry.addSource(source);
  log.info(`[bundles] ✓ ${source.name} ready (${tools.length} tools)`);
  return { meta, sourceName: source.name, manifest };
}

/** Build an McpSource from a local bundle path + manifest, extracting UI metadata.
 *  Local bundles are unpacked directories — the SDK's prepareServer({ local }) expects
 *  .mcpb archives, so we handle local paths directly. */
function buildLocalSource(
  ref: {
    path: string;
    env?: Record<string, string>;
    allowedEnv?: string[];
    /**
     * Slugified canonical reverse-DNS form persisted at install time.
     * When present, used as the source name so the registered key
     * matches what uninstall looks up; falls back to
     * `deriveServerName(manifest.name)` for legacy installs.
     */
    serverName?: string;
  },
  configDir: string | undefined,
  internalEnv: InternalBundleEnv | undefined,
  dataDirOverride: string | undefined,
  eventSink: EventSink,
  wsId: string | undefined,
  bundleMcp: BundleMcpDeps | undefined,
): { source: McpSource; meta: LocalBundleMeta; manifest: BundleManifest } {
  const bundleDir = resolveLocalBundle(ref.path, configDir);
  if (!bundleDir) {
    log.warn(`[bundles] Local bundle not found: ${ref.path} (skipping)`);
    throw new Error(`Local bundle not found: ${ref.path}`);
  }

  const manifestPath = join(bundleDir, "manifest.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const result = validateManifest(raw);
  if (!result.valid || !result.manifest) {
    throw new Error(`Invalid manifest in ${ref.path}:\n${result.errors.join("\n")}`);
  }

  const manifest = result.manifest;
  // Mirror the named-bundle branch: honor a persisted ref.serverName
  // (slugified canonical id from install) before falling back to the
  // legacy short slug. Keeps registered source name in lockstep with
  // what consumers (uninstall, lifecycle Map, web routes) look up by.
  const serverName = ref.serverName ?? deriveServerName(manifest.name);
  validateServerName(serverName);
  const mcpConfig = manifest.server.mcp_config;

  let command = mcpConfig.command;
  const args = (mcpConfig.args ?? []).map((arg) =>
    arg.replace(/\$\{__dirname\}/g, resolve(bundleDir)),
  );

  // Resolve user_config placeholders in mcp_config.env against process.env.
  // The named-bundle branch gets this for free from `mpak.prepareServer` which
  // calls the SDK's `gatherUserConfig` (env-alias tier) + `substituteEnvVars`.
  // Local-path bundles don't go through prepareServer, so without this the
  // literal string `${user_config.foo}` would end up as a subprocess env value.
  const resolvedMcpEnv = substituteUserConfigFromEnv(
    mcpConfig.env ?? {},
    manifest.user_config,
    process.env as Record<string, string>,
  );

  const spawnEnv: Record<string, string> = {
    ...filterEnvForBundle(process.env as Record<string, string>, resolvedMcpEnv, ref.allowedEnv),
    ...(ref.env ?? {}),
  };

  // Inject internal auth env for protected default bundles
  if (internalEnv) {
    spawnEnv.NB_INTERNAL_TOKEN = internalEnv.NB_INTERNAL_TOKEN;
    spawnEnv.NB_HOST_URL = internalEnv.NB_HOST_URL;
  }

  // Per-bundle data isolation. Callers (lifecycle install*, workspace-ops,
  // buildProcessInventory) always pass `dataDir` via
  // `resolveBundleDataDirForRef`, which keys the slug on `manifest.name` and
  // anchors on the workspace prefix — the single source of truth that keeps
  // the subprocess's write location aligned with what the briefing collector
  // and seedInstance read from. A missing override here means a new caller
  // skipped the helper; fail loudly rather than silently splitting onto a
  // workspace-agnostic fallback.
  if (!dataDirOverride) {
    throw new Error(
      `[bundles] buildLocalSource: dataDir override required for bundle ${manifest.name} ` +
        `(missing caller — route through resolveBundleDataDirForRef)`,
    );
  }
  spawnEnv.MPAK_WORKSPACE = dataDirOverride;
  spawnEnv.UPJACK_ROOT = dataDirOverride;

  Object.assign(
    spawnEnv,
    buildPlatformEnv({
      workspaceId: wsId,
      publicOrigin: resolvePublicOrigin(),
    }),
  );

  // Python bundles: resolve "python" -> "python3" if needed, build PYTHONPATH
  if (manifest.server.type === "python") {
    if (command === "python") {
      const check = Bun.spawnSync(["which", "python"]);
      if (check.exitCode !== 0) command = "python3";
    }
    const resolvedDir = resolve(bundleDir);
    const pathParts: string[] = [];
    const depsDir = join(resolvedDir, "deps");
    if (existsSync(depsDir)) pathParts.push(depsDir);
    const srcDir = join(resolvedDir, "src");
    if (existsSync(srcDir)) pathParts.push(srcDir);
    if (pathParts.length > 0) {
      const existing = spawnEnv.PYTHONPATH;
      spawnEnv.PYTHONPATH = existing ? `${pathParts.join(":")}:${existing}` : pathParts.join(":");
    }
  }

  const sourceName = serverName;
  const source = new McpSource(
    sourceName,
    {
      type: "stdio",
      spawn: {
        command,
        args,
        env: spawnEnv,
        cwd: resolve(bundleDir),
      },
    },
    eventSink,
    composeBundleMcpContext(bundleMcp, sourceName),
  );

  return {
    source,
    meta: extractBundleMeta(manifest as unknown as Record<string, unknown>),
    manifest,
  };
}

/**
 * Substitute `${user_config.<field>}` placeholders in a bundle's
 * `mcp_config.env` using values reverse-looked-up from `processEnv`.
 *
 * Mirrors the env-alias tier of the mpak SDK's private `gatherUserConfig` +
 * `substituteEnvVars` (see mpak-sdk@0.5.0). The named-bundle branch of
 * `startBundleSource` gets this by calling `mpak.prepareServer`; the local-path
 * branch (`buildLocalSource`) bypasses the SDK, so we replicate the tier here.
 *
 * The reverse-lookup is intentionally narrow: for each declared `user_config`
 * field, we scan `mcp_config.env` for entries whose value references that
 * field via `${user_config.<field>}`, then try the first such env-var name in
 * `processEnv`. A bundle declaring `"ANTHROPIC_API_KEY": "${user_config.anthropic_api_key}"`
 * is satisfied by a host `ANTHROPIC_API_KEY` export.
 *
 * Unresolved placeholders collapse to an empty string — matching the SDK's
 * substitution behavior when a field has no value. Required-field validation
 * is NOT performed here; the bundle subprocess surfaces the concrete error
 * (e.g. Anthropic's 401) which is more actionable than a generic host error.
 */
function substituteUserConfigFromEnv(
  mcpConfigEnv: Record<string, string>,
  userConfigSchema: Record<string, UserConfigFieldDef> | undefined,
  processEnv: Record<string, string>,
): Record<string, string> {
  // Values lookup is gated on having a schema — there's nothing to reverse-lookup
  // without declared fields. An empty map still passes through the regex collapse
  // below so an undeclared `${user_config.foo}` placeholder gets substituted to ""
  // rather than leaking through as a literal string (the bug class this function
  // exists to prevent).
  const values: Record<string, string> = {};
  if (userConfigSchema) {
    for (const fieldKey of Object.keys(userConfigSchema)) {
      const placeholder = `\${user_config.${fieldKey}}`;
      for (const [envVarName, envVarValue] of Object.entries(mcpConfigEnv)) {
        if (envVarValue.includes(placeholder)) {
          const v = processEnv[envVarName];
          if (v !== undefined && v !== "") {
            values[fieldKey] = v;
            break;
          }
        }
      }
    }
  }

  // Regex collapse runs unconditionally so no path produces a literal
  // `${user_config.*}` in the spawn env — undeclared or unresolved fields
  // become empty strings.
  const substituted: Record<string, string> = {};
  for (const [k, v] of Object.entries(mcpConfigEnv)) {
    substituted[k] = v.replace(
      /\$\{user_config\.(\w+)\}/g,
      (_match, fieldKey: string) => values[fieldKey] ?? "",
    );
  }
  return substituted;
}
