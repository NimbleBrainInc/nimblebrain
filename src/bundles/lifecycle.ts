import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../cli/log.ts";
import { clearAllWorkspaceCredentials } from "../config/workspace-credentials.ts";
import type { EventSink } from "../engine/types.ts";
import type { PlacementRegistry } from "../runtime/placement-registry.ts";
import { FileCredentialStore } from "../tools/credential-store.ts";
import { McpSource } from "../tools/mcp-source.ts";
import { MemberPoolSource } from "../tools/member-pool-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  validateAdditionalAuthorizationParams,
  WorkspaceOAuthProvider,
} from "../tools/workspace-oauth-provider.ts";
import { createAutomation, deleteAutomation } from "./automations/src/domain.ts";
import { type Connection, type ConnectionState, summarizeConnectionState } from "./connection.ts";
import { getMpak } from "./mpak.ts";
import { deriveBundleDataDir, deriveServerName } from "./paths.ts";
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
    // bundle from stomping on each other's entity data. Matches the
    // seedInstance layout used at platform boot.
    const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
    const bundleDataDir = join(nbWorkDir, "workspaces", wsId, "data", deriveBundleDataDir(name));

    const { sourceName, manifest } = await startBundleSource(
      { name, env },
      registry,
      this.eventSink,
      this.configPath ? dirname(this.configPath) : undefined,
      { dataDir: bundleDataDir, wsId, workDir: nbWorkDir },
    );
    if (!manifest) {
      // Named bundles always have a manifest — startBundleSource reads it
      // from the mpak cache. Null here is a precondition violation.
      throw new Error(`No manifest found for ${name} after install`);
    }

    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    const instance = createInstance(sourceName, name, manifest, isUpjack, wsId);
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
    const { sourceName, manifest } = await startBundleSource(
      { path: bundlePath, env },
      registry,
      this.eventSink,
      this.configPath ? dirname(this.configPath) : undefined,
    );
    if (!manifest) {
      // Local bundles always have a manifest.json on disk; startBundleSource
      // reads and validates it before spawning. Null is a precondition
      // violation.
      throw new Error(`No manifest read for local bundle at ${bundlePath}`);
    }

    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    // Use manifest.name (scoped name) as bundleName, not the filesystem path.
    const instance = createInstance(sourceName, manifest.name, manifest, isUpjack, wsId);
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
    const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");

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
      const workDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
      try {
        await clearAllWorkspaceCredentials(instance.wsId, instance.bundleName, workDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[lifecycle] Failed to clear credentials for ${instance.bundleName} in ${instance.wsId}: ${msg}\n`,
        );
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
   * Lookup helper used by `/v1/mcp-auth/initiate` to find the
   * authorization URL for a `(wsId, serverName, principalId)` tuple.
   *
   * Returns the URL only if the named Connection is in `pending_auth` —
   * any other state means we have no business handing out a URL (would
   * either be stale, a leak, or a bug). Caller should treat `null` as
   * "this connection is not awaiting auth right now."
   */
  getPendingAuthUrl(serverName: string, wsId: string, principalId: string): string | null {
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance?.connections) return null;
    const conn = instance.connections.get(principalId);
    if (!conn || conn.state !== "pending_auth" || !conn.authorizationUrl) return null;
    return conn.authorizationUrl;
  }

  /**
   * Snapshot of all Connections currently in `pending_auth` for a
   * workspace. Used by `GET /v1/connections/pending` so the web client
   * can populate its banner state on first render — `connection.state_changed`
   * SSE events only fire from this point forward, so a client that
   * connects after the bundle entered pending_auth would otherwise miss
   * the signal until the user reloads.
   *
   * Excludes the authorizationUrl from the response (the client gets it
   * later via POST /v1/mcp-auth/initiate, which sets the session-bound
   * state cookie at the same time).
   */
  getPendingConnections(
    wsId: string,
  ): Array<{ serverName: string; bundleName: string; principalId: string }> {
    const out: Array<{ serverName: string; bundleName: string; principalId: string }> = [];
    for (const instance of this.instances.values()) {
      if (instance.wsId !== wsId || !instance.connections) continue;
      for (const conn of instance.connections.values()) {
        if (conn.state === "pending_auth") {
          out.push({
            serverName: instance.serverName,
            bundleName: instance.bundleName,
            principalId: conn.principalId,
          });
        }
      }
    }
    return out;
  }

  /**
   * Start an interactive OAuth flow for a member-scoped URL bundle.
   *
   * Constructs a per-member `WorkspaceOAuthProvider` + `McpSource`, adds
   * the source to the bundle's `MemberPoolSource`, kicks off
   * `source.start()` in the background, and waits up to 15s for the
   * provider's interactive callback to fire (which records pending_auth
   * + populates `Connection.authorizationUrl`).
   *
   * Resolves with the authorization URL the caller should send the
   * user's browser to. Throws if:
   *   - bundle isn't installed in this workspace
   *   - bundle isn't `oauthScope: "member"`
   *   - principalId is invalid or `_workspace`
   *   - the bundle's URL ref is missing (shouldn't happen post-seed)
   *   - the auth flow fails to enter pending_auth within the timeout
   *     (server is unreachable, AS doesn't redirect us anywhere
   *     interactive, etc.)
   *
   * If the member already has a pending_auth Connection with an
   * authorization URL, returns that URL without starting a new flow —
   * the existing buffered URL is still valid (15min TTL on the
   * registry); reuse avoids racing duplicate authorize requests when a
   * user double-clicks Connect.
   */
  async startMemberAuth(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string }> {
    if (principalId === "_workspace") {
      throw new Error(
        `[lifecycle] startMemberAuth requires a member principal id, got "_workspace"`,
      );
    }
    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) {
      throw new Error(`[lifecycle] bundle "${serverName}" not installed in workspace ${wsId}`);
    }
    if (instance.oauthScope !== "member") {
      throw new Error(
        `[lifecycle] bundle "${serverName}" is not member-scoped (oauthScope="${instance.oauthScope ?? "workspace"}")`,
      );
    }
    if (!instance.ref || !("url" in instance.ref)) {
      throw new Error(`[lifecycle] missing URL ref for "${serverName}" — cannot construct source`);
    }

    // Reuse an existing pending_auth URL if present (debounce double-clicks).
    const existingConn = instance.connections?.get(principalId);
    if (existingConn?.state === "pending_auth" && existingConn.authorizationUrl) {
      return { authorizationUrl: existingConn.authorizationUrl };
    }
    if (existingConn?.state === "running") {
      throw new Error(
        `[lifecycle] member "${principalId}" already connected to "${serverName}" — disconnect before reconnecting`,
      );
    }

    // Look up the pool — must exist (registered at seed time for member-scope).
    // We don't have a direct registry reference here, but `setMemberSource`
    // is called below by way of the Connection bookkeeping; the pool
    // discovery lives in a separate helper (`attachMemberSourceToPool`)
    // wired by Runtime when the registries map is built.
    const pool = this.memberPools.get(`${serverName}|${wsId}`);
    if (!pool) {
      throw new Error(
        `[lifecycle] member-pool not registered for "${serverName}" in ${wsId} — this is a boot-ordering bug`,
      );
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

    const ref = instance.ref;
    if (!("url" in ref)) {
      throw new Error(`[lifecycle] startMemberAuth: ref is not a URL ref for ${serverName}`);
    }

    // Track A: resolve pre-registered client config (oauthClient + scopes
    // + additionalAuthorizationParams) for member-scope bundles. The
    // boot-time resolution in startup.ts handles workspace-scope; here
    // we replicate it so member-scope bundles can also use static-client
    // OAuth. Same credential-store dereference path; same provider
    // surface.
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

    const provider = new WorkspaceOAuthProvider({
      wsId,
      serverName,
      workDir: opts.workDir,
      memberId: principalId,
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

    // Add to pool BEFORE start so any tool calls during the flow find
    // the source (and get a "starting" / "pending_auth" structured error
    // instead of "no member source").
    await pool.setMemberSource(principalId, source);
    this.recordConnectionStateChange(serverName, wsId, principalId, "starting", {
      source,
    });

    // Background start. The provider's callback will resolve `authUrlPromise`
    // when interactive auth is required. If start() succeeds without ever
    // hitting interactive (headless / pre-authenticated), we transition to
    // running and reject the auth URL promise (caller wasn't expecting that
    // path; they should call /v1/connections/installed to refresh state).
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
        () => rej(new Error(`[lifecycle] startMemberAuth timed out after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      );
    });
    try {
      const authorizationUrl = await Promise.race([authUrlPromise, timeout]);
      return { authorizationUrl };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Map of `(serverName|wsId)` → `MemberPoolSource` for member-scoped
   * bundles. Populated by `seedInstance`; consumed by `startMemberAuth`
   * and the disconnect flow. Kept here (rather than reaching into the
   * per-workspace ToolRegistry) so lifecycle has direct access without
   * coupling to a specific registry shape.
   */
  private readonly memberPools = new Map<string, MemberPoolSource>();

  /** Lookup helper — returns the pool for diagnostic / testing use. */
  getMemberPool(serverName: string, wsId: string): MemberPoolSource | undefined {
    return this.memberPools.get(`${serverName}|${wsId}`);
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
   * Seed instances from the initial bundle startup (called by Runtime.start
   * after bundles are already running).
   *
   * For URL bundles with `oauthScope: "member"`, an empty
   * `MemberPoolSource` is constructed and registered in the supplied
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
    /** Per-workspace ToolRegistry — used to register the MemberPoolSource
     *  for member-scoped URL bundles. Optional for backward compat with
     *  test callers; production callers should always pass it. */
    registry?: ToolRegistry,
  ): void {
    // Resolve entity data root from dataDir + upjack namespace at seed time.
    // This is the single source of truth — downstream consumers read it directly.
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
      if (oauthScope === "member") {
        // Construct + register the per-bundle MemberPoolSource so the
        // bundle exists in the workspace registry from boot. Per-member
        // McpSources are added to the pool lazily as members connect
        // (`startMemberAuth` below). Without this registration the
        // bundle would be invisible to the agent's tool list until a
        // member connected — which is too late.
        const pool = new MemberPoolSource(serverName);
        this.memberPools.set(`${serverName}|${wsId}`, pool);
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
      // Workspace-scope: existing behavior. If the bundle hit interactive
      // OAuth during boot (before lifecycle existed), the URL was buffered
      // by `pending-auth-buffer`; consume it here and transition to
      // `pending_auth`. Otherwise record `running`.
      const pendingAuthUrl = consumePendingAuth(wsId, serverName);
      if (pendingAuthUrl) {
        this.recordConnectionStateChange(serverName, wsId, "_workspace", "pending_auth", {
          authorizationUrl: pendingAuthUrl,
        });
      } else {
        this.recordConnectionStateChange(serverName, wsId, "_workspace", "running");
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
): BundleInstance {
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
