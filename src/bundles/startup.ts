import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../cli/log.ts";
import {
  friendlyMpakConfigError,
  type UserConfigFieldDef,
} from "../config/workspace-credentials.ts";
import type { EventSink } from "../engine/types.ts";
import { FileCredentialStore } from "../tools/credential-store.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import {
  WorkspaceOAuthProvider,
  type WorkspaceOAuthProviderOptions,
} from "../tools/workspace-oauth-provider.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { extractBundleMeta } from "./defaults.ts";
import { filterEnvForBundle } from "./env-filter.ts";
import { validateManifest } from "./manifest.ts";
import { getMpak } from "./mpak.ts";
import { deriveBundleDataDir, deriveServerName, validateServerName } from "./paths.ts";
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
  /** Stable name the platform addresses this bundle by — composes into proxy URLs. */
  serverName: string;
  /** Manifest `_meta` — read for capability declarations (e.g. `ai.nimblebrain/http-proxy`). */
  manifestMeta: Record<string, unknown> | undefined;
  /** Browser-facing origin of the platform (e.g. https://hq.platform.nimblebrain.ai). */
  publicOrigin: string;
}

/**
 * Build the NB_* env vars every bundle subprocess receives.
 *
 * Both spawn paths in this file (registry + local) call this so the contract
 * cannot drift. The previous implementation duplicated this logic inline in
 * only the local branch, which silently broke registry-installed bundles that
 * declared `ai.nimblebrain/http-proxy` — preview URLs came back null with no
 * error in the logs.
 */
export function buildPlatformEnv(ctx: PlatformContext): Record<string, string> {
  const env: Record<string, string> = {};

  if (ctx.workspaceId) {
    env.NB_WORKSPACE_ID = ctx.workspaceId;
  }

  const httpProxyMeta = ctx.manifestMeta?.["ai.nimblebrain/http-proxy"] as
    | { mount?: string }
    | undefined;
  if (httpProxyMeta?.mount && ctx.workspaceId) {
    const mount = String(httpProxyMeta.mount).replace(/^\/+|\/+$/g, "");
    if (mount && !/\//.test(mount)) {
      env.NB_PROXY_PREFIX = `/v1/ws/${ctx.workspaceId}/apps/${ctx.serverName}/${mount}`;
    }
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
    const workDir = opts.workDir ?? process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
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
     * migration; see Task 007 in `.tasks/delegation-model/`.
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
  },
): Promise<StartBundleResult> {
  // Reconcile workspaceContext / wsId / workDir into a single context for
  // the rest of this function. Callers may pass either form; once
  // .tasks/delegation-model/007 lands, everyone passes workspaceContext.
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
      const apiBase = process.env.NB_API_URL;
      // Startup warning when a URL-ref bundle is being wired but NB_API_URL
      // isn't set. Default is only safe for local dev — in prod (NB behind a
      // proxy), the OAuth provider would hand the authorization server a
      // redirect_uri pointing at the pod's localhost, which the user's
      // browser can't reach. One-time log per process is enough.
      if (!apiBase) {
        log.warn(
          `[bundles] NB_API_URL not set; OAuth callback defaults to http://localhost:27247. ` +
            "In production (NB behind a proxy / on a different host from the user's browser), " +
            "set NB_API_URL to the platform's externally reachable URL.",
        );
      }
      const callbackUrl = `${(apiBase ?? "http://localhost:27247").replace(/\/+$/, "")}/v1/mcp-auth/callback`;

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
      authProvider = new WorkspaceOAuthProvider({
        owner: { type: "workspace", wsId },
        serverName,
        workDir,
        workspaceContext: wsContext,
        callbackUrl,
        allowInsecureRemotes: opts?.allowInsecureRemotes === true,
        onInteractiveAuthRequired: wrappedCallback,
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
            httpProxy: null,
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
          httpProxy: null,
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
    // `manage_app uninstall` for every catalog-installed mpak bundle
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

    // Read cached manifest up-front so we can discover the user_config schema
    // and resolve credentials BEFORE prepareServer validates them. The mpak
    // cache is populated during install (see BundleLifecycleManager.installNamed
    // or mpak install), so we expect the manifest to be present here.
    const cachedManifest = mpak.bundleCache.getBundleManifest(ref.name) as BundleManifest | null;
    if (cachedManifest) {
      meta = extractBundleMeta(cachedManifest as unknown as Record<string, unknown>);
      manifest = cachedManifest;
    } else {
      // Same silent-failure shape as the bug this file's helper extraction was
      // written to fix: with no manifest in cache we can't read `_meta`
      // capability declarations, so http-proxy (and any future declaration)
      // gets silently skipped at spawn. Surface it loudly instead of letting
      // operators chase phantom UI bugs.
      log.warn(
        `[bundles] manifest cache miss for ${ref.name} — capability declarations ` +
          "(http-proxy, etc.) will be skipped at spawn. Reinstall the bundle to repopulate.",
      );
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
      serverName: sourceName,
      manifestMeta: cachedManifest?._meta as Record<string, unknown> | undefined,
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
    );
    source = result.source;
    meta = result.meta;
    manifest = result.manifest;
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
     * matches what `manage_app uninstall` looks up; falls back to
     * `deriveServerName(manifest.name)` for legacy installs.
     */
    serverName?: string;
  },
  configDir: string | undefined,
  internalEnv: InternalBundleEnv | undefined,
  dataDirOverride: string | undefined,
  eventSink: EventSink,
  wsId: string | undefined,
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
  // what consumers (manage_app uninstall, lifecycle Map, web routes)
  // look up by.
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

  // Per-bundle data isolation — each bundle gets its own directory under data/
  const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  const bundleDataDir =
    dataDirOverride ?? join(nbWorkDir, "data", deriveBundleDataDir(manifest.name));
  spawnEnv.MPAK_WORKSPACE = bundleDataDir;
  spawnEnv.UPJACK_ROOT = bundleDataDir;

  Object.assign(
    spawnEnv,
    buildPlatformEnv({
      workspaceId: wsId,
      serverName,
      manifestMeta: manifest._meta as Record<string, unknown> | undefined,
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
