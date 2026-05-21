import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../cli/log.ts";
import { cleanupComposioBundle } from "../composio/sdk.ts";
import type { EventSink } from "../engine/types.ts";
import type { PlacementRegistry } from "../runtime/placement-registry.ts";
import { FileCredentialStore } from "../tools/credential-store.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { UserPoolSource } from "../tools/user-pool-source.ts";
import {
  validateAdditionalAuthorizationParams,
  WorkspaceOAuthProvider,
} from "../tools/workspace-oauth-provider.ts";
import { WorkspaceContext } from "../workspace/context.ts";
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
import { startBundleSource } from "./startup.ts";
import type {
  BriefingBlock,
  BundleInstance,
  BundleManifest,
  BundleRef,
  BundleState,
  BundleUiMeta,
  HostManifestMeta,
  HttpProxyConfig,
  RemoteTransportConfig,
} from "./types.ts";

// ---------------------------------------------------------------------------
// BundleLifecycleManager — owns the state of all installed bundles and
// provides the formal install / uninstall / start / stop / restart flows
// described in PRODUCT_SPEC ss3.2-3.4.
// ---------------------------------------------------------------------------

export class BundleLifecycleManager {
  private instances = new Map<string, BundleInstance>();
  private placementRegistry: PlacementRegistry | null = null;
  /**
   * Getter for a workspace-scoped automations domain context. Set by
   * Runtime after the automations platform source is constructed. Used
   * by `syncBundleAutomations` / `removeBundleAutomations` to bypass the
   * LLM-facing tool surface — bundle-contributed schedules need to set
   * `source: "bundle"` and `bundleName`, which the LLM-facing schema
   * deliberately doesn't accept. See src/tools/platform/CLAUDE.md § 1.4.
   */
  private getAutomationsCtx:
    | (() => import("./automations/src/domain.ts").AutomationDomainContext)
    | null = null;

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
  setAutomationsContextGetter(
    getter: () => import("./automations/src/domain.ts").AutomationDomainContext,
  ): void {
    this.getAutomationsCtx = getter;
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
    // Pre-load so the manifest is in the mpak cache before startBundleSource
    // reads it. (startBundleSource itself only calls prepareServer; it
    // assumes the manifest is already cached.)
    const mpak = getMpak(this.mpakHome);
    await mpak.bundleCache.loadBundle(name);

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
      { dataDir: bundleDataDir, workspaceContext: wsContext },
    );
    if (!manifest) {
      // Named bundles always have a manifest — startBundleSource reads it
      // from the mpak cache. Null here is a precondition violation.
      throw new Error(`No manifest found for ${name} after install`);
    }

    // Host-capability gate runs inside startBundleSource (pre-spawn) so
    // every named/local install path is covered by construction. A
    // capability-mismatch throw above this line never spawns a subprocess.

    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    const instance = createInstance(sourceName, name, manifest, isUpjack, wsId, bundleDataDir);
    instance.configKey = name;
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
      { dataDir: bundleDataDir },
    );
    if (!manifest) {
      // Local bundles always have a manifest.json on disk; startBundleSource
      // reads and validates it before spawning. Null is a precondition
      // violation.
      throw new Error(`No manifest read for local bundle at ${bundlePath}`);
    }

    // Host-capability gate runs inside startBundleSource (pre-spawn).

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
      version: "remote",
      state: "starting",
      trustScore: trustScore ?? null,
      ui: ui ?? null,
      briefing: null,
      httpProxy: null,
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
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      throw new Error(`[lifecycle] bundle "${serverName}" not installed in workspace ${wsId}`);
    }
    if (!instance.ref || !("url" in instance.ref)) {
      throw new Error(`[lifecycle] missing URL ref for "${serverName}" — cannot construct source`);
    }
    const isWorkspaceScope = principalId === WORKSPACE_PRINCIPAL_ID;
    const expectedScope = isWorkspaceScope ? "workspace" : "user";
    const declaredScope = instance.oauthScope ?? "workspace";
    if (declaredScope !== expectedScope) {
      throw new Error(
        `[lifecycle] bundle "${serverName}" is ${declaredScope}-scoped — cannot start auth for principal "${principalId}"`,
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
      owner: isWorkspaceScope ? { type: "workspace", wsId } : { type: "user", userId: principalId },
      serverName,
      workDir: opts.workDir,
      // Workspace-scoped tokens route the credential directory through
      // the typed handle; user-scoped tokens stay on the legacy
      // workDir-derivation path (no workspace owns them).
      ...(isWorkspaceScope
        ? { workspaceContext: new WorkspaceContext({ wsId, workDir: opts.workDir }) }
        : {}),
      callbackUrl: opts.callbackUrl,
      allowInsecureRemotes: opts.allowInsecureRemotes === true,
      onInteractiveAuthRequired: (url) => {
        capturedAuthUrl = url;
        this.recordConnectionStateChange(serverName, wsId, principalId, "pending_auth", {
          authorizationUrl: url,
        });
        resolveAuthUrl(url);
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
    );

    // Wire the new source into the right place BEFORE start so any tool
    // call during the flow finds it (and gets a "starting" / "pending_auth"
    // structured error instead of "no source").
    if (isWorkspaceScope) {
      const registry = this.registriesByWs.get(wsId);
      if (registry && !registry.hasSource(serverName)) {
        registry.addSource(source);
      }
    } else {
      const pool = this.userPools.get(`${serverName}|${wsId}`);
      if (!pool) {
        throw new Error(
          `[lifecycle] member-pool not registered for "${serverName}" in ${wsId} — this is a boot-ordering bug`,
        );
      }
      await pool.setUserSource(principalId, source);
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
        const msg = err instanceof Error ? err.message : String(err);
        // For UnauthorizedError, the callback path already recorded
        // pending_auth — we don't want to overwrite that with `dead`.
        // Other errors (network, SSRF block, server crash) → record dead.
        if (!capturedAuthUrl) {
          this.recordConnectionStateChange(serverName, wsId, principalId, "dead", {
            lastError: msg,
          });
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
      return { authorizationUrl };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // Either branch resolved — cancel any provider fetches still in
      // flight. Success path: redirect-probe was about to be torn down
      // anyway. Timeout path: cuts an unresponsive server's TCP read
      // instead of letting it run its full network timeout in the
      // background.
      providerAbort.abort();
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
    const isWorkspaceScope = principalId === WORKSPACE_PRINCIPAL_ID;

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
    if (ref.composio && isWorkspaceScope) {
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
      owner: isWorkspaceScope ? { type: "workspace", wsId } : { type: "user", userId: principalId },
      serverName,
      workDir: opts.workDir,
      ...(isWorkspaceScope
        ? { workspaceContext: new WorkspaceContext({ wsId, workDir: opts.workDir }) }
        : {}),
      callbackUrl: "http://_/", // unused for revocation path
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
   * Stop and unwire the McpSource for one (bundle, principal) tuple.
   * Workspace-scope: `source.stop()` + remove from the workspace
   * registry. Member-scope: `pool.removeMember(principalId)` (which
   * stops the source internally and removes it from the pool's map).
   *
   * Idempotent: silently no-ops if no source is currently wired up.
   */
  private async teardownConnectionSource(
    serverName: string,
    wsId: string,
    principalId: string,
  ): Promise<void> {
    if (principalId === WORKSPACE_PRINCIPAL_ID) {
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
    } else {
      const pool = this.userPools.get(`${serverName}|${wsId}`);
      await pool?.removeUser(principalId);
    }
  }

  /**
   * Map of `(serverName|wsId)` → `UserPoolSource` for member-scoped
   * bundles. Populated by `seedInstance`; consumed by `startAuth` and
   * `disconnect`. Kept here (rather than reaching into the per-workspace
   * ToolRegistry) so lifecycle has direct access without coupling to a
   * specific registry shape.
   */
  private readonly userPools = new Map<string, UserPoolSource>();

  /**
   * Map of `wsId` → `ToolRegistry` for the workspace. Required so
   * `startAuth` / `disconnect` can wire workspace-scope sources into the
   * registry without callers having to thread the registry through every
   * lifecycle entry point. Set once at platform boot via
   * `setWorkspaceRegistries`; never mutated afterward.
   */
  private readonly registriesByWs = new Map<string, ToolRegistry>();

  /** Lookup helper — returns the pool for diagnostic / testing use. */
  getUserPool(serverName: string, wsId: string): UserPoolSource | undefined {
    return this.userPools.get(`${serverName}|${wsId}`);
  }

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

  /**
   * Wire workspace-membership lookups so user-scope install + boot can
   * find which workspaces a user belongs to. Lifecycle doesn't take
   * `WorkspaceStore` directly to avoid an import cycle and to keep its
   * dependency surface minimal — a single closure suffices.
   *
   * The closure returns workspace ids the user is a member of (any role
   * — install permissions are gated upstream at the tool layer).
   */
  setWorkspacesForUserResolver(resolver: (userId: string) => Promise<string[]>): void {
    this.workspacesForUser = resolver;
  }

  // ---- User-scope (personal connections) -----------------------------

  /**
   * Per-user `BundleInstance` map for personal connections. Keyed by
   * `(serverName, userId)`. Populated by `seedUserInstance` (boot +
   * install paths). Connection state on these instances tracks the
   * user's own auth lifecycle; the per-workspace `userPools` provide
   * the runtime tool dispatch surface.
   */
  private readonly userInstances = new Map<string, BundleInstance>();
  private workspacesForUser: ((userId: string) => Promise<string[]>) | null = null;

  /** Lookup helper for the user-scope BundleInstance map. */
  getUserInstance(serverName: string, userId: string): BundleInstance | undefined {
    return this.userInstances.get(`${serverName}|${userId}`);
  }

  /**
   * Register a personal connection for a user. Adds a `BundleInstance`
   * to the user-scope map and wires a `UserPoolSource` entry into every
   * workspace registry the user is a member of, so any workspace's
   * agent loop can dispatch tool calls through the user's source.
   *
   * Called from:
   *   - The `manage_connectors.install` tool action when a user
   *     installs a personal bundle.
   *   - Runtime boot, for every (user, bundle) pair discovered by
   *     walking `users/<userId>/user.json` files.
   */
  async seedUserInstance(serverName: string, ref: BundleRef, userId: string): Promise<void> {
    if (!("url" in ref)) {
      throw new Error(`[lifecycle] seedUserInstance requires a URL ref for "${serverName}"`);
    }
    const key = `${serverName}|${userId}`;
    let instance = this.userInstances.get(key);
    if (!instance) {
      instance = {
        serverName,
        bundleName: ref.url,
        version: "remote",
        state: "stopped",
        trustScore: null,
        ui: null,
        briefing: null,
        httpProxy: null,
        protected: false,
        type: "plain",
        wsId: "_user", // synthetic — user-scope instances aren't in any workspace
        oauthScope: "user",
        ref: { ...ref },
      };
      this.userInstances.set(key, instance);
    }

    if (!this.workspacesForUser) return; // boot ordering — caller will retry
    const wsIds = await this.workspacesForUser(userId);
    for (const wsId of wsIds) {
      const registry = this.registriesByWs.get(wsId);
      if (!registry) continue;

      // Each workspace gets one UserPoolSource per server name. The pool
      // dispatches to the per-user McpSource by principalId at call time.
      // Idempotent: existing pool is reused, only the user's slot is
      // populated/replaced.
      let pool = this.userPools.get(`${serverName}|${wsId}`);
      if (!pool) {
        pool = new UserPoolSource(serverName);
        this.userPools.set(`${serverName}|${wsId}`, pool);
        if (!registry.hasSource(serverName)) {
          registry.addSource(pool);
        }
        void pool.start().catch(() => {
          // Pool start is a no-op today; future-hook safe.
        });
      }
      // The per-user McpSource is constructed lazily on first call from
      // that user (via the tool router → pool.execute path) — we don't
      // wire it eagerly because users may never invoke a tool from this
      // bundle. The pool sees an empty entry until then.
    }
  }

  /**
   * Disconnect a user's personal connection. Revokes upstream tokens,
   * deletes local credentials, and removes the user's source from
   * every workspace pool they're registered in. The pool itself stays
   * (other users may still have this bundle); only this user's slot is
   * cleared. After disconnect, the bundle remains in the user's
   * `user.json` (use the install tool's `uninstall` action — when added —
   * to remove from the personal install list).
   */
  async disconnectUser(
    serverName: string,
    userId: string,
    opts: { workDir: string; allowInsecureRemotes?: boolean },
  ): Promise<{
    revoked: { access?: boolean; refresh?: boolean };
    deletedLocal: boolean;
    revokeError?: string;
  }> {
    const instance = this.userInstances.get(`${serverName}|${userId}`);
    if (!instance) {
      throw new Error(`[lifecycle] user "${userId}" has no personal "${serverName}" installed`);
    }
    const ref = instance.ref;
    if (!ref || !("url" in ref)) {
      throw new Error(`[lifecycle] missing URL ref for user-scope "${serverName}"`);
    }

    const provider = new WorkspaceOAuthProvider({
      owner: { type: "user", userId },
      serverName,
      workDir: opts.workDir,
      callbackUrl: "http://_/", // unused for revocation path
      allowInsecureRemotes: opts.allowInsecureRemotes === true,
    });
    const result = await provider.revokeAndDeleteTokens({ bundleUrl: ref.url });

    // Remove from every workspace pool this user is in.
    if (this.workspacesForUser) {
      const wsIds = await this.workspacesForUser(userId);
      for (const wsId of wsIds) {
        const pool = this.userPools.get(`${serverName}|${wsId}`);
        await pool?.removeUser(userId);
      }
    }

    // Note: we don't update the BundleInstance's connections map here —
    // user-scope state lives on `instance.connections.get(userId)`,
    // which is only populated when the user authenticates. Disconnect
    // before auth is a no-op for that map. After auth, recordConnectionStateChange
    // would be called via the user-scope startAuth path.

    return {
      revoked: result.revoked,
      deletedLocal: result.deletedLocal,
      ...(result.error ? { revokeError: result.error } : {}),
    };
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
    });
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
   * For URL bundles with `oauthScope: "user"`, an empty
   * `UserPoolSource` is constructed and registered in the supplied
   * `registry` so the bundle's name appears in tool routing — even
   * before any member has connected. The pool itself returns `tools()
   * = []` until a member's per-principal source connects (Track B
   * acceptance: agent sees no tools from the bundle until at least one
   * member connects, which matches the "Connect to access N tools"
   * affordance on the Connections page).
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
          httpProxy?: HttpProxyConfig | null;
          type: "upjack" | "plain";
          upjackNamespace?: string;
        }
      | undefined,
    wsId: string,
    dataDir?: string,
    /** Per-workspace ToolRegistry — used to register the UserPoolSource
     *  for member-scoped URL bundles. Optional for backward compat with
     *  test callers; production callers should always pass it. */
    registry?: ToolRegistry,
  ): void {
    // Resolve entity data root from dataDir + upjack namespace. `dataDir` is
    // already the canonical bundle-data parent (slug = manifest.name) thanks
    // to `resolveBundleDataDirForRef` at every caller — buildProcessInventory,
    // installLocal, installNamed, installBundleInWorkspace. No re-derivation
    // here: launcher and reader agree by construction.
    const entityDataRoot =
      dataDir && manifestMeta?.upjackNamespace
        ? join(dataDir, manifestMeta.upjackNamespace, "data")
        : undefined;

    // Resolve oauthScope for URL bundles. Member-scoped bundles seed with
    // an empty connections map — Connections are created on-demand when
    // each member calls a tool or hits Connect from the UI.
    const oauthScope: BundleInstance["oauthScope"] | undefined =
      "url" in ref ? (ref.oauthScope ?? "workspace") : undefined;

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
      httpProxy: manifestMeta?.httpProxy ?? null,
      protected: ref.protected ?? false,
      type: manifestMeta?.type ?? "plain",
      wsId,
      ...(oauthScope !== undefined ? { oauthScope } : {}),
      ...(entityDataRoot !== undefined ? { entityDataRoot } : {}),
      // URL bundles only — needed for member-scope to reconstruct per-
      // member McpSources on-demand (URL, transport config, eventually
      // oauthClient + scopes). Stored as an opaque copy.
      ...("url" in ref ? { ref: { ...ref } } : {}),
    };
    const key = `${serverName}|${wsId}`;
    this.instances.set(key, instance);

    // For URL bundles, derive the boot-time Connection state.
    if ("url" in ref) {
      if (oauthScope === "user") {
        // Construct + register the per-bundle UserPoolSource so the
        // bundle exists in the workspace registry from boot. Per-member
        // McpSources are added to the pool lazily as members connect
        // (`startMemberAuth` below). Without this registration the
        // bundle would be invisible to the agent's tool list until a
        // member connected — which is too late.
        const pool = new UserPoolSource(serverName);
        this.userPools.set(`${serverName}|${wsId}`, pool);
        // Pool's start() is a no-op; calling it for symmetry / future
        // hooks. Errors here are unrecoverable so we log + continue.
        void pool.start().catch((err) => {
          log.warn(
            `[lifecycle] member-pool start failed for ${serverName}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        if (registry && !registry.hasSource(serverName)) {
          registry.addSource(pool);
        }
        // No auto-Connection at boot — connections.size = 0 and the
        // BundleInstance.state stays in its default. Members create
        // their own Connections on-demand via Connect.
        instance.state = "stopped";
        return;
      }
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
    httpProxy: null,
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
