import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../cli/log.ts";
import { cleanupComposioBundle } from "../composio/sdk.ts";
import type { EventSink } from "../engine/types.ts";
import { fleetIssuerOption } from "../oauth/fleet-assertion.ts";
import { mcpAuthCallbackUrl } from "../oauth/mcp-callback-url.ts";
import type { PlacementRegistry } from "../runtime/placement-registry.ts";
import { FileCredentialStore } from "../tools/credential-store.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { WorkspaceOAuthProvider } from "../tools/workspace-oauth-provider.ts";
import { validateAdditionalAuthorizationParams } from "../util/oauth-params.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import type { AutomationDomainContext } from "./automations/src/domain.ts";
import { createAutomation, deleteAutomation } from "./automations/src/domain.ts";
import { connectorSlug, hasPersistedComposioConnection } from "./composio-connection.ts";
import {
  type Connection,
  type ConnectionState,
  summarizeConnectionState,
  WORKSPACE_PRINCIPAL_ID,
} from "./connection.ts";
import { getMpak } from "./mpak.ts";
import { hasPersistedWorkspaceOAuthTokens } from "./oauth-tokens.ts";
import { defaultWorkDir, deriveServerName, resolveBundleDataDirForRef } from "./paths.ts";
import { consumePendingAuth } from "./pending-auth-buffer.ts";
import { type BundleMcpDeps, composeBundleMcpContext, startBundleSource } from "./startup.ts";
import type {
  BriefingBlock,
  BundleInstance,
  BundleManifest,
  BundleRef,
  BundleState,
  BundleUiMeta,
  HostManifestMeta,
  RemoteTransportConfig,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Hard-error on legacy `oauthScope: "user"` records read from disk.
// ---------------------------------------------------------------------------

/**
 * Thrown when a `BundleRef` read from disk carries the legacy
 * `oauthScope: "user"` literal. Stage 2 cut the literal from the schema;
 * the only legal value is `"workspace"`. The cure is the deploy runbook —
 * operators run `bun run migrate:user-creds` before deploying Stage 2.
 *
 * The runtime does NOT translate, normalize, or rewrite legacy data at
 * load. A skipped migration is operator error and surfaces here as a
 * hard boot failure naming the offending record, not a silent in-memory
 * fixup. See
 * the Stage 2 deploy runbook for the
 * operator contract.
 */
export class LegacyOAuthScopeError extends Error {
  readonly serverName: string;
  readonly url: string | undefined;
  constructor(serverName: string, url: string | undefined) {
    super(
      `[lifecycle] bundle "${serverName}" carries legacy oauthScope: "user". ` +
        "Run `bun run migrate:user-creds` before starting the platform. " +
        "See the Stage 2 deploy runbook.",
    );
    this.name = "LegacyOAuthScopeError";
    this.serverName = serverName;
    this.url = url;
  }
}

/**
 * Assert a `BundleRef` read from disk conforms to the post-Stage-2 schema.
 * Throws `LegacyOAuthScopeError` on encounter — does not translate. The
 * deploy runbook is the operator contract; the runtime stays strict.
 */
export function assertBundleRefIsPostStage2(ref: BundleRef): void {
  if (!("url" in ref)) return;
  // Widen to the runtime-disk shape so we can detect a value that
  // JSON.parse left in place but the static type rejects.
  const widened: { oauthScope?: string } = ref as { oauthScope?: string };
  if (widened.oauthScope === "user") {
    throw new LegacyOAuthScopeError(ref.serverName ?? "(unknown)", ref.url);
  }
}

// Connection states that end an OAuth flow's lifetime from the
// coalesce-mutex's perspective. `starting` and `pending_auth` are
// deliberately omitted — they are the in-flight states that the mutex
// exists to coalesce across. Used by `recordConnectionStateChange` to
// release `authFlowsInFlight` slots; see the field comment for the full
// invariant.
const AUTH_FLOW_TERMINAL_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  "running",
  "dead",
  "crashed",
  "stopped",
  "not_authenticated",
  "reauth_required",
]);

/**
 * Single source of truth for the `authFlowsInFlight` Map key. The mutex
 * is keyed on the unique tuple `(serverName, wsId, principalId)` — any
 * caller assembling the key by hand would risk drifting from the
 * canonical shape (extra delimiters, wrong order) and silently breaking
 * the coalesce. One helper, two call sites: the wrapper's set/delete
 * and `recordConnectionStateChange`'s terminal-state delete.
 */
function authFlowKey(serverName: string, wsId: string, principalId: string): string {
  return `${serverName}|${wsId}|${principalId}`;
}

// ---------------------------------------------------------------------------
// BundleLifecycleManager — owns the state of all installed bundles and
// provides the formal install / uninstall / start / stop / restart flows
// described in PRODUCT_SPEC ss3.2-3.4.
// ---------------------------------------------------------------------------

export class BundleLifecycleManager {
  private instances = new Map<string, BundleInstance>();
  private placementRegistry: PlacementRegistry | null = null;
  /**
   * Bundle names with an org-wide upgrade currently in flight, keyed by
   * `bundleName` — `upgradeApp` swaps the app across every workspace at once,
   * so the guard is per-app, not per-(serverName, wsId). Prevents a concurrent
   * double-upgrade, which would `removeSource` then race two `addSource` calls
   * and leave a torn state.
   */
  private upgradesInFlight = new Set<string>();
  /**
   * In-flight OAuth flows, keyed by `${serverName}|${wsId}|${principalId}`.
   *
   * **Invariant: at most one OAuth flow is alive per key at a time.**
   *
   * A flow's lifetime is bounded by the connection state machine, NOT by
   * promise resolution. The slot is set when `startAuth` constructs a fresh
   * flow and cleared from `recordConnectionStateChange` when the connection
   * reaches a terminal state (running / dead / crashed / not_authenticated /
   * reauth_required / stopped). While the slot is held, every subsequent
   * `startAuth` for the same key coalesces — returning the SAME promise the
   * first call returned, so concurrent callers all see the same
   * `authorizationUrl`. No second flow runs, so no second DCR or
   * `startAuthorization` runs, so the shared `verifier.json` and `client.json`
   * on disk are never clobbered mid-flight.
   *
   * This is the structural correctness story for the multi-fire / multi-tab
   * scenarios (UI hammering Connect via a re-render loop; two tabs both
   * clicking Connect simultaneously). Pre-fix, every inbound call started a
   * fresh flow that overwrote disk state — the user's chosen auth URL then
   * exchanged with someone else's verifier and the vendor returned
   * `invalid_code`. Coalescing eliminates the race by collapsing N calls into
   * 1 flow rather than trying to make N flows coexist on shared disk state.
   *
   * Lifetime authority: terminal state transitions in
   * `recordConnectionStateChange`. The `.catch(clear)` in the wrapper is a
   * fallback for pre-state-record sync failures (instance not found, invalid
   * principal) where no state transition will ever fire — without it, those
   * paths would lock the slot forever.
   */
  private authFlowsInFlight = new Map<string, Promise<{ authorizationUrl: string }>>();
  /**
   * Getter for a workspace-scoped automations domain context. Set by
   * Runtime after the automations platform source is constructed. Used
   * by `syncBundleAutomations` / `removeBundleAutomations` to bypass the
   * LLM-facing tool surface — bundle-contributed schedules need to set
   * `source: "bundle"` and `bundleName`, which the LLM-facing schema
   * deliberately doesn't accept. See src/tools/platform/CLAUDE.md § 1.4.
   */
  private getAutomationsCtx: (() => AutomationDomainContext) | null = null;

  /**
   * Factory for per-workspace host-resources deps. Set by Runtime after
   * construction (`setBundleMcpDepsFactory`). When set, every install
   * path threads the matching deps through `startBundleSource` so the
   * spawned bundle's McpSource registers inbound handlers for
   * `ai.nimblebrain/resources/{read,list}`. Null in test/minimal
   * runtimes that don't wire the host-resources subsystem — bundles
   * spawned in that mode can't call host-resources methods (the
   * handlers are never registered).
   */
  private getBundleMcpDeps: ((wsId: string) => BundleMcpDeps) | null = null;

  constructor(
    private eventSink: EventSink,
    private configPath: string | undefined,
    private allowInsecureRemotes = false,
    private mpakHome: string = join(homedir(), ".mpak"),
  ) {}

  /** Set the PlacementRegistry (called by Runtime after construction). */
  setPlacementRegistry(pr: PlacementRegistry): void {
    this.placementRegistry = pr;
  }

  /**
   * Wire the automations domain-context getter. Called by Runtime once
   * the automations platform source is constructed. Until this is set,
   * bundle-contributed schedules will be skipped (with a stderr warning)
   * — useful for minimal test runtimes that don't want the automations
   * subsystem.
   */
  setAutomationsContextGetter(getter: () => AutomationDomainContext): void {
    this.getAutomationsCtx = getter;
  }

  /**
   * Wire the host-resources deps factory. Called by Runtime once the
   * resolver + rate-limit are constructed. When unset, bundles spawn
   * without inbound `ai.nimblebrain/resources/*` handlers registered;
   * any bundle declaring `required: true` already fails the install
   * gate so this is reached only by bundles that don't need the
   * extension.
   */
  setBundleMcpDepsFactory(factory: (wsId: string) => BundleMcpDeps): void {
    this.getBundleMcpDeps = factory;
  }

  /** Internal: resolve the workspace's host-resources deps, or undefined when unwired. */
  private resolveBundleMcpDeps(wsId: string): BundleMcpDeps | undefined {
    return this.getBundleMcpDeps?.(wsId);
  }

  // ---- Queries -----------------------------------------------------------

  /** Get a snapshot of all tracked bundle instances. */
  getInstances(): BundleInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Get a single instance by server name, scoped to a workspace.
   *
   * Checks workspace-scoped key (`name|wsId`) — every lookup must
   * be workspace-scoped to prevent cross-workspace data leakage.
   */
  getInstance(serverName: string, wsId: string): BundleInstance | undefined {
    return this.instances.get(`${serverName}|${wsId}`);
  }

  /** Remove an instance from tracking (workspace-scoped). */
  removeInstance(serverName: string, wsId: string): boolean {
    return this.instances.delete(`${serverName}|${wsId}`);
  }

  // ---- Install -----------------------------------------------------------

  /**
   * Install a named bundle from the mpak registry.
   *
   * Steps (PRODUCT_SPEC ss3.2):
   * 1. mpak install @org/bundle
   * 2. Read manifest from extracted path
   * 3. Detect Upjack metadata
   * 4. Build spawn config, create McpSource, start, register
   * 5. Record trust score from mpak
   * 6. Read UI metadata from _meta["ai.nimblebrain/host"]
   * 7. Write bundle entry to nimblebrain.json atomically
   * 8. Emit bundle.installed event
   */
  async installNamed(
    name: string,
    registry: ToolRegistry,
    wsId: string,
    env?: Record<string, string>,
  ): Promise<BundleInstance> {
    // No cache pre-warm here: startBundleSource warms the mpak cache itself
    // before reading the manifest (see its named-bundle branch, #60), so a
    // cold first-install registers placements without a restart on every
    // path, not just this one.

    // Workspace-scoped data dir keeps two workspaces installing the same
    // bundle from stomping on each other's entity data. Slug source is
    // `manifest.name` via `resolveBundleDataDirForRef` — same call used by
    // the boot-time inventory and the JIT install path, so all three agree.
    const nbWorkDir = defaultWorkDir();
    const wsContext = new WorkspaceContext({ wsId, workDir: nbWorkDir });
    const configDir = this.configPath ? dirname(this.configPath) : undefined;
    const bundleDataDir = resolveBundleDataDirForRef(nbWorkDir, wsId, { name }, configDir);

    const { sourceName, manifest } = await startBundleSource(
      { name, env },
      registry,
      this.eventSink,
      this.configPath ? dirname(this.configPath) : undefined,
      {
        dataDir: bundleDataDir,
        workspaceContext: wsContext,
        bundleMcp: this.resolveBundleMcpDeps(wsId),
      },
    );
    if (!manifest) {
      // Named bundles always have a manifest — startBundleSource reads it
      // from the mpak cache. Null here is a precondition violation.
      throw new Error(`No manifest found for ${name} after install`);
    }

    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    const instance = createInstance(sourceName, name, manifest, isUpjack, wsId, bundleDataDir);
    instance.configKey = name;
    instance.installSource = "registry";
    this.transition(instance, "running");

    instance.trustScore = await fetchTrustScore(name, this.mpakHome);
    instance.ui = extractUiMeta(manifest);
    instance.briefing = extractBriefing(manifest);
    this.registerPlacements(sourceName, instance.ui, wsId);

    if (this.configPath) {
      const entry: Record<string, unknown> = { name };
      if (instance.trustScore != null) entry.trustScore = instance.trustScore;
      if (instance.ui) entry.ui = instance.ui;
      atomicConfigAdd(this.configPath, entry);
    }

    this.instances.set(`${sourceName}|${wsId}`, instance);
    await this.syncBundleAutomations(manifest, name, registry);

    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        wsId,
        serverName: sourceName,
        bundleName: name,
        version: instance.version,
        type: instance.type,
        trustScore: instance.trustScore,
        ui: instance.ui,
        placements: instance.ui?.placements ?? null,
      },
    });

    return instance;
  }

  /**
   * Install a bundle from a local disk path.
   * Same as named install but skips mpak download (PRODUCT_SPEC ss3.2 "From local path").
   */
  async installLocal(
    bundlePath: string,
    registry: ToolRegistry,
    wsId: string,
    env?: Record<string, string>,
  ): Promise<BundleInstance> {
    // Workspace-scoped data dir computed up-front via the canonical helper
    // (slug = manifest.name) so the subprocess's MPAK_WORKSPACE and the
    // seedInstance / briefing reader path agree on a single location.
    // Without this override `buildLocalSource`'s fallback would compose a
    // `<nbWorkDir>/data/<slug>` path that bypasses the workspace prefix
    // and uses a path-derived slug.
    const nbWorkDir = defaultWorkDir();
    const configDir = this.configPath ? dirname(this.configPath) : undefined;
    const bundleDataDir = resolveBundleDataDirForRef(
      nbWorkDir,
      wsId,
      { path: bundlePath },
      configDir,
    );
    const { sourceName, manifest } = await startBundleSource(
      { path: bundlePath, env },
      registry,
      this.eventSink,
      configDir,
      { dataDir: bundleDataDir, bundleMcp: this.resolveBundleMcpDeps(wsId) },
    );
    if (!manifest) {
      // Local bundles always have a manifest.json on disk; startBundleSource
      // reads and validates it before spawning. Null is a precondition
      // violation.
      throw new Error(`No manifest read for local bundle at ${bundlePath}`);
    }

    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    // Use manifest.name (scoped name) as bundleName, not the filesystem path.
    const instance = createInstance(
      sourceName,
      manifest.name,
      manifest,
      isUpjack,
      wsId,
      bundleDataDir,
    );
    instance.configKey = bundlePath; // config entry uses the filesystem path
    instance.installSource = "local";
    this.transition(instance, "running");

    instance.ui = extractUiMeta(manifest);
    instance.briefing = extractBriefing(manifest);
    this.registerPlacements(sourceName, instance.ui, wsId);

    if (this.configPath) {
      const entry: Record<string, unknown> = { path: bundlePath };
      if (instance.ui) entry.ui = instance.ui;
      atomicConfigAdd(this.configPath, entry);
    }

    this.instances.set(`${sourceName}|${wsId}`, instance);
    await this.syncBundleAutomations(manifest, manifest.name, registry);

    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        wsId,
        serverName: sourceName,
        bundleName: bundlePath,
        version: instance.version,
        type: instance.type,
        ui: instance.ui,
        placements: instance.ui?.placements ?? null,
      },
    });

    return instance;
  }

  /**
   * Install a remote MCP server by URL.
   * No mpak download — connects directly via HTTP transport (PRODUCT_SPEC ss15).
   *
   * Connection lifecycle: the BundleInstance is registered up-front with
   * a single `_workspace` Connection in `starting` state. If the OAuth
   * provider needs interactive auth, the
   * `onInteractiveAuthRequired` callback fires synchronously inside
   * `startBundleSource` → the Connection transitions to `pending_auth`
   * and a `connection.state_changed` event broadcasts BEFORE
   * `startBundleSource` returns. (`startBundleSource` itself still
   * blocks on `source.start()` until auth completes; non-blocking install
   * is a follow-up. The UI banner appears the moment we hit
   * `pending_auth`, even though the API caller is still awaiting.)
   *
   * On success: Connection transitions to `running`. On failure: `dead`.
   * The install API caller's `BundleInstance` reflects the post-completion
   * state.
   */
  async installRemote(
    url: string,
    serverName: string,
    registry: ToolRegistry,
    wsId: string,
    transportConfig?: RemoteTransportConfig,
    ui?: BundleUiMeta | null,
    trustScore?: number | null,
  ): Promise<BundleInstance> {
    const nbWorkDir = defaultWorkDir();

    // Pre-register the instance + Connection BEFORE startBundleSource so
    // the interactive-auth callback (fired during source.start()) can find
    // the instance to transition. The lifecycle.recordConnectionStateChange
    // path below would otherwise no-op on a missing instance.
    const instance: BundleInstance = {
      serverName,
      bundleName: url,
      installSource: "remote",
      version: "remote",
      state: "starting",
      trustScore: trustScore ?? null,
      ui: ui ?? null,
      briefing: null,
      protected: false,
      type: "plain",
      wsId,
    };
    this.instances.set(`${serverName}|${wsId}`, instance);
    this.recordConnectionStateChange(serverName, wsId, "_workspace", "starting");

    const onInteractiveAuthRequired = (authorizationUrl: string) => {
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "pending_auth", {
        authorizationUrl,
      });
    };

    // Mid-session auth loss on the running connection (a tool call hit
    // UnauthorizedError because the refresh token was rejected). Flip to
    // reauth_required so the UI offers "Reconnect" instead of failing silently.
    const onAuthLost = () => {
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "reauth_required");
    };

    let sourceName: string;
    let meta: Awaited<ReturnType<typeof startBundleSource>>["meta"];
    try {
      const result = await startBundleSource(
        { url, serverName, transport: transportConfig, ui: ui ?? null },
        registry,
        this.eventSink,
        this.configPath ? dirname(this.configPath) : undefined,
        {
          allowInsecureRemotes: this.allowInsecureRemotes,
          wsId,
          workDir: nbWorkDir,
          onInteractiveAuthRequired,
          onAuthLost,
          bundleMcp: this.resolveBundleMcpDeps(wsId),
        },
      );
      sourceName = result.sourceName;
      meta = result.meta;
    } catch (err) {
      // Auth flow rejected, transport unavailable, etc. Transition the
      // pre-registered Connection to dead so the UI updates and the
      // bundle isn't left stuck in starting/pending_auth.
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "dead", {
        lastError: err instanceof Error ? err.message : String(err),
      });
      this.instances.delete(`${serverName}|${wsId}`);
      throw err;
    }

    instance.serverName = sourceName;
    instance.version = meta?.version ?? "remote";
    this.recordConnectionStateChange(sourceName, wsId, "_workspace", "running");

    // Register placements in PlacementRegistry
    this.registerPlacements(sourceName, instance.ui, wsId);

    // Atomic config write
    if (this.configPath) {
      const entry: Record<string, unknown> = { url, serverName: sourceName };
      if (transportConfig) entry.transport = transportConfig;
      if (ui) entry.ui = ui;
      if (trustScore != null) entry.trustScore = trustScore;
      atomicConfigAdd(this.configPath, entry);
    }

    // Re-key in case sourceName differs from the input serverName.
    if (sourceName !== serverName) {
      this.instances.delete(`${serverName}|${wsId}`);
      this.instances.set(`${sourceName}|${wsId}`, instance);
    }

    // Emit event
    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        wsId,
        serverName: sourceName,
        bundleName: url,
        version: instance.version,
        type: instance.type,
        remote: true,
        ui: instance.ui,
        trustScore: instance.trustScore,
        placements: instance.ui?.placements ?? null,
      },
    });

    return instance;
  }

  // ---- Uninstall ---------------------------------------------------------

  /**
   * Uninstall a bundle (PRODUCT_SPEC ss3.4).
   *
   * 1. Check protected flag — reject if protected
   * 2. Stop MCP server
   * 3. Remove source from ToolRegistry
   * 4. Remove entry from nimblebrain.json
   * 5. Emit bundle.uninstalled
   * 6. Data is NOT deleted
   */
  async uninstall(nameOrPath: string, registry: ToolRegistry, wsId: string): Promise<void> {
    // Resolve by (serverName, wsId) first; fall back to bundleName match within
    // this workspace. Lookups are always workspace-scoped — uninstalling in one
    // workspace must not affect another workspace's instance of the same bundle.
    let serverName = deriveServerName(nameOrPath);
    let instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      for (const inst of this.instances.values()) {
        if (inst.wsId === wsId && inst.bundleName === nameOrPath) {
          serverName = inst.serverName;
          instance = inst;
          break;
        }
      }
    }

    // Step 1 — Protected check
    if (instance?.protected) {
      throw new Error(`Cannot uninstall "${serverName}": bundle is protected`);
    }

    // Step 2+3 — Stop server, remove from registry
    if (registry.hasSource(serverName)) {
      await registry.removeSource(serverName);
    }

    // Step 3b — Unregister placements for this workspace only
    if (this.placementRegistry) {
      this.placementRegistry.unregister(serverName, wsId);
    }

    // Step 4 — Remove from config
    if (this.configPath) {
      // Use configKey (original path/name/url from install) for reliable matching
      const configKey = instance?.configKey ?? nameOrPath;
      atomicConfigRemove(this.configPath, configKey);
    }

    // Step 4b — Remove bundle-contributed automations (non-blocking)
    await this.removeBundleAutomations(instance?.bundleName ?? nameOrPath, registry);

    // Track state change before removing
    if (instance) {
      this.transition(instance, "stopped");
      this.instances.delete(`${serverName}|${wsId}`);
    }

    // Step 4c — Clean up workspace-scoped credentials (best-effort).
    // Credentials are config, not data — they should not persist across
    // uninstalls. Data directories are preserved (step 6).
    if (instance) {
      const workDir = defaultWorkDir();
      try {
        await new WorkspaceContext({ wsId: instance.wsId, workDir })
          .getCredentialStore()
          .clearAll(instance.bundleName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[lifecycle] Failed to clear credentials for ${instance.bundleName} in ${instance.wsId}: ${msg}\n`,
        );
      }
      // Drop the OAuth state dir as defense-in-depth. URL bundles
      // route through `disconnect` first (which now invalidates "all"
      // including client.json) — but stdio bundles never had OAuth
      // state, and any leftover from a partial earlier disconnect
      // shouldn't survive an uninstall. Worst case the dir is already
      // gone; rmSync with `force` is a no-op then.
      try {
        const oauthDir = new WorkspaceContext({
          wsId: instance.wsId,
          workDir,
        }).getDataPath("credentials", "mcp-oauth", serverName);
        rmSync(oauthDir, { recursive: true, force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[lifecycle] Failed to clear OAuth state for ${serverName} in ${instance.wsId}: ${msg}\n`,
        );
      }
      // Composio-backed bundles use a parallel credential namespace
      // (`composio/<connectorId>/connection.json`) AND have upstream
      // state at Composio (the connected account holding the
      // vendor's OAuth tokens). The mcp-oauth rmSync above doesn't
      // touch either. Without this block, uninstall-without-prior-
      // disconnect (the realistic flow — users don't disconnect
      // first) would leak local disk state and leave the upstream
      // account ACTIVE forever. `cleanupComposioBundle` runs the
      // same revoke-then-delete pair `disconnect` uses; the
      // additional rmSync below removes the now-empty connector
      // subdirectory to match the mcp-oauth posture.
      const composioRef =
        instance.ref && "composio" in instance.ref ? instance.ref.composio : undefined;
      if (composioRef) {
        try {
          await cleanupComposioBundle({
            workDir,
            wsId: instance.wsId,
            connectorId: composioRef.connectorId,
          });
        } catch (err) {
          // cleanupComposioBundle never throws by contract; guard
          // anyway so an SDK exception can't sink the uninstall.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[lifecycle] Failed to revoke Composio bundle "${serverName}" in ${instance.wsId}: ${msg}\n`,
          );
        }
        try {
          const composioDir = new WorkspaceContext({
            wsId: instance.wsId,
            workDir,
          }).getDataPath("credentials", "composio", connectorSlug(composioRef.connectorId));
          rmSync(composioDir, { recursive: true, force: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[lifecycle] Failed to clear composio dir for ${serverName} in ${instance.wsId}: ${msg}\n`,
          );
        }
      }
    }

    // Step 5 — Emit event (data NOT deleted — step 6)
    this.eventSink.emit({
      type: "bundle.uninstalled",
      data: { serverName, bundleName: nameOrPath, wsId },
    });
  }

  // ---- Upgrade -----------------------------------------------------------

  /**
   * Re-spawn one workspace's instance from whatever version is currently in
   * the (shared, name-keyed) mpak cache. Assumes the caller has ALREADY
   * force-pulled the desired version into the cache — this does NOT contact the
   * registry. Tears down the old source and starts the new one, preserving the
   * workspace data dir, credentials, and config entry; refreshes instance
   * metadata, placements, and automations; emits `bundle.upgraded`.
   *
   * Best-effort hot-swap: the registry rejects duplicate source names, so the
   * old source is removed before the new one starts (sub-second gap). If the
   * new spawn fails the instance is left `dead` and the error propagates.
   *
   * Looked up by the instance's persisted `serverName` (not re-derived) so it
   * works for canonical reverse-DNS serverNames, not just legacy short slugs.
   */
  private async respawnInstanceToCachedVersion(
    instance: BundleInstance,
    registry: ToolRegistry,
  ): Promise<{ from: string; to: string; serverName: string }> {
    const wsId = instance.wsId;
    const serverName = instance.serverName;
    const name = instance.bundleName;
    const fromVersion = instance.version;

    // Resolve workspace-scoped paths exactly as installNamed does, so the
    // re-spawned subprocess writes to the same data dir and resolves the same
    // credentials.
    const nbWorkDir = defaultWorkDir();
    const wsContext = new WorkspaceContext({ wsId, workDir: nbWorkDir });
    const configDir = this.configPath ? dirname(this.configPath) : undefined;
    const bundleDataDir = resolveBundleDataDirForRef(nbWorkDir, wsId, { name }, configDir);

    // Remove the old source, then spawn the new version. Carry the persisted
    // serverName through so the re-spawned source keeps the same registry key.
    if (registry.hasSource(serverName)) {
      await registry.removeSource(serverName);
    }

    // The old source is already removed; from here any failure leaves the
    // instance with no live source, so every failure path must transition it to
    // `dead` before propagating — otherwise the instance stays `running` while
    // its tools 404 until the next boot self-heals (torn state).
    let spawn: Awaited<ReturnType<typeof startBundleSource>>;
    try {
      spawn = await startBundleSource({ name, serverName }, registry, this.eventSink, configDir, {
        dataDir: bundleDataDir,
        workspaceContext: wsContext,
        bundleMcp: this.resolveBundleMcpDeps(wsId),
      });
    } catch (err) {
      // Spawn failed: bad binary, prepareServer error, or the refreshed manifest
      // hit the terminal host-manifest gate.
      await this.failRespawn(instance, name, registry);
      throw err;
    }
    const { sourceName: newSourceName, manifest } = spawn;
    if (!manifest) {
      // Named bundles always carry a manifest; null is a precondition violation.
      await this.failRespawn(instance, name, registry);
      throw new Error(`No manifest found for ${name} after upgrade fetch`);
    }

    // Update instance metadata in place.
    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    instance.serverName = newSourceName;
    instance.version = manifest.version;
    instance.description = manifest.description;
    instance.type = isUpjack ? "upjack" : "plain";
    instance.ui = extractUiMeta(manifest);
    instance.briefing = extractBriefing(manifest);
    instance.trustScore = await fetchTrustScore(name, this.mpakHome);
    this.transition(instance, "running");

    // Re-key the instance map if the spawned serverName diverged (defensive —
    // it derives from the same persisted ref so it normally matches).
    if (newSourceName !== serverName) {
      this.instances.delete(`${serverName}|${wsId}`);
      this.instances.set(`${newSourceName}|${wsId}`, instance);
    }

    // Always unregister stale placements first, then re-register whatever the
    // new manifest declares. Without the unconditional unregister, a version
    // that drops all placements would leave stale nav entries behind.
    this.placementRegistry?.unregister(serverName, wsId);
    this.registerPlacements(newSourceName, instance.ui, wsId);

    // Clean stale automations, then sync from the new manifest — matching the
    // uninstall→install ordering so a schedule dropped between versions stops
    // running with a stale prompt.
    await this.removeBundleAutomations(name, registry);
    await this.syncBundleAutomations(manifest, name, registry);

    this.eventSink.emit({
      type: "bundle.upgraded",
      data: {
        wsId,
        serverName: newSourceName,
        bundleName: name,
        fromVersion,
        toVersion: manifest.version,
      },
    });

    return { from: fromVersion, to: manifest.version, serverName: newSourceName };
  }

  /**
   * Failure cleanup for an interrupted re-spawn. The old source was already
   * removed, so mark the instance `dead` (no live source) and drop its
   * now-orphaned automations — otherwise they stay scheduled against the
   * removed source and error when they fire, until the next boot reload
   * re-syncs them. Mirrors uninstall's unconditional automation cleanup.
   * Best-effort: an automation-cleanup error must not mask the spawn failure.
   */
  private async failRespawn(
    instance: BundleInstance,
    bundleName: string,
    registry: ToolRegistry,
  ): Promise<void> {
    this.transition(instance, "dead");
    await this.removeBundleAutomations(bundleName, registry).catch(() => {});
  }

  /**
   * Upgrade a registry app to its latest published version across EVERY
   * workspace that has it installed.
   *
   * App *version* is an org-global concern: the mpak cache is keyed by name
   * only (no version) and shared platform-wide, so a single force-pull updates
   * the artifact for everyone. We therefore pull once, then re-spawn every
   * workspace's instance from the refreshed cache — keeping the running version
   * consistent platform-wide. Looping the per-workspace path would NOT work:
   * after the first workspace the cache is already latest, so a per-workspace
   * `checkForUpdate` returns null and the rest would silently keep running the
   * old subprocess.
   *
   * `getRegistry` resolves a workspace's ToolRegistry (caller wires it to
   * `runtime.getRegistryForWorkspace`). Per-workspace failures are isolated so
   * one bad re-spawn doesn't abort the others. No-op (no event) when already at
   * the latest version. No `protected` guard — security patches must flow.
   */
  async upgradeApp(
    bundleName: string,
    getRegistry: (wsId: string) => ToolRegistry,
  ): Promise<{
    bundleName: string;
    from: string;
    to: string;
    workspaces: Array<{ wsId: string; ok: boolean; error?: string }>;
  }> {
    const targets = this.getInstances().filter(
      (i) => i.bundleName === bundleName && i.installSource === "registry",
    );
    const [first] = targets;
    if (!first) {
      throw new Error(`App "${bundleName}" is not installed in any workspace.`);
    }
    if (this.upgradesInFlight.has(bundleName)) {
      throw new Error(`Upgrade already in progress for "${bundleName}".`);
    }

    this.upgradesInFlight.add(bundleName);
    try {
      const mpak = getMpak(this.mpakHome);
      const fromVersion = first.version;

      // Is a newer version published? `force` bypasses the name-keyed cache's
      // staleness check so we ask the registry directly.
      const latest = await mpak.bundleCache.checkForUpdate(bundleName, { force: true });
      if (!latest) {
        return { bundleName, from: fromVersion, to: fromVersion, workspaces: [] };
      }

      // Pull the new artifact into the shared cache ONCE; every workspace
      // re-spawns from it below.
      await mpak.bundleCache.loadBundle(bundleName, { force: true });

      const workspaces: Array<{ wsId: string; ok: boolean; error?: string }> = [];
      let toVersion = latest;
      for (const instance of targets) {
        try {
          const r = await this.respawnInstanceToCachedVersion(instance, getRegistry(instance.wsId));
          toVersion = r.to;
          workspaces.push({ wsId: instance.wsId, ok: true });
        } catch (err) {
          workspaces.push({
            wsId: instance.wsId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { bundleName, from: fromVersion, to: toVersion, workspaces };
    } finally {
      this.upgradesInFlight.delete(bundleName);
    }
  }

  // ---- Start / Stop / Restart -------------------------------------------

  /**
   * Start a stopped bundle (re-creates the MCP subprocess).
   * Dead bundles must be explicitly restarted with this method.
   */
  async startBundle(serverName: string, wsId: string, registry: ToolRegistry): Promise<void> {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      throw new Error(`No bundle instance found for "${serverName}" in workspace "${wsId}"`);
    }

    if (instance.state === "running") return; // already running

    // Cannot auto-transition from dead — must go through explicit restart
    // (this IS the explicit restart entry-point)
    this.transition(instance, "starting");

    const source = registry.getSources().find((s) => s.name === serverName);
    if (source && source instanceof McpSource) {
      await source.start();
      this.transition(instance, "running");
    } else {
      throw new Error(`No McpSource found for "${serverName}" in registry`);
    }
  }

  /**
   * Stop a running bundle (kills subprocess, keeps source registered).
   */
  async stopBundle(serverName: string, wsId: string, registry: ToolRegistry): Promise<void> {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      throw new Error(`No bundle instance found for "${serverName}" in workspace "${wsId}"`);
    }

    if (instance.state === "stopped" || instance.state === "dead") return;

    const source = registry.getSources().find((s) => s.name === serverName);
    if (source && source instanceof McpSource) {
      await source.stop();
    }

    this.transition(instance, "stopped");
  }

  // ---- State transitions -------------------------------------------------

  /**
   * Update state on a BundleInstance. Public so HealthMonitor can
   * report crashed/recovered/dead transitions.
   */
  transition(instance: BundleInstance, newState: BundleState): void {
    instance.state = newState;
  }

  /**
   * Record a crash detected by HealthMonitor.
   * Emits bundle.crashed event and updates state.
   */
  recordCrash(serverName: string, wsId: string): void {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) return;
    this.transition(instance, "crashed");
    this.eventSink.emit({
      type: "bundle.crashed",
      data: { wsId, serverName, bundleName: instance.bundleName },
    });
  }

  /**
   * Record a successful recovery by HealthMonitor.
   * Emits bundle.recovered event and updates state.
   */
  recordRecovery(serverName: string, wsId: string): void {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) return;
    this.transition(instance, "running");
    this.eventSink.emit({
      type: "bundle.recovered",
      data: { wsId, serverName, bundleName: instance.bundleName },
    });
  }

  /**
   * Record that a bundle has exhausted restart attempts.
   * Emits bundle.dead event and updates state.
   */
  recordDead(serverName: string, wsId: string): void {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) return;
    this.transition(instance, "dead");
    this.eventSink.emit({
      type: "bundle.dead",
      data: { wsId, serverName, bundleName: instance.bundleName },
    });
  }

  /**
   * Record a Connection state transition for a URL bundle. Owns:
   *   - Updating the named Connection's state on the BundleInstance
   *   - Recomputing `BundleInstance.state` via `summarizeConnectionState`
   *   - Emitting the `connection.state_changed` SSE event
   *
   * Idempotent on no-op transitions (same state in, same state out — still
   * emits, since callers may rely on the event for "starting reconfirmed"
   * semantics; if that turns out noisy we can dedupe later).
   *
   * Creates the Connection if it doesn't exist yet. This lets the
   * background `start()` path call `recordConnectionStateChange(...,
   * "running")` without the caller having to construct the Connection
   * shape manually — useful for the headless OAuth path where pending_auth
   * is skipped entirely.
   *
   * Workspace-scoped bundles call with `principalId =
   * WORKSPACE_PRINCIPAL_ID`. Step 3 lights up real member ids.
   */
  recordConnectionStateChange(
    serverName: string,
    wsId: string,
    principalId: string,
    newState: ConnectionState,
    opts?: { authorizationUrl?: string; lastError?: string; source?: McpSource | null },
  ): void {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) return;
    if (!instance.connections) instance.connections = new Map<string, Connection>();

    const existing = instance.connections.get(principalId);
    const next: Connection = {
      principalId,
      state: newState,
      source: opts?.source !== undefined ? opts.source : (existing?.source ?? null),
      // Authorization URL is only meaningful while pending_auth — clear it
      // on any other transition so a stale URL can't leak into /initiate.
      authorizationUrl:
        newState === "pending_auth"
          ? (opts?.authorizationUrl ?? existing?.authorizationUrl)
          : undefined,
      lastError: opts?.lastError ?? (newState === "running" ? undefined : existing?.lastError),
    };
    instance.connections.set(principalId, next);

    // Recompute summary state so legacy consumers (HealthMonitor,
    // briefing-collector, runtime status API) see the right surface.
    instance.state = summarizeConnectionState(instance.connections);

    // Release the OAuth-flow coalesce slot on terminal transitions. The
    // slot is held from the first `startAuth` call until the connection
    // definitively resolves, so concurrent inbound `startAuth` calls
    // coalesce to one flow and never clobber shared on-disk PKCE / DCR
    // state. `starting` and `pending_auth` are NOT terminal — they are
    // exactly the windows where coalescing matters. See the
    // `authFlowsInFlight` field comment for the full rationale.
    //
    // `Map.delete` is idempotent and unconditional here is safe: if the
    // key isn't present (no flow was in-flight) it's a no-op; if the key
    // is present, the flow has reached a terminal state and is no longer
    // racing with future calls.
    if (AUTH_FLOW_TERMINAL_STATES.has(newState)) {
      this.authFlowsInFlight.delete(authFlowKey(serverName, wsId, principalId));
    }

    this.eventSink.emit({
      type: "connection.state_changed",
      data: {
        wsId,
        serverName,
        bundleName: instance.bundleName,
        principalId,
        state: newState,
        ...(next.authorizationUrl ? { authorizationUrl: next.authorizationUrl } : {}),
        ...(next.lastError ? { lastError: next.lastError } : {}),
      },
    });
  }

  /**
   * Initiate (or restart) an OAuth flow for one (bundle, principal) tuple.
   *
   * Unified entry point — the route handler calls this for both
   * workspace-scope (`principalId === "_workspace"`) and member-scope
   * connections without branching on scope.
   *
   * Behaviour:
   *  - Idempotent on double-click: if a `pending_auth` URL is already
   *    captured, return it immediately (debounce duplicate authorize
   *    requests).
   *  - Tears down any pre-existing source for this principal (running,
   *    dead, reauth_required, etc.) before constructing a fresh one. This
   *    is what makes Disconnect → Connect work without a process restart:
   *    the stale McpSource (with revoked tokens cached in memory) is
   *    replaced wholesale, not patched.
   *  - Rejects the call if the connection is already `running` — the
   *    caller should disconnect first; this surfaces as a 409-shaped
   *    error at the route layer.
   *
   * Background lifecycle: kicks off `source.start()`. If the provider
   * fires `onInteractiveAuthRequired`, the URL is captured + the
   * promise resolves; otherwise (headless / pre-authenticated path)
   * the source connects, transitions to `running`, and the auth URL
   * promise rejects (the caller wasn't expecting that path).
   */
  async startAuth(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string }> {
    // In-flight coalesce: if a startAuth for this key is mid-flight, return
    // its promise. See `authFlowsInFlight` field comment for the race this
    // closes (DCR + verifier.json clobber by a second startAuth that slips
    // past the pending_auth debounce while the first is still in `starting`).
    const key = authFlowKey(serverName, wsId, principalId);
    const existingFlow = this.authFlowsInFlight.get(key);
    if (existingFlow) return existingFlow;

    const flow = this.startAuthInner(serverName, wsId, principalId, opts);
    this.authFlowsInFlight.set(key, flow);
    // Fallback clear for pre-state-record sync failures only (instance not
    // found, wrong principal, missing ref). Successful flows and async
    // failures clear the slot via `recordConnectionStateChange`'s terminal-
    // state branch — see the `authFlowsInFlight` field comment. We must NOT
    // clear on success here: that would re-introduce the very race this
    // closes (slot empty during the user's OAuth window → next inbound call
    // starts a fresh flow → verifier.json clobbered → invalid_code).
    //
    // CAS guards against a later flow that won the race being cleared by an
    // earlier one's catch. Idempotent — Map.delete on a key cleared by the
    // state transition is a no-op.
    flow.catch(() => {
      if (this.authFlowsInFlight.get(key) === flow) {
        this.authFlowsInFlight.delete(key);
      }
    });
    return flow;
  }

  private async startAuthInner(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string }> {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      throw new Error(`[lifecycle] bundle "${serverName}" not installed in workspace ${wsId}`);
    }
    if (!instance.ref || !("url" in instance.ref)) {
      throw new Error(`[lifecycle] missing URL ref for "${serverName}" — cannot construct source`);
    }
    // Stage 2: every URL bundle is workspace-scoped (the legacy
    // `oauthScope: "user"` literal was deleted). The only legal
    // principal is `WORKSPACE_PRINCIPAL_ID`; a member-scoped call
    // would be a regression of the schema cut.
    if (principalId !== WORKSPACE_PRINCIPAL_ID) {
      throw new Error(
        `[lifecycle] startAuth: principal "${principalId}" is not a workspace principal — ` +
          "Stage 2 cut the legacy user-scope path; bind the bundle to the owner's personal workspace instead.",
      );
    }

    // Reuse an existing pending_auth URL if present (debounce double-clicks).
    const existingConn = instance.connections?.get(principalId);
    if (existingConn?.state === "pending_auth" && existingConn.authorizationUrl) {
      return { authorizationUrl: existingConn.authorizationUrl };
    }
    if (existingConn?.state === "running") {
      throw new Error(
        `[lifecycle] principal "${principalId}" already connected to "${serverName}" — disconnect before reconnecting`,
      );
    }

    // Tear down any stale source for this principal. Necessary after
    // disconnect (tokens revoked but McpSource still alive in memory),
    // after reauth_required, and after dead/crashed states. We construct
    // a fresh provider+source below regardless of prior state.
    await this.teardownConnectionSource(serverName, wsId, principalId);

    // Resolve pre-registered OAuth client config (Track A: oauthClient
    // + scopes + additionalAuthorizationParams). Both scopes use the
    // same credential-store dereference path.
    const ref = instance.ref;
    let staticClient:
      | {
          clientId: string;
          clientSecret?: string;
          tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
        }
      | undefined;
    if (ref.oauthClient) {
      let resolvedSecret: string | undefined;
      if (ref.oauthClient.clientSecret) {
        const secretStore = new FileCredentialStore(opts.workDir);
        const wrapped = await secretStore.get(wsId, ref.oauthClient.clientSecret.key);
        if (!wrapped) {
          throw new Error(
            `[lifecycle] OAuth client_secret not found at credential key "${ref.oauthClient.clientSecret.key}" for ${serverName} — ` +
              `run \`nb credential set ${wsId} ${ref.oauthClient.clientSecret.key} <value>\``,
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

    // Construct provider with our pending-auth callback. The callback
    // fires synchronously inside `redirectToAuthorization` BEFORE the
    // provider throws UnauthorizedError, so it always runs before
    // McpSource.start() returns (or its background promise resolves).
    let capturedAuthUrl: string | undefined;
    let resolveAuthUrl!: (url: string) => void;
    let rejectAuthUrl!: (err: Error) => void;
    const authUrlPromise = new Promise<string>((res, rej) => {
      resolveAuthUrl = res;
      rejectAuthUrl = rej;
    });
    // Defensive no-op handler — if the caller's race loses to the
    // timeout / pending_auth resolution, the other path's settle won't
    // become an unhandled rejection.
    authUrlPromise.catch(() => {});

    // Cancel the provider's outbound fetches when the 15s race resolves
    // (either branch). Without this, an unresponsive auth server's
    // redirect-probe TCP read keeps running for its full network
    // timeout (often 30–60s) after we've already surfaced the timeout
    // to the caller.
    const providerAbort = new AbortController();

    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId },
      serverName,
      workDir: opts.workDir,
      // Workspace-scoped tokens route the credential directory through
      // the typed handle.
      workspaceContext: new WorkspaceContext({ wsId, workDir: opts.workDir }),
      callbackUrl: opts.callbackUrl,
      allowInsecureRemotes: opts.allowInsecureRemotes === true,
      headlessAuthProbe: ref.headlessAuthProbe === true,
      // Fleet tenant binding. Safe to pass for every server: the provider only
      // attaches an assertion when the token endpoint's origin matches this
      // issuer (the fleet authorizer), never to a vendor.
      ...fleetIssuerOption(),
      onInteractiveAuthRequired: (url) => {
        capturedAuthUrl = url;
        this.recordConnectionStateChange(serverName, wsId, principalId, "pending_auth", {
          authorizationUrl: url,
        });
        resolveAuthUrl(url);
      },
      // Mid-session auth loss on this connection (a tool call hit
      // UnauthorizedError because the refresh token was rejected). Flip to
      // reauth_required so the UI offers "Reconnect" instead of silently
      // failing every call. No authorizationUrl — Reconnect re-initiates.
      onAuthLost: () => {
        this.recordConnectionStateChange(serverName, wsId, principalId, "reauth_required");
      },
      ...(staticClient ? { staticClient } : {}),
      ...(ref.scopes ? { scopes: ref.scopes } : {}),
      ...(ref.additionalAuthorizationParams
        ? { additionalAuthorizationParams: ref.additionalAuthorizationParams }
        : {}),
      abortSignal: providerAbort.signal,
    });
    const source = new McpSource(
      serverName,
      {
        type: "remote",
        url: new URL(ref.url),
        transportConfig: ref.transport,
        authProvider: provider,
      },
      this.eventSink,
      composeBundleMcpContext(this.resolveBundleMcpDeps(wsId), serverName),
    );

    // Wire the new source into the workspace registry BEFORE start so
    // any tool call during the flow finds it (and gets a "starting" /
    // "pending_auth" structured error instead of "no source").
    const registry = this.registriesByWs.get(wsId);
    if (registry && !registry.hasSource(serverName)) {
      registry.addSource(source);
    }
    this.recordConnectionStateChange(serverName, wsId, principalId, "starting", {
      source,
    });

    // Background start. The provider's callback resolves `authUrlPromise`
    // when interactive auth is required. If start() succeeds without ever
    // hitting interactive (headless / pre-authenticated), we transition to
    // running and reject the auth URL promise (caller wasn't expecting
    // that path; they should re-list installed connectors to refresh
    // state).
    void source
      .start()
      .then(() => {
        this.recordConnectionStateChange(serverName, wsId, principalId, "running");
        if (!capturedAuthUrl) {
          rejectAuthUrl(
            new Error(
              `[lifecycle] ${serverName} for ${principalId} connected without interactive auth — already authenticated`,
            ),
          );
        }
      })
      .catch((err) => {
        // The SDK's OAuth error classes (InvalidGrantError, InvalidClientError,
        // …) carry their detail in `.name` with an EMPTY `.message`, so fall
        // back to the name — otherwise the surfaced diagnostic is blank, which
        // is nearly as useless as swallowing it.
        const msg = err instanceof Error ? err.message || err.name : String(err);
        // Always surface the failure. The interactive path (capturedAuthUrl
        // set) used to be swallowed here: if the background start() failed
        // AFTER the auth URL was returned — the token exchange or reconnect
        // threw once the user came back, or the pending flow timed out — the
        // connection was left stuck in `pending_auth` ("Connecting…") forever
        // with no log and no tokens. Log it and move the connection to `dead`
        // (+ lastError) so the UI offers a recoverable Reconnect instead of
        // an indefinite spinner.
        log.warn(
          `[lifecycle] startAuth: ${serverName} start failed for ${principalId} in ${wsId}: ${msg}`,
        );
        this.recordConnectionStateChange(serverName, wsId, principalId, "dead", {
          lastError: msg,
        });
        // `authUrlPromise` already resolved on the interactive path, so a
        // reject there is a no-op; only the headless / pre-auth failure path
        // (no captured URL) still needs the caller's promise rejected.
        if (!capturedAuthUrl) {
          rejectAuthUrl(err instanceof Error ? err : new Error(msg));
        }
      });

    // Race the auth URL signal against a hard timeout. 15s is generous —
    // the provider's redirect probe + the SDK's metadata fetch + DCR
    // typically complete in under 5s on a healthy server.
    const TIMEOUT_MS = 15_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timeoutHandle = setTimeout(
        () => rej(new Error(`[lifecycle] startAuth timed out after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      );
    });
    try {
      const authorizationUrl = await Promise.race([authUrlPromise, timeout]);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // SUCCESS: the interactive flow (or a headless completion) continues
      // in the background `source.start()` — it still has to run the token
      // exchange + reconnect when the user returns from the authorization
      // server. Do NOT abort the provider here; that would cancel a
      // still-pending flow's in-flight fetches mid-dance. The abort below
      // is only for the give-up paths.
      return { authorizationUrl };
    } catch (err) {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // Timed out, or the background start() rejected before any auth URL
      // (headless / pre-auth failure). Cancel the provider's in-flight
      // fetches so an unresponsive auth server's TCP read doesn't linger
      // for its full network deadline.
      providerAbort.abort();
      throw err;
    }
  }

  /**
   * Disconnect one (bundle, principal) tuple. Revokes tokens at the AS
   * (RFC 7009 best-effort), deletes local credentials, tears down the
   * McpSource, and transitions the Connection to `not_authenticated`.
   *
   * Symmetric across workspace-scope and member-scope. After disconnect,
   * a subsequent `startAuth` will construct a fresh source from scratch
   * — no stale state lingers.
   */
  async disconnect(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; allowInsecureRemotes?: boolean },
  ): Promise<{
    revoked: { access?: boolean; refresh?: boolean };
    deletedLocal: boolean;
    revokeError?: string;
  }> {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      throw new Error(`[lifecycle] bundle "${serverName}" not installed in workspace ${wsId}`);
    }
    const ref = instance.ref;
    if (!ref || !("url" in ref)) {
      throw new Error(`[lifecycle] missing URL ref for "${serverName}" — cannot revoke tokens`);
    }
    // Stage 2: every URL bundle is workspace-scoped. The only legal
    // principal is `WORKSPACE_PRINCIPAL_ID`.
    if (principalId !== WORKSPACE_PRINCIPAL_ID) {
      throw new Error(
        `[lifecycle] disconnect: principal "${principalId}" is not a workspace principal — ` +
          "Stage 2 cut the legacy user-scope path.",
      );
    }

    // Composio-backed bundles use a parallel credential namespace —
    // OAuth tokens live at Composio, not in our `mcp-oauth` directory.
    // `cleanupComposioBundle` runs the same two-step teardown that
    // uninstall uses: revoke the Composio-side connected account
    // (vendor OAuth tokens go with it) + delete the local
    // `connection.json` so a subsequent Connect can't short-circuit
    // on a stale ACTIVE account. Single helper, two callers.
    //
    // Composio doesn't differentiate access from refresh — one
    // delete call revokes both at the upstream vendor. Reporting
    // `{ access }` only (not faking `refresh`) keeps the return
    // shape honest about what we know.
    if (ref.composio) {
      const { upstreamDeleted, localDeleted, lastError } = await cleanupComposioBundle({
        workDir: opts.workDir,
        wsId,
        connectorId: ref.composio.connectorId,
      });
      await this.teardownConnectionSource(serverName, wsId, principalId);
      this.recordConnectionStateChange(serverName, wsId, principalId, "not_authenticated", {
        source: null,
        authorizationUrl: undefined,
      });
      return {
        revoked: { access: upstreamDeleted },
        deletedLocal: localDeleted,
        ...(lastError ? { revokeError: lastError } : {}),
      };
    }

    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId },
      serverName,
      workDir: opts.workDir,
      workspaceContext: new WorkspaceContext({ wsId, workDir: opts.workDir }),
      // Resolve through the single source of truth (bouncer-aware), same as
      // boot-start and `initiate`. Although revocation doesn't run an
      // authorize round-trip, constructing the provider loads client.json
      // and runs the DCR drift check against this `callbackUrl` — a
      // placeholder (the old `http://_/`) never matches the registered
      // redirect_uri, so it spuriously discards the client, mints a new
      // client_id on the next flow, and orphans the refresh token. See
      // src/oauth/mcp-callback-url.ts.
      callbackUrl: mcpAuthCallbackUrl(),
      allowInsecureRemotes: opts.allowInsecureRemotes === true,
    });
    const result = await provider.revokeAndDeleteTokens({ bundleUrl: ref.url });

    await this.teardownConnectionSource(serverName, wsId, principalId);

    this.recordConnectionStateChange(serverName, wsId, principalId, "not_authenticated", {
      source: null,
      authorizationUrl: undefined,
    });

    return {
      revoked: result.revoked,
      deletedLocal: result.deletedLocal,
      ...(result.error ? { revokeError: result.error } : {}),
    };
  }

  /**
   * Stop and unwire the McpSource for one (bundle, workspace-principal)
   * tuple. Stops `source.stop()` and removes the source from the
   * workspace registry.
   *
   * Stage 2 collapsed the member-scope (user-pool) branch — every URL
   * bundle now binds to a workspace, including personal connectors
   * (those bind to the owner's personal workspace).
   *
   * Idempotent: silently no-ops if no source is currently wired up.
   */
  private async teardownConnectionSource(
    serverName: string,
    wsId: string,
    principalId: string,
  ): Promise<void> {
    if (principalId !== WORKSPACE_PRINCIPAL_ID) {
      throw new Error(
        `[lifecycle] teardownConnectionSource: principal "${principalId}" is not a workspace principal — ` +
          "Stage 2 cut the legacy user-scope path.",
      );
    }
    const instance = this.instances.get(`${serverName}|${wsId}`);
    const conn = instance?.connections?.get(principalId);
    if (conn?.source) {
      try {
        await conn.source.stop();
      } catch (err) {
        // Best-effort: a failing stop shouldn't block the teardown
        // (we're going to drop the source anyway). Surface for
        // operator visibility — a stuck-source pattern is worth
        // catching even if individual occurrences are benign.
        log.warn(
          `[lifecycle] source.stop() failed for ${serverName}|${wsId}|${principalId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const registry = this.registriesByWs.get(wsId);
    if (registry?.hasSource(serverName)) {
      await registry.removeSource(serverName);
    }
  }

  /**
   * Map of `wsId` → `ToolRegistry` for the workspace. Required so
   * `startAuth` / `disconnect` can wire workspace-scope sources into the
   * registry without callers having to thread the registry through every
   * lifecycle entry point. Set once at platform boot via
   * `setWorkspaceRegistries`; never mutated afterward.
   */
  private readonly registriesByWs = new Map<string, ToolRegistry>();

  /**
   * Per-`${serverName}|${wsId}` timestamp (epoch ms) of the last
   * best-effort recovery attempt (`tryRecoverSource`). Negative cache: a
   * failed re-spawn stamps the key so the orchestrator hot path doesn't
   * spawn-storm a genuinely broken bundle on every tool call; a
   * successful recovery clears it.
   *
   * Per-pod by design, and correct under `replicas > 1` — do NOT move it
   * to Redis/`SessionRegistry`. It guards a per-pod in-memory registry
   * repair: `registriesByWs` is process-local and its sources are
   * process-bound transports (see the "MCP Session Architecture" two-layer
   * model — transports "never serialize, never share across processes").
   * A source missing from this pod's registry says nothing about another
   * pod's, so each pod must heal its own registry on its own evidence. A
   * cluster-shared cooldown would be a bug: one pod's failed heal would
   * suppress another pod's legitimate independent miss. Unlike
   * `ConnectionRevalidator` (a proactive poller against a shared upstream
   * account → needs leader election), this is reactive and idempotent
   * (`hasSource` short-circuit, re-uses persisted OAuth state), touches no
   * shared resource, and fans out to nobody — so it needs no coordination.
   * No TTL sweep: a key for a since-removed bundle lingers until process
   * exit (a few bytes, bounded by install × workspace cardinality).
   */
  private readonly recoveryAttempts = new Map<string, number>();
  /** Min interval between `tryRecoverSource` re-spawn attempts per source. */
  private static readonly RECOVERY_COOLDOWN_MS = 30_000;

  /**
   * Wire the per-workspace registries map. Called once by `Runtime.start`
   * after the workspace bundle boot loop has constructed the registries.
   * Allows `startAuth` (workspace-scope) to add/remove sources without
   * the route handler having to thread a registry argument.
   */
  setWorkspaceRegistries(registries: Map<string, ToolRegistry>): void {
    this.registriesByWs.clear();
    for (const [wsId, registry] of registries) this.registriesByWs.set(wsId, registry);
  }

  // ---- Bundle-contributed automations -------------------------------------

  /**
   * Extract schedules from an Upjack manifest and create automations via
   * the domain API. Idempotent — create returns existing if the id
   * matches. Errors are logged but never fail the install (graceful
   * degradation).
   *
   * Bypasses the LLM-facing `automations__create` tool because bundle-
   * authored schedules need to stamp `source: "bundle"` and `bundleName`
   * — operator fields the tool surface doesn't accept. Without this,
   * `removeBundleAutomations` couldn't find what to clean up on
   * uninstall.
   */
  private async syncBundleAutomations(
    manifest: BundleManifest,
    bundleName: string,
    _registry: ToolRegistry,
  ): Promise<void> {
    const upjackMeta = manifest._meta?.["ai.nimblebrain/upjack"] as
      | Record<string, unknown>
      | undefined;
    if (!upjackMeta) return;

    const schedules = upjackMeta.schedules as UpjackScheduleDeclaration[] | undefined;
    if (!schedules || !Array.isArray(schedules) || schedules.length === 0) return;

    if (!this.getAutomationsCtx) {
      process.stderr.write(
        `[lifecycle] Automations subsystem not registered — skipping ${schedules.length} schedule(s) for ${bundleName}\n`,
      );
      return;
    }
    const ctx = this.getAutomationsCtx();

    // Derive the short name used as the automation id prefix
    // e.g. "@acme/monitoring" → "monitoring"
    const shortName = deriveServerName(manifest.name);

    for (const sched of schedules) {
      try {
        if (!sched.name || !sched.prompt || !sched.schedule) {
          process.stderr.write(
            `[lifecycle] Skipping schedule in ${bundleName}: missing required fields (name, prompt, schedule)\n`,
          );
          continue;
        }

        const automationId = `${shortName}__${sched.name}`;

        createAutomation(
          {
            name: automationId,
            prompt: sched.prompt,
            schedule: sched.schedule,
            description: sched.description,
            skill: sched.skill,
            allowedTools: sched.allowedTools,
            maxIterations: sched.maxIterations,
            maxInputTokens: sched.maxInputTokens,
            model: sched.model ?? undefined,
            enabled: sched.enabled ?? true,
            source: "bundle",
            bundleName,
          },
          ctx,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[lifecycle] Failed to create automation for schedule "${sched.name}" in ${bundleName}: ${msg}\n`,
        );
      }
    }
  }

  /**
   * Remove all bundle-contributed automations for a given bundleName.
   * Reads the store directly via the domain context, filters by
   * `source: "bundle"` and matching `bundleName`, then deletes each.
   * Errors are logged but never fail the uninstall.
   */
  private async removeBundleAutomations(
    bundleName: string,
    _registry: ToolRegistry,
  ): Promise<void> {
    if (!this.getAutomationsCtx) return; // No automations subsystem in this runtime.
    try {
      const ctx = this.getAutomationsCtx();
      const defs = ctx.definitions();
      const toDelete: string[] = [];
      for (const auto of defs.values()) {
        if (auto.source === "bundle" && auto.bundleName === bundleName) {
          toDelete.push(auto.name);
        }
      }
      for (const name of toDelete) {
        try {
          deleteAutomation(name, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[lifecycle] Failed to delete automation "${name}" during uninstall of ${bundleName}: ${msg}\n`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[lifecycle] Could not clean up automations for ${bundleName}: ${msg}\n`,
      );
    }
  }

  /**
   * Register placements from a bundle's UI metadata in the PlacementRegistry.
   * Scoped to `wsId` so two workspaces installing the same bundle get separate
   * nav entries and uninstalling one doesn't wipe the other's.
   */
  private registerPlacements(serverName: string, ui: BundleUiMeta | null, wsId: string): void {
    if (!this.placementRegistry || !ui) return;

    if (ui.placements && ui.placements.length > 0) {
      this.placementRegistry.register(serverName, ui.placements, wsId);
    }
  }

  /**
   * Side-effect-only "I just installed this bundle" notification —
   * registers UI placements with the platform's placement registry and
   * fires the `bundle.installed` event so SSE-subscribed clients
   * (e.g. the web shell's sidebar) refresh without a page reload.
   *
   * Separate from `seedInstance` because seedInstance is also called
   * at boot for already-installed bundles, and we don't want boot to
   * fire `bundle.installed` events (telemetry would double-count, and
   * no SSE clients exist yet anyway). Install handlers call this
   * explicitly after their seed; the boot path does not.
   *
   * No-op when the instance can't be found — defensive guard for
   * mis-ordered call sites; logs at debug.
   */
  /**
   * Ensure the workspace registry has a running source for
   * `serverName`. No-op if one is already registered. Otherwise,
   * reconstructs the source from the persisted `BundleRef` on the
   * `BundleInstance` and starts it via `startBundleSource`.
   *
   * The use case: `disconnect()` calls `teardownConnectionSource`,
   * which removes the source from the registry. On reconnect, the
   * platform records a "running" state — but recording is a state
   * mutation, not a source-lifecycle operation. Without this helper,
   * the registry stays empty and tool calls fail with "source not
   * started" until the next platform restart.
   *
   * The native OAuth reconnect path routes through `startAuth`,
   * which already calls `startBundleSource` internally. The Composio
   * reconnect path doesn't go through `startAuth` (different OAuth
   * model — the dance happens server-side via Composio's API, not
   * via the MCP SDK's OAuth provider), so it needs this helper.
   *
   * Throws when:
   *   - The workspace has no registry yet (boot ordering bug — should
   *     not happen in production code paths)
   *   - The BundleInstance has no URL ref persisted (shouldn't happen
   *     for any path that goes through install)
   *
   * `startBundleSource` itself can throw on transport / handshake
   * failures; callers should decide whether to swallow or surface.
   */
  async ensureSourceRegistered(serverName: string, wsId: string, workDir: string): Promise<void> {
    const wsRegistry = this.registriesByWs.get(wsId);
    if (!wsRegistry) {
      throw new Error(`[lifecycle] no registry for workspace "${wsId}"`);
    }
    if (wsRegistry.hasSource(serverName)) return;

    const instance = this.instances.get(`${serverName}|${wsId}`);
    const ref = instance?.ref;
    if (!ref || !("url" in ref)) {
      throw new Error(
        `[lifecycle] cannot re-register source "${serverName}" in ${wsId} — no URL ref persisted`,
      );
    }

    await startBundleSource(ref, wsRegistry, this.eventSink, undefined, {
      allowInsecureRemotes: this.allowInsecureRemotes,
      wsId,
      workDir,
      // Re-thread on reconnect so a Composio OAuth callback doesn't
      // silently drop the bundle's host-resources handlers. The
      // composio-auth callback path goes through here.
      bundleMcp: this.resolveBundleMcpDeps(wsId),
    });
  }

  /**
   * Best-effort re-registration of an installed-but-missing workspace
   * source, for the orchestrator's hot-path self-heal
   * (`OrchestratorRuntime.recoverWorkspaceSource`). Unlike
   * `ensureSourceRegistered` — which throws and is only safe from a
   * deliberate reconnect flow — this NEVER throws and is safe to call on
   * every tool-call source-miss:
   *
   *   - returns `true` immediately if the source is already registered;
   *   - returns `false` for an unknown instance (bundle not installed
   *     here), a non-URL ref (named/stdio re-spawn is the heavier
   *     `startBundleSource` path — deferred; see the tracked follow-up),
   *     or a recent failed attempt still inside the cooldown window;
   *   - otherwise re-spawns once from the persisted URL ref, stamps the
   *     attempt, and returns whether the source is now registered.
   *
   * The cooldown is a negative cache: a genuinely-broken bundle (bad
   * OAuth, unreachable endpoint) is retried at most once per
   * `RECOVERY_COOLDOWN_MS`, NOT once per tool call, so a self-heal miss
   * can't turn into a spawn storm on the hot path. A recovered remote
   * source that still needs interactive auth comes back registered (in
   * `pending_auth`), which is strictly better than absent: tool calls get
   * a clean "needs reauth" surface and the UI offers Reconnect, instead
   * of `UnknownToolSource` and a vanished connector.
   */
  async tryRecoverSource(serverName: string, wsId: string, workDir: string): Promise<boolean> {
    const wsRegistry = this.registriesByWs.get(wsId);
    if (!wsRegistry) return false;
    if (wsRegistry.hasSource(serverName)) return true;

    const key = `${serverName}|${wsId}`;

    // Only an installed instance with a persisted URL ref is recoverable
    // on this path. No instance → the bundle isn't installed in this
    // workspace (nothing to recover). A non-URL (named/stdio) ref needs
    // the credential-resolving named-spawn path — out of scope here.
    const ref = this.instances.get(key)?.ref;
    if (!ref || !("url" in ref)) return false;

    const now = Date.now();
    const last = this.recoveryAttempts.get(key);
    if (last !== undefined && now - last < BundleLifecycleManager.RECOVERY_COOLDOWN_MS) {
      return false;
    }
    // Stamp BEFORE the await, with no intervening yield: a concurrent miss
    // for the same source observes the stamp and declines rather than
    // double-spawning (the spawn-storm guard). The deliberate trade-off is
    // that an overlapping call returns false mid-recovery instead of
    // awaiting this attempt's outcome — benign, since the caller falls
    // through to `UnknownToolSource` and the agent's retry lands after
    // this attempt settles. Not worth an in-flight-promise dedup for so
    // narrow a window.
    this.recoveryAttempts.set(key, now);

    try {
      await this.ensureSourceRegistered(serverName, wsId, workDir);
    } catch (err) {
      log.warn(
        `[lifecycle] tryRecoverSource: re-register failed for "${serverName}" in ${wsId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }

    const recovered = wsRegistry.hasSource(serverName);
    if (recovered) {
      this.recoveryAttempts.delete(key);
      log.info(`[lifecycle] tryRecoverSource: re-registered "${serverName}" in ${wsId}`);
    }
    return recovered;
  }

  notifyInstalled(serverName: string, wsId: string): void {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      log.debug(
        "mcp",
        `[lifecycle] notifyInstalled: no instance for ${serverName}|${wsId} — skipping`,
      );
      return;
    }
    this.registerPlacements(serverName, instance.ui, wsId);
    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        wsId,
        serverName,
        bundleName: instance.bundleName,
        version: instance.version,
        type: instance.type,
        trustScore: instance.trustScore,
        ui: instance.ui,
        placements: instance.ui?.placements ?? null,
      },
    });
  }

  /**
   * Seed instances from the initial bundle startup (called by Runtime.start
   * after bundles are already running).
   *
   * Stage 2: every URL bundle binds to its workspace explicitly. The
   * disk-read boundary (`buildProcessInventory`) calls
   * `assertBundleRefIsPostStage2` and hard-errors on legacy
   * `oauthScope: "user"` records — see the deploy runbook at
   * the Stage 2 deploy runbook.
   */
  seedInstance(
    serverName: string,
    bundleName: string,
    ref: BundleRef,
    manifestMeta:
      | {
          manifestName?: string;
          version: string;
          description?: string;
          ui: BundleUiMeta | null;
          briefing?: BriefingBlock | null;
          type: "upjack" | "plain";
          upjackNamespace?: string;
        }
      | undefined,
    wsId: string,
    dataDir?: string,
    /** Per-workspace ToolRegistry. Optional for backward compat with
     *  test callers; production callers should always pass it. */
    registry?: ToolRegistry,
  ): void {
    void registry; // registry is no longer used; kept for caller backward compat
    // Resolve entity data root from dataDir + upjack namespace. `dataDir` is
    // already the canonical bundle-data parent (slug = manifest.name) thanks
    // to `resolveBundleDataDirForRef` at every caller — buildProcessInventory,
    // installLocal, installNamed, installBundleInWorkspace. No re-derivation
    // here: launcher and reader agree by construction.
    const entityDataRoot =
      dataDir && manifestMeta?.upjackNamespace
        ? join(dataDir, manifestMeta.upjackNamespace, "data")
        : undefined;

    // Resolve oauthScope for URL bundles. Post-Stage-2 the only legal
    // value is `"workspace"`; the disk-read boundary
    // (`buildProcessInventory`) hard-errors on legacy `"user"` records.
    const oauthScope: BundleInstance["oauthScope"] | undefined =
      "url" in ref ? "workspace" : undefined;

    // Track A: validate authorize-URL params at the seed boundary.
    // Catches reserved-key collisions (client_id, state, PKCE, scope, etc.)
    // before they break OAuth flows at runtime.
    if ("url" in ref && ref.additionalAuthorizationParams) {
      validateAdditionalAuthorizationParams(ref.additionalAuthorizationParams);
    }

    const instance: BundleInstance = {
      serverName,
      // Prefer the scoped manifest name over the config label (filesystem path)
      bundleName: manifestMeta?.manifestName ?? bundleName,
      // Config key for reliable uninstall — the original value from nimblebrain.json
      configKey: bundleName,
      version: manifestMeta?.version ?? "unknown",
      description: manifestMeta?.description,
      state: "running",
      trustScore: ref.trustScore ?? null,
      ui: ref.ui ?? manifestMeta?.ui ?? null,
      briefing: manifestMeta?.briefing ?? null,
      protected: ref.protected ?? false,
      type: manifestMeta?.type ?? "plain",
      wsId,
      // Derive the install channel from the persisted ref shape so both the
      // connector-install path and the boot reload (which both seed here) get
      // it with no migration — `check_updates`/`upgrade` filter on this.
      installSource: "name" in ref ? "registry" : "url" in ref ? "remote" : "local",
      ...(oauthScope !== undefined ? { oauthScope } : {}),
      ...(entityDataRoot !== undefined ? { entityDataRoot } : {}),
      // URL bundles only — needed to reconstruct McpSources on-demand
      // (URL, transport config, oauthClient + scopes). Stored as an
      // opaque copy.
      ...("url" in ref ? { ref: { ...ref } } : {}),
    };
    const key = `${serverName}|${wsId}`;
    this.instances.set(key, instance);

    // For URL bundles, derive the boot-time Connection state.
    if ("url" in ref) {
      // Workspace-scope. Boot-time outcomes, in priority order:
      //   1. The OAuth provider's interactive callback fired during boot
      //      (RT was persisted but rejected — the SDK fell back to the
      //      interactive branch and the URL was buffered). Record
      //      `reauth_required` with the captured URL so the UI shows a
      //      "Reconnect" affordance instead of "Connect".
      //   2. No tokens exist on disk → record `not_authenticated`. The
      //      bundle is silently installed; the user discovers it on the
      //      Connections page and clicks Connect to initiate OAuth.
      //   3. Tokens exist and source.start() succeeded → record
      //      `running`.
      const pendingAuthUrl = consumePendingAuth(wsId, serverName);
      if (pendingAuthUrl) {
        this.recordConnectionStateChange(serverName, wsId, "_workspace", "reauth_required", {
          authorizationUrl: pendingAuthUrl,
        });
      } else {
        const workDir = defaultWorkDir();
        // Composio-backed connectors live in a parallel credential
        // namespace — the user-presence signal is
        // `credentials/composio/<connectorId>/connection.json`, not
        // the mcp-oauth tokens.json. Bundles carry the catalog id
        // forward on `ref.composio.connectorId` so this probe is
        // local; we don't need the catalog to derive the path.
        const hasAuth =
          "composio" in ref && ref.composio
            ? hasPersistedComposioConnection(workDir, wsId, ref.composio.connectorId)
            : hasPersistedWorkspaceOAuthTokens(workDir, wsId, serverName);
        if (!hasAuth) {
          this.recordConnectionStateChange(serverName, wsId, "_workspace", "not_authenticated");
        } else {
          this.recordConnectionStateChange(serverName, wsId, "_workspace", "running");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Upjack schedule declaration (from manifest _meta["ai.nimblebrain/upjack"].schedules)
// ---------------------------------------------------------------------------

interface UpjackScheduleDeclaration {
  name: string;
  prompt: string;
  schedule: {
    type: "cron" | "interval";
    expression?: string;
    timezone?: string;
    intervalMs?: number;
  };
  description?: string;
  skill?: string;
  allowedTools?: string[];
  maxIterations?: number;
  maxInputTokens?: number;
  model?: string | null;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createInstance(
  serverName: string,
  bundleName: string,
  manifest: BundleManifest,
  isUpjack: boolean,
  wsId: string,
  dataDir: string,
): BundleInstance {
  // Mirror the entityDataRoot composition `seedInstance` does at boot so
  // JIT installs (installLocal / installNamed) leave the BundleInstance in
  // the same shape as a boot-seeded one. Without this, briefing facets
  // pointed at a freshly-installed upjack bundle would find
  // `instance.entityDataRoot === undefined` and silently report nothing.
  const upjackMeta = manifest._meta?.["ai.nimblebrain/upjack"] as
    | { namespace?: string }
    | undefined;
  const namespace = upjackMeta?.namespace;
  return {
    serverName,
    bundleName,
    version: manifest.version,
    description: manifest.description,
    state: "starting",
    trustScore: null,
    ui: null,
    briefing: null,
    protected: false,
    type: isUpjack ? "upjack" : "plain",
    wsId,
    ...(namespace ? { entityDataRoot: join(dataDir, namespace, "data") } : {}),
  };
}

/** Extract UI metadata from _meta["ai.nimblebrain/host"]. */
function extractUiMeta(manifest: BundleManifest): BundleUiMeta | null {
  const hostMeta = manifest._meta?.["ai.nimblebrain/host"] as HostManifestMeta | undefined;
  if (!hostMeta?.name) return null;
  const meta: BundleUiMeta = {
    name: hostMeta.name,
    icon: hostMeta.icon ?? "",
  };
  if (hostMeta.placements && hostMeta.placements.length > 0) {
    meta.placements = hostMeta.placements;
  }
  return meta;
}

/** Extract briefing metadata from _meta["ai.nimblebrain/host"].briefing. */
function extractBriefing(manifest: BundleManifest): BriefingBlock | null {
  const hostMeta = manifest._meta?.["ai.nimblebrain/host"] as HostManifestMeta | undefined;
  return hostMeta?.briefing ?? null;
}

/** Fetch trust score from mpak registry via SDK. Returns null on failure. */
async function fetchTrustScore(name: string, mpakHome: string): Promise<number | null> {
  try {
    const mpak = getMpak(mpakHome);
    const detail = await mpak.client.getBundle(name);
    const score = (detail as Record<string, unknown>).certification_level;
    return typeof score === "number" ? score : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atomic config read / write helpers
// ---------------------------------------------------------------------------

/** Read and parse the nimblebrain.json config file. */
function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

/**
 * Atomic config write: write to a temp file in the same directory, then rename.
 * This prevents partial writes from corrupting the config.
 */
function atomicWrite(configPath: string, config: Record<string, unknown>): void {
  const dir = dirname(configPath);
  const tmpPath = join(dir, `.nimblebrain.json.${process.pid}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmpPath, configPath);
}

/** Atomically add a bundle entry to the config. */
function atomicConfigAdd(configPath: string, entry: Record<string, unknown>): void {
  const config = readConfig(configPath);
  const bundles = (config.bundles ?? []) as Array<Record<string, unknown>>;
  const key = entry.name ?? entry.path ?? entry.url;
  if (!bundles.some((b) => (b.name ?? b.path ?? b.url) === key)) {
    bundles.push(entry);
    config.bundles = bundles;
    atomicWrite(configPath, config);
  }
}

/** Atomically remove a bundle entry from the config. */
function atomicConfigRemove(configPath: string, key: string): void {
  const config = readConfig(configPath);
  const bundles = (config.bundles ?? []) as Array<Record<string, unknown>>;
  config.bundles = bundles.filter((b) => b.name !== key && b.path !== key && b.url !== key);
  atomicWrite(configPath, config);
}

// ---------------------------------------------------------------------------
// Exported helpers for use outside the manager
// ---------------------------------------------------------------------------

export { extractUiMeta };
