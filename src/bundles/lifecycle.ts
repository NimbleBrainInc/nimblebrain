import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConnectorSkillsConfig } from "../config/connector-skills.ts";
import type { ManagedConnectorProvider } from "../connectors/providers/managed-provider.ts";
import {
  type ManagedConnectorRegistry,
  managedConnectorRegistryOf,
} from "../connectors/providers/registry.ts";
import type { EventSink } from "../engine/types.ts";
import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { IdentityConnectorStore } from "../identity/connector-store.ts";
import { fleetIssuerOption } from "../oauth/fleet-assertion.ts";
import { mcpAuthCallbackUrl } from "../oauth/mcp-callback-url.ts";
import { log } from "../observability/log.ts";
import type { PlacementRegistry } from "../runtime/placement-registry.ts";
import { resolveOverlay } from "../skills/connector-skill-resolver.ts";
import {
  CONNECTOR_SKILLS_SUBDIR,
  materializeConnectorSkill,
  removeConnectorSkillsForServer,
} from "../skills/connector-skill-store.ts";
import { personalConnectorWireName } from "../tools/identity-sources.ts";
import { hasMcpOAuthTokens, McpOAuthRecords } from "../tools/mcp-oauth-records.ts";
import { McpSource } from "../tools/mcp-source.ts";
import { SharedSourceRef, ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import { WorkspaceOAuthProvider } from "../tools/workspace-oauth-provider.ts";
import { validateAdditionalAuthorizationParams } from "../util/oauth-params.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { resolveWorkspaceDisplayName } from "../workspace/workspace-store.ts";
import { brokeredConnectorDir, brokeredRef } from "./brokered.ts";
import { brokeredConnectionPresent, bundleHasStaticAuth } from "./bundle-auth.ts";
import {
  type Connection,
  type ConnectionState,
  summarizeConnectionState,
  WORKSPACE_PRINCIPAL_ID,
} from "./connection.ts";
import { sanitizePlacements } from "./defaults.ts";
import { resolveStaticOAuthClient, type StaticOAuthClient } from "./oauth-static-client.ts";
import { defaultWorkDir, deriveServerName, validateServerName } from "./paths.ts";
import { consumePendingAuth } from "./pending-auth-buffer.ts";
import {
  type BundleMcpDeps,
  buildUrlOAuthProvider,
  composeBundleMcpContext,
  resolveRefTransport,
  startBundleSource,
} from "./startup.ts";
import type {
  BriefingBlock,
  BrokeredRef,
  BundleInstance,
  BundleRef,
  BundleState,
  BundleUiMeta,
  ConnectorSkillLockEntry,
} from "./types.ts";

/** What an unbound lifecycle reads: no workspace has a registry. */
const NO_WORKSPACE_REGISTRIES: ReadonlyMap<string, ToolRegistry> = new Map();

/** Manifest-derived metadata `seedInstance` accepts for a bundle it is seeding,
 *  running or not. */
type SeedManifestMeta = {
  manifestName?: string;
  version: string;
  description?: string;
  ui: BundleUiMeta | null;
  briefing?: BriefingBlock | null;
};

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
 * A user-initiated interactive connect (`startIdentityAuth`) can't start a clean
 * OAuth flow because a start for the same `(userId, serverName)` is already in
 * flight, or the source is already connected. Retriable and NOT a server fault —
 * the caller should back off and retry, not read logs. Surfaced as a `409` at
 * the route layer.
 */
export class ConnectorBusyError extends Error {
  readonly serverName: string;
  readonly userId: string;
  constructor(serverName: string, userId: string) {
    super(
      `[lifecycle] "${serverName}" is already connecting or connected for ${userId} — retry shortly`,
    );
    this.name = "ConnectorBusyError";
    this.serverName = serverName;
    this.userId = userId;
  }
}

/**
 * Assert a `BundleRef` read from disk conforms to the post-Stage-2 schema.
 * Throws `LegacyOAuthScopeError` on encounter — does not translate. The
 * deploy runbook is the operator contract; the runtime stays strict.
 */
export function assertBundleRefIsPostStage2(ref: BundleRef): void {
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
  private authFlowsInFlight = new Map<string, Promise<{ authorizationUrl: string | null }>>();
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

  /**
   * Notified when a workspace connection reaches `running`.
   *
   * Wired by the runtime at construction ({@link setConnectionRunningObserver})
   * so the hooks reconcile can run at the one moment both halves it needs are
   * true: a live source to hand a URL to, and a connector whose declarations
   * can be read. It exists as a settable observer rather than a direct call so
   * the lifecycle keeps knowing nothing about hooks, the workspace store, or
   * the connector catalog — the same shape as `setBundleMcpDepsFactory` above.
   *
   * Must not throw and must not block: it is called synchronously from a state
   * transition on the hot connection path.
   */
  private onConnectionRunning: ((wsId: string, serverName: string) => void) | null = null;

  /**
   * Fetch used to resolve curated connector-skill overlays. Defaults to
   * global `fetch`; tests inject a fixture via {@link setConnectorSkillFetch}
   * so overlay binding stays hermetic (no network).
   */
  private connectorSkillFetch: typeof fetch = fetch;

  /**
   * The runtime's resolved work directory (`resolveWorkDir(config)`), wired by
   * Runtime after construction. Connector-skill cleanup on uninstall must use
   * THIS — not `defaultWorkDir()` — so it matches where install
   * (`runtime.getWorkDir()`) and the per-turn loader (`WorkspaceContext`)
   * resolve the `connector-skills/` store: those honor `config.workDir`, while
   * `defaultWorkDir()` only reads `NB_WORK_DIR`/`~/.nimblebrain`. The two
   * diverge when an operator sets `workDir` in `nimblebrain.json` with
   * `NB_WORK_DIR` unset. Null in minimal/test runtimes that don't wire it →
   * falls back to `defaultWorkDir()` (where the two coincide).
   */
  private resolvedWorkDir: string | null = null;

  /**
   * The configured brokered providers, wired by Runtime after construction.
   *
   * Empty until wired, which is the honest default for a minimal/test runtime
   * that configures no broker: with no provider registered, brokered teardown
   * and boot-state derivation fall back to what the kernel can do alone
   * (removing the credential directory; the generic auth check). A lifecycle
   * that IS running brokered connectors but was never handed the registry would
   * silently skip upstream revocation, so the skip is logged where it happens.
   */
  private managedConnectors: ManagedConnectorRegistry = managedConnectorRegistryOf([]);

  constructor(
    private eventSink: EventSink,
    private configPath: string | undefined,
    private allowInsecureRemotes = false,
  ) {}

  /** Inject the fetch used for connector-skill overlay resolution (tests). */
  setConnectorSkillFetch(fetchImpl: typeof fetch): void {
    this.connectorSkillFetch = fetchImpl;
  }

  /** Wire the runtime's resolved work directory (called by Runtime after construction). */
  setWorkDir(workDir: string): void {
    this.resolvedWorkDir = workDir;
  }

  /** Wire the configured managed-connector providers (called by Runtime after construction). */
  setManagedConnectorRegistry(registry: ManagedConnectorRegistry): void {
    this.managedConnectors = registry;
  }

  /**
   * The provider that owns this ref's brokered install, plus the ref itself.
   * `undefined` for a runtime-native ref, or for a brokered one whose provider
   * this deployment has not configured — the latter is logged, because it is
   * the case where a teardown or a probe silently does less than it should.
   */
  private brokeredProvider(
    ref: BundleRef | undefined,
    context: string,
  ): { provider: ManagedConnectorProvider; brokered: BrokeredRef } | undefined {
    const brokered = brokeredRef(ref);
    if (!brokered) return undefined;
    const provider = this.managedConnectors.get(brokered.provider);
    if (!provider) {
      log.warn(
        `[lifecycle] ${context}: no "${brokered.provider}" managed-connector provider is ` +
          `registered — skipping its half for ${brokered.connectorId}`,
      );
      return undefined;
    }
    return { provider, brokered };
  }

  /** Set the PlacementRegistry (called by Runtime after construction). */
  setPlacementRegistry(pr: PlacementRegistry): void {
    this.placementRegistry = pr;
  }

  /**
   * Wire the host-resources deps factory. Called by Runtime once the
   * resolver + rate-limit are constructed. When unset, sources start
   * without inbound `ai.nimblebrain/resources/*` handlers registered; a
   * server that needs them probes at runtime and adapts.
   */
  setBundleMcpDepsFactory(factory: (wsId: string) => BundleMcpDeps): void {
    this.getBundleMcpDeps = factory;
  }

  /**
   * Fire the connection-reached-running observer, for workspace connections only.
   *
   * A per-user (identity-plane) connection has no workspace-scoped hook to
   * provision, so it is not a transition anyone here is waiting for. Guarded
   * because this runs synchronously inside a state transition: an observer that
   * throws must not be able to take one down.
   */
  private notifyConnectionRunning(
    serverName: string,
    wsId: string,
    principalId: string,
    newState: ConnectionState,
  ): void {
    if (newState !== "running" || principalId !== WORKSPACE_PRINCIPAL_ID) return;
    if (!this.onConnectionRunning) return;
    try {
      this.onConnectionRunning(wsId, serverName);
    } catch (err) {
      log.warn("[lifecycle] connection-running observer threw", {
        serverName,
        wsId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Register the connection-reached-running observer. See the field doc. */
  setConnectionRunningObserver(observer: (wsId: string, serverName: string) => void): void {
    this.onConnectionRunning = observer;
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

  // ---- Connector-skill binding -------------------------------------

  /**
   * Resolve and materialize the curated overlay bound to a connector identity,
   * if one is curated. Called at install time; the returned lock entries are
   * recorded on the bundle's `BundleRef.skillsLock` so uninstall can clean up
   * and the dedupe path knows the connector has an overlay.
   *
   * Best-effort and NON-FATAL: a missing overlay (404), an unparseable overlay,
   * or any fetch/IO error returns `[]` and never throws —
   * the connector install must not fail because its optional guidance couldn't
   * be fetched. The overlay materializes into the workspace's `connector-skills/`
   * store and is surfaced into the conversation only on first matching tool call.
   */
  async syncBoundSkills(
    identity: string,
    serverName: string,
    wsId: string,
    workDir: string,
  ): Promise<ConnectorSkillLockEntry[]> {
    const config = resolveConnectorSkillsConfig();
    try {
      const cacheDir = join(workDir, "cache", "connector-skills");
      const resolved = await resolveOverlay(identity, {
        cacheDir,
        repo: config.repo,
        version: config.version,
        fetchImpl: this.connectorSkillFetch,
      });
      if (!resolved) return []; // No overlay curated for this connector — no-op.

      const connectorSkillsDir = new WorkspaceContext({ wsId, workDir }).getDataPath(
        CONNECTOR_SKILLS_SUBDIR,
      );
      const materialized = materializeConnectorSkill({
        connectorSkillsDir,
        serverName,
        overlayBody: resolved.body,
        source: `connector:${identity}@${config.version}`,
        now: new Date().toISOString(),
      });
      if (!materialized) return [];

      log.debug("mcp", `[connector-skills] bound overlay "${identity}" → ${serverName} (${wsId})`);
      return [{ identity, version: config.version, sha: resolved.sha, path: materialized.path }];
    } catch (err) {
      // Non-fatal: the connector is installed regardless. Surface the reason so
      // an operator can see why an expected overlay didn't bind.
      log.warn(
        `[connector-skills] failed to bind overlay "${identity}" for ${serverName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * Remove every materialized connector overlay bound to a server. Called
   * on uninstall; the `BundleRef.skillsLock` itself is dropped with the bundle
   * entry. Best-effort — a missing store is a no-op.
   */
  removeBoundSkills(serverName: string, wsId: string, workDir: string): void {
    try {
      const connectorSkillsDir = new WorkspaceContext({ wsId, workDir }).getDataPath(
        CONNECTOR_SKILLS_SUBDIR,
      );
      removeConnectorSkillsForServer(connectorSkillsDir, serverName);
    } catch (err) {
      log.warn(
        `[connector-skills] failed to remove overlays for ${serverName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---- Uninstall ---------------------------------------------------------

  /**
   * Uninstall a bundle (PRODUCT_SPEC ss3.4). Every connector is user-removable —
   * there is no `protected` guard.
   *
   * 1. Stop MCP server
   * 2. Remove source from ToolRegistry
   * 3. Remove entry from nimblebrain.json
   * 4. Emit bundle.uninstalled
   * 5. Data is NOT deleted
   */
  async uninstall(nameOrPath: string, registry: ToolRegistry, wsId: string): Promise<void> {
    const { serverName, instance } = this.resolveUninstallTarget(nameOrPath, wsId);

    // Stop server, remove from registry. Every connector is user-removable
    // (no `protected` guard — install/uninstall is symmetric for all classes).
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

    // Track state change before removing
    if (instance) {
      this.transition(instance, "stopped");
      this.instances.delete(`${serverName}|${wsId}`);
    }

    // Step 4c — Clean up workspace-scoped credentials (best-effort).
    // Credentials are config, not data — they should not persist across
    // uninstalls. Data directories are preserved (step 6).
    if (instance) {
      await this.cleanupBundleCredentials(instance, serverName);
    }

    // Step 4d — Remove materialized connector-skill overlays. Keyed on
    // serverName so it cleans up even when the instance was already lost; the
    // `skillsLock` on the dropped BundleRef goes with the config entry above.
    // Uses the runtime's resolved workDir (NOT `defaultWorkDir()`) so it
    // targets the same `connector-skills/` store install/load wrote to under a
    // `nimblebrain.json` `workDir`. See `resolvedWorkDir`.
    this.removeBoundSkills(
      serverName,
      instance?.wsId ?? wsId,
      this.resolvedWorkDir ?? defaultWorkDir(),
    );

    // Step 5 — Emit event (data NOT deleted — step 6)
    this.eventSink.emit({
      type: "bundle.uninstalled",
      data: { serverName, bundleName: nameOrPath, wsId },
    });
  }

  /**
   * Resolve the `(serverName, instance)` an uninstall targets. Resolves by
   * `(serverName, wsId)` first; falls back to a `bundleName` match within this
   * workspace. Lookups are always workspace-scoped — uninstalling in one
   * workspace must not affect another workspace's instance of the same bundle.
   */
  private resolveUninstallTarget(
    nameOrPath: string,
    wsId: string,
  ): { serverName: string; instance: BundleInstance | undefined } {
    const serverName = deriveServerName(nameOrPath);
    const direct = this.instances.get(`${serverName}|${wsId}`);
    if (direct) return { serverName, instance: direct };
    for (const inst of this.instances.values()) {
      if (inst.wsId === wsId && inst.bundleName === nameOrPath) {
        return { serverName: inst.serverName, instance: inst };
      }
    }
    return { serverName, instance: undefined };
  }

  /**
   * Best-effort teardown of a connector's workspace-scoped credentials on
   * uninstall: the OAuth records, and — for a brokered connector — the
   * provider's upstream connection plus its credential dir. Credentials are
   * config, not data; data dirs are preserved. Every step is guarded so one
   * failure can't sink the others.
   */
  private async cleanupBundleCredentials(
    instance: BundleInstance,
    serverName: string,
  ): Promise<void> {
    // The runtime's resolved workDir, not `defaultWorkDir()` — install and the
    // OAuth callback wrote under `runtime.getWorkDir()`, and the two diverge
    // exactly when an operator sets `workDir` in `nimblebrain.json` without
    // `NB_WORK_DIR`. Clearing the wrong root leaves every credential behind.
    // Same rule as `seedUrlConnectionState`.
    const workDir = this.resolvedWorkDir ?? defaultWorkDir();
    // Drop the OAuth records as defense-in-depth. Uninstall normally follows a
    // `disconnect` (which invalidates "all" including the client record), but a
    // leftover from a partial earlier disconnect shouldn't survive an
    // uninstall. Worst case the keys are already gone; `deleteAll` is a no-op
    // then.
    try {
      await new McpOAuthRecords({
        owner: { type: "workspace", wsId: instance.wsId },
        serverName,
        workDir,
      }).deleteAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[lifecycle] Failed to clear OAuth state for ${serverName} in ${instance.wsId}: ${msg}\n`,
      );
    }
    await this.cleanupBrokeredState(instance, serverName, workDir);
  }

  /**
   * Tear down a brokered bundle's provider-side state on uninstall: the
   * provider revokes its connection (and any upstream grant the broker holds)
   * and drops whatever it keeps locally, then the kernel removes the connector's
   * credential directory to match the OAuth-records posture.
   *
   * Without this, uninstall-without-prior-disconnect — the realistic flow, since
   * users don't disconnect first — would leak local disk state and leave the
   * upstream connection alive at the broker forever, with no revoke path left in
   * the product once the ref naming it is gone. Best-effort: each step is
   * guarded, and `cleanup` never throws by contract.
   */
  private async cleanupBrokeredState(
    instance: BundleInstance,
    serverName: string,
    workDir: string,
  ): Promise<void> {
    const brokered = brokeredRef(instance.ref);
    if (!brokered) return;
    const owner: ConnectorOwner = { type: "workspace", wsId: instance.wsId };

    const resolved = this.brokeredProvider(instance.ref, "uninstall");
    if (resolved?.provider.cleanup) {
      try {
        const { lastError } = await resolved.provider.cleanup({ owner, brokered, workDir });
        if (lastError) {
          process.stderr.write(
            `[lifecycle] Failed to revoke the ${brokered.provider} connection for "${serverName}" ` +
              `in ${instance.wsId}: ${lastError}\n`,
          );
        }
      } catch (err) {
        // `cleanup` never throws by contract; guard anyway so a provider bug
        // can't sink the uninstall.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[lifecycle] Failed to revoke the ${brokered.provider} connection for "${serverName}" ` +
            `in ${instance.wsId}: ${msg}\n`,
        );
      }
    }

    // The directory rule is the kernel's, so removing it is too — and it runs
    // whether or not a provider was registered to revoke upstream.
    try {
      rmSync(brokeredConnectorDir(workDir, owner, brokered.provider, brokered.connectorId), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[lifecycle] Failed to clear the ${brokered.provider} credential dir for ${serverName} ` +
          `in ${instance.wsId}: ${msg}\n`,
      );
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
    opts?: { authorizationUrl?: string; lastError?: string },
  ): void {
    // Release the OAuth-flow coalesce slot on any TERMINAL transition — ABOVE the
    // instance lookup so an instance removed mid-flight (uninstall / re-key) still
    // frees the slot. A headless success resolves the auth-URL promise without
    // rejecting, so `startAuth`'s `flow.catch()` CAS never fires — this terminal
    // transition is the sole slot-release path, so it must run whether or not the
    // instance is still tracked. Gated below the early return, a disappeared instance
    // would wedge a permanently-resolved flow in the slot and every later `startAuth`
    // for this key would short-circuit to it (Reconnect a silent no-op until restart).
    // `starting` / `pending_auth` are NOT terminal (the coalescing windows);
    // `Map.delete` is idempotent. See the `authFlowsInFlight` field comment.
    if (AUTH_FLOW_TERMINAL_STATES.has(newState)) {
      this.authFlowsInFlight.delete(authFlowKey(serverName, wsId, principalId));
    }

    const instance = this.instances.get(`${serverName}|${wsId}`);
    if (!instance) return;
    if (!instance.connections) instance.connections = new Map<string, Connection>();

    const existing = instance.connections.get(principalId);
    const next: Connection = {
      principalId,
      state: newState,
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

    this.notifyConnectionRunning(serverName, wsId, principalId, newState);

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
   * promise resolves with it; otherwise (headless / pre-authenticated
   * path) the source connects, transitions to `running`, and the auth
   * URL promise resolves with `null` — a success the route surfaces as
   * "already connected" (#679).
   */
  async startAuth(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string | null }> {
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
  ): Promise<{ authorizationUrl: string | null }> {
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
    // + scopes + additionalAuthorizationParams). Dereferences the client
    // secret from the workspace credential store when present.
    const ref = instance.ref;
    const staticClient = await resolveStaticOAuthClient({
      ref,
      wsId,
      serverName,
    });

    // Construct provider with our pending-auth callback. The callback
    // fires synchronously inside `redirectToAuthorization` BEFORE the
    // provider throws UnauthorizedError, so it always runs before
    // McpSource.start() returns (or its background promise resolves).
    let capturedAuthUrl: string | undefined;
    // Resolves with the interactive authorization URL, or `null` when the source
    // connected WITHOUT an interactive flow (a provider-minted / pre-authenticated
    // source) — a success the route surfaces as "already connected" (#679).
    let resolveAuthUrl!: (url: string | null) => void;
    let rejectAuthUrl!: (err: Error) => void;
    const authUrlPromise = new Promise<string | null>((res, rej) => {
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

    // Human-readable workspace name for the vendor's consent screen, in
    // place of the opaque wsId. Best-effort — falls back to the id.
    const ownerDisplayName = await resolveWorkspaceDisplayName(opts.workDir, wsId);

    const provider = this.buildWorkspaceOAuthProvider({
      serverName,
      wsId,
      principalId,
      opts,
      ref,
      ownerDisplayName,
      staticClient,
      providerAbort,
      onInteractiveAuthRequired: (url) => {
        capturedAuthUrl = url;
        this.recordConnectionStateChange(serverName, wsId, principalId, "pending_auth", {
          authorizationUrl: url,
        });
        resolveAuthUrl(url);
      },
    });
    const source = new McpSource(
      serverName,
      {
        type: "remote",
        url: new URL(ref.url),
        // Mapped, like the boot path: unlike the identity flow below, this one
        // builds its OAuth provider unconditionally, so a Composio ref with a
        // legacy env-template auth can reach here (Reconnect / `/v1/mcp-auth/
        // initiate`) and would otherwise resolve an empty `x-api-key`.
        transportConfig: resolveRefTransport(ref).transportConfig,
        // Honor the per-call flag, same source the OAuth provider above and the
        // startup-time validateBundleUrl use — not the manager default — so the
        // transport's SSRF guard agrees with what this install was authorized for.
        allowInsecure: opts.allowInsecureRemotes === true,
        authProvider: provider,
      },
      this.eventSink,
      composeBundleMcpContext(this.resolveBundleMcpDeps(wsId), serverName),
    );

    // Wire the new source into the workspace registry BEFORE start so
    // any tool call during the flow finds it (and gets a "starting" /
    // "pending_auth" structured error instead of "no source").
    const registry = this.workspaceRegistries().get(wsId);
    // `teardownConnectionSource` above already dropped any prior source under
    // this name, so the name is free and the eviction half of `adoptSource` is
    // not what this call is for. What it IS for is the return value: `false`
    // means a concurrent start (a `tryRecoverSource` landing in the window since
    // the teardown) registered a LIVE source first.
    //
    // That winner routes and serves normally — routing is `sources.get(name)`,
    // and `adoptSource` declines only to a live incumbent. So the cost of
    // ignoring the `false` is narrower than "the bundle is broken": this source
    // would leak its transport and provider, and the connection record would
    // bind an object nothing routes to. Stopping it is the fix.
    //
    // The throw is the blunt part and is tracked separately (#825): a user whose
    // bundle was just healed by the concurrent recovery is told to retry, and
    // the retry then hits "already connected". The right shape is the one
    // `finalizeUrlSourceStart` uses — stop the loser, don't bind it, don't fail
    // the caller — which needs `adoptSource` to own the behaviour rather than
    // three call sites hand-rolling it.
    if (registry && !(await registry.adoptSource(source))) {
      await source.stop();
      throw new Error(
        `[lifecycle] startAuth: "${serverName}" in ${wsId} was registered by a concurrent start; ` +
          "retry the connection",
      );
    }
    this.recordConnectionStateChange(serverName, wsId, principalId, "starting");

    // Arm interactive OAuth for THIS user-initiated start only. The
    // `interactiveAuthAllowed` flag gates whether a start may drive a browser
    // flow vs. fail fast to `reauth_required`; only a user-initiated reconnect
    // (a human is waiting) should arm it. Disarm once this start settles
    // (`.finally` below) so the flag never leaks into a later background start
    // on the same provider — defensive hygiene: this fresh source isn't in the
    // HealthMonitor boot snapshot, but a provider that ever is must never carry
    // a stale armed flag into a liveness reconnect.
    provider.setInteractiveAuthAllowed(true);

    // Background start. The provider's callback resolves `authUrlPromise`
    // when interactive auth is required. If start() succeeds without ever
    // hitting interactive (headless / pre-authenticated), we transition to
    // running and resolve the auth URL promise with `null` — a success the
    // route reports as "already connected" so the UI refreshes state (#679).
    this.startAuthBackground({
      source,
      provider,
      serverName,
      wsId,
      principalId,
      getCapturedAuthUrl: () => capturedAuthUrl,
      resolveAuthUrl,
      rejectAuthUrl,
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
   * Construct the workspace-scoped OAuth provider for a `startAuth` flow,
   * wiring the caller's interactive-auth callback and a reauth_required hook
   * for mid-session auth loss. Tokens route through the workspace credential
   * handle; the abort signal cancels in-flight fetches on give-up.
   */
  private buildWorkspaceOAuthProvider(args: {
    serverName: string;
    wsId: string;
    principalId: string;
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean };
    ref: BundleRef;
    ownerDisplayName: string | undefined;
    staticClient: StaticOAuthClient | undefined;
    providerAbort: AbortController;
    onInteractiveAuthRequired: (url: string) => void;
  }): WorkspaceOAuthProvider {
    const {
      serverName,
      wsId,
      principalId,
      opts,
      ref,
      ownerDisplayName,
      staticClient,
      providerAbort,
      onInteractiveAuthRequired,
    } = args;
    return new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId },
      ...(ownerDisplayName ? { ownerDisplayName } : {}),
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
      onInteractiveAuthRequired,
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
  }

  /**
   * Kick off the fire-and-forget `source.start()` for a `startAuth` flow. On
   * success transitions to `running` (and, for the headless / pre-authenticated
   * path with no captured URL, resolves the caller's auth-URL promise with `null`
   * — a success the route reports as "already connected"); on failure logs,
   * transitions to `dead` with the error, and rejects the promise on the pre-auth
   * path. Always disarms interactive auth so a later background reconnect of this
   * long-lived source can't drive a browser flow.
   */
  private startAuthBackground(args: {
    source: McpSource;
    provider: WorkspaceOAuthProvider;
    serverName: string;
    wsId: string;
    principalId: string;
    getCapturedAuthUrl: () => string | undefined;
    resolveAuthUrl: (url: string | null) => void;
    rejectAuthUrl: (err: Error) => void;
  }): void {
    const {
      source,
      provider,
      serverName,
      wsId,
      principalId,
      getCapturedAuthUrl,
      resolveAuthUrl,
      rejectAuthUrl,
    } = args;
    void source
      .start()
      .then(() => {
        this.recordConnectionStateChange(serverName, wsId, principalId, "running");
        if (!getCapturedAuthUrl()) {
          // Connected without ever hitting interactive auth (provider-minted, or
          // valid tokens already on hand). That is a SUCCESS — the source is now
          // `running`. Resolve with no URL so the caller returns "already
          // connected" (the UI refreshes state) instead of a spurious failure. (#679)
          resolveAuthUrl(null);
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
        if (!getCapturedAuthUrl()) {
          rejectAuthUrl(err instanceof Error ? err : new Error(msg));
        }
      })
      .finally(() => {
        // Disarm interactive auth — subsequent (background) reconnects of this
        // long-lived source must NOT drive a browser flow.
        provider.setInteractiveAuthAllowed(false);
      });
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

    // A brokered bundle's credentials are not among our OAuth records —
    // the broker holds them — so disconnect asks the provider to tear its
    // connection down instead. Same `cleanup` arm uninstall uses: revoke the
    // upstream connection (the vendor's OAuth tokens go with it) and drop the
    // provider's local record, so a subsequent Connect can't short-circuit on a
    // stale active account.
    //
    // ONLY for a provider that can re-establish what it just destroyed. A broker
    // that offers no reconnect (`initiate` / `connectApiKey`) would turn
    // disconnect into a one-way door — `createSession` runs on fresh install
    // only, behind the dedupe check, so the connector could never be reconnected,
    // only uninstalled and reinstalled. Those fall through to the generic path
    // below, which drops the local source and records `not_authenticated`
    // without destroying anything upstream; their teardown belongs on uninstall,
    // where reinstall genuinely re-mints the connection.
    //
    // A broker doesn't necessarily differentiate access from refresh — one
    // delete may revoke both at the upstream vendor. Reporting `{ access }` only
    // (not faking `refresh`) keeps the return shape honest about what we know.
    const brokeredTarget = this.brokeredProvider(ref, "disconnect");
    const canReconnect =
      brokeredTarget?.provider.initiate !== undefined ||
      brokeredTarget?.provider.connectApiKey !== undefined;
    if (brokeredTarget?.provider.cleanup && canReconnect) {
      const { upstreamDeleted, localDeleted, lastError } = await brokeredTarget.provider.cleanup({
        owner: { type: "workspace", wsId },
        brokered: brokeredTarget.brokered,
        workDir: opts.workDir,
      });
      await this.teardownConnectionSource(serverName, wsId, principalId);
      this.recordConnectionStateChange(serverName, wsId, principalId, "not_authenticated", {
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
    // `removeSource` calls `stop()` on the way out, so the registry entry is
    // both the handle and the teardown. There is no second reference to stop.
    const registry = this.workspaceRegistries().get(wsId);
    if (registry?.hasSource(serverName)) {
      await registry.removeSource(serverName);
    }
  }

  /**
   * The live `McpSource` behind one workspace connection, or `null`.
   *
   * The registry is where a source lives — this reads it back through the same
   * `(wsId, serverName)` key the connection record carries, so a consumer never
   * holds a reference across a reconnect. `adoptSource` replaces the entry
   * wholesale when a source is re-established (boot self-heal, Reconnect,
   * `tryRecoverSource`), and a reference captured before that points at the
   * stopped predecessor.
   *
   * `null` distinguishes two cases a caller usually wants to treat alike and
   * must not confuse with a bad state: the workspace has no registry (a
   * lifecycle constructed outside `Runtime.start`), or the name resolves to
   * nothing — an install whose eager start failed, an uninstall in flight.
   * Neither is a reason to start anything here; a source's own recovery
   * machinery owns that.
   */
  connectionSource(serverName: string, wsId: string): McpSource | null {
    const source = this.workspaceRegistries().get(wsId)?.getSource(serverName);
    const unwrapped = source instanceof SharedSourceRef ? source.unwrap() : source;
    return unwrapped instanceof McpSource ? unwrapped : null;
  }

  /**
   * The runtime's `wsId` → `ToolRegistry` map, **asked for on every read**.
   * Required so `startAuth` / `disconnect` / `connectionSource` can reach a
   * workspace's sources without callers having to thread the registry through
   * every lifecycle entry point.
   *
   * A registry is added to that map whenever a workspace is provisioned
   * (`Runtime.ensureWorkspaceRegistry`), including long after boot, so what
   * the lifecycle needs is the map the runtime holds *now*. Neither a copy of
   * its contents nor a reference captured at wiring time is that: each is a
   * second thing to keep equal to the first, and a workspace the lifecycle
   * cannot see is one whose connectors are never polled and never torn down.
   *
   * Asking is the same rule `connectionSource` applies one level down —
   * resolve at the point of use and there is nothing to go stale. Unbound
   * until `bindWorkspaceRegistries`: a lifecycle constructed outside
   * `Runtime.start` reads an empty map and answers "no registry" everywhere.
   */
  private workspaceRegistries: () => ReadonlyMap<string, ToolRegistry> = () =>
    NO_WORKSPACE_REGISTRIES;

  /**
   * Map of `userId` → `ToolRegistry` holding that user's started personal
   * connectors — the owner-keyed sibling of `workspaceRegistries`. Reuses the same
   * `ToolRegistry` type and `startBundleSource` path; only the owner (identity)
   * and credential root (`users/<userId>/...`) differ. Created lazily on first
   * `getIdentityConnectorSource` for a user, per-pod in-memory (same clustering
   * posture as `workspaceRegistries`).
   */
  private readonly registriesByUser = new Map<string, ToolRegistry>();

  /**
   * In-flight identity-connector starts, keyed `${userId}|${serverName}` — the
   * single coordination gate for BOTH the dispatch lazy-start
   * (`getIdentityConnectorSource`) and the interactive Connect
   * (`startIdentityAuth`).
   *
   * Lazy-start is check-then-act (`hasSource` miss → read record → start), so two
   * concurrent first-calls for the same connector would both miss and both spawn a
   * transport — the loser's `addSource` throws (or its transport leaks). This map
   * collapses concurrent first-calls onto one start promise (the sibling of
   * `authFlowsInFlight`); the JS single-thread guarantees the check + set run with
   * no intervening await, so a second caller always observes the entry. Distinct
   * from a spawn-storm cooldown, which is a negative cache for *failed* starts and
   * does NOT dedup concurrent *first* calls.
   *
   * The interactive Connect claims this SAME gate — synchronously, before any
   * await — so a concurrent dispatch JOINS the interactive source instead of
   * building a parallel one over the same credential root (which would clobber
   * `client.json` / `verifier.json` → `invalid_code`), and a concurrent second
   * Connect finds the gate held and fails with `ConnectorBusyError` (a retriable
   * 409 at the route) rather than racing a rival `auth()` chain.
   */
  private readonly identityConnectorStarts = new Map<string, Promise<ToolSource | undefined>>();

  /**
   * Per-`${serverName}|${wsId}` timestamp (epoch ms) of the last
   * best-effort recovery attempt (`tryRecoverSource`). Negative cache: a
   * failed re-spawn stamps the key so the orchestrator hot path doesn't
   * spawn-storm a genuinely broken bundle on every tool call; a
   * successful recovery clears it.
   *
   * Per-pod by design, and correct under `replicas > 1` — do NOT move it
   * to Redis/`SessionRegistry`. It guards a per-pod in-memory registry
   * repair: a workspace registry is process-local and its sources are
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
   * Bind the lifecycle to the runtime's per-workspace registries. Called once
   * by `Runtime.start` after the workspace bundle boot loop has constructed
   * them. Allows `startAuth` (workspace-scope) to add/remove sources without
   * the route handler having to thread a registry argument.
   *
   * Takes an accessor rather than the map so that what the runtime holds and
   * what the lifecycle reads cannot be two different things — see
   * `workspaceRegistries`.
   */
  bindWorkspaceRegistries(resolve: () => ReadonlyMap<string, ToolRegistry>): void {
    this.workspaceRegistries = resolve;
  }

  /**
   * Register placements from a bundle's UI metadata in the PlacementRegistry.
   * Scoped to `wsId` so two workspaces installing the same bundle get separate
   * nav entries and uninstalling one doesn't wipe the other's.
   *
   * Placements are validated and sanitized first (`sanitizePlacements`): a
   * server's declared chrome is untrusted input even when sourced from the
   * operator catalog, so an invalid placement is dropped individually
   * (fail-closed, per-placement) rather than failing the whole install.
   */
  private registerPlacements(serverName: string, ui: BundleUiMeta | null, wsId: string): void {
    if (!this.placementRegistry || !ui) return;

    const safe = sanitizePlacements(ui.placements);
    if (safe.length > 0) {
      this.placementRegistry.register(serverName, safe, wsId);
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
    const wsRegistry = this.workspaceRegistries().get(wsId);
    if (!wsRegistry) {
      throw new Error(`[lifecycle] no registry for workspace "${wsId}"`);
    }
    if (wsRegistry.hasEstablishedSource(serverName)) return;
    // Deliberately NO pre-remove of a dead entry. `removeSource` calls `stop()`,
    // which sets the durable `stopped` marker — so a recovery attempt made while
    // the endpoint is still down would evict the retained source AND make it
    // terminal to HealthMonitor, leaving the bundle worse off than before it was
    // retained and with no path back. The success path evicts instead:
    // `finalizeUrlSourceStart` calls `adoptSource`, which replaces a dead entry
    // with the fresh one.
    const instance = this.instances.get(`${serverName}|${wsId}`);
    const ref = instance?.ref;
    if (!ref) {
      throw new Error(
        `[lifecycle] cannot re-register source "${serverName}" in ${wsId} — no URL ref persisted`,
      );
    }

    await startBundleSource(ref, wsRegistry, this.eventSink, {
      allowInsecureRemotes: this.allowInsecureRemotes,
      // A recovery that fails must not be destructive. With this set, the catch
      // sees the retained entry still holding the name and leaves it alone, so a
      // failed attempt is a no-op rather than a downgrade — the source stays
      // registered and unstopped, and HealthMonitor keeps working on it.
      keepRegisteredOnStartFailure: true,
      wsId,
      workDir,
      // Re-thread on reconnect so a Composio OAuth callback doesn't
      // silently drop the bundle's host-resources handlers. The
      // composio-auth callback path goes through here.
      bundleMcp: this.resolveBundleMcpDeps(wsId),
    });
  }

  /**
   * Resolve a user's personal connector to a started `ToolSource`, lazy-starting
   * it on first use. The identity-plane analog of the workspace self-heal:
   *
   *   1. Look in the user's registry — already running ⇒ return it (idempotent).
   *   2. Otherwise read the persisted install record (`connectors.json`) via
   *      `IdentityConnectorStore`. No URL record ⇒ `undefined` (not installed).
   *   3. Start it through the shared `startBundleSource` path, bound to the
   *      `{type:"user"}` owner so OAuth credentials resolve under
   *      user credential scope, and return it.
   *
   * Per-pod and reactive, like the workspace self-heal — a fresh pod starts the
   * source on its own first call, idempotently (`hasSource` short-circuit).
   * Concurrent first-calls are de-duplicated onto one start (see
   * `identityConnectorStarts`) so a double-dispatch can't double-spawn. No
   * spawn-storm *cooldown* yet — that negative cache for repeatedly-failing
   * starts is separate, and lands with the hot dispatch consumer that wires this
   * in.
   *
   * `startBundleSource` can throw on transport / handshake failure; callers
   * decide whether to swallow or surface.
   */
  /**
   * Whether a personal connector's source is currently registered (running) in
   * this pod's user registry. A NON-starting probe — it never calls
   * `getIdentityConnectorSource` (which would lazy-start the source), only reads
   * the existing registry. Per-pod truth: a source is warm only after a Connect /
   * dispatch on this pod, so a `false` means "not warm here," not "never
   * authenticated" (cross-pod / persisted connection state is the deferred reauth
   * slice). Used by `list_personal_connectors` so a just-connected connector
   * reflects "running" instead of the resting state.
   */
  isIdentityConnectorRunning(userId: string, serverName: string): boolean {
    return this.registriesByUser.get(userId)?.hasSource(serverName) ?? false;
  }

  async getIdentityConnectorSource(
    userId: string,
    serverName: string,
    workDir: string,
  ): Promise<ToolSource | undefined> {
    const registry = this.userRegistry(userId);
    if (registry.hasSource(serverName)) return registry.getSource(serverName);

    // Collapse concurrent first-calls onto one start (check + set run with no
    // intervening await, so a second caller always observes the entry).
    const key = `${userId}|${serverName}`;
    const inFlight = this.identityConnectorStarts.get(key);
    if (inFlight) return inFlight;

    const start = this.startIdentityConnector(userId, serverName, workDir, registry);
    this.identityConnectorStarts.set(key, start);
    try {
      return await start;
    } finally {
      this.identityConnectorStarts.delete(key);
    }
  }

  /** Read the persisted record and start the connector into the user's registry. */
  private async startIdentityConnector(
    userId: string,
    serverName: string,
    workDir: string,
    registry: ToolRegistry,
  ): Promise<ToolSource | undefined> {
    const ref = await new IdentityConnectorStore({ workDir }).get(userId, serverName);
    if (!ref) return undefined;

    await startBundleSource(ref, registry, this.eventSink, {
      allowInsecureRemotes: this.allowInsecureRemotes,
      workDir,
      identityOwner: { userId },
    });
    return registry.getSource(serverName);
  }

  /**
   * Full teardown of a personal (identity-plane) connector — the identity sibling
   * of `uninstall` (workspace). Stops + drops the source from the user's registry,
   * deletes the identity credentials (the OAuth records always; the brokered credential
   * dir too when it's a brokered connector), and removes the install record from
   * `IdentityConnectorStore`. Grant revocation is the caller's job (permission
   * store), exactly as `handleUninstall` drops tool permissions after
   * `lifecycle.uninstall`. Each teardown step is best-effort so a partial failure
   * still reaches the install-record removal — the user-visible "it's gone".
   *
   * Upstream token revocation is NOT performed here — for a DCR connector the
   * vendor's OAuth grant (RFC 7009) and for a brokered connector the broker-side
   * connection both stay live at the vendor until they expire; we only delete the
   * LOCAL credentials, so the platform forgets them. The workspace `uninstall`
   * DOES revoke upstream (`revokeUrlBundleTokens` for DCR, the provider's
   * `cleanup` arm for a brokered one) — a known asymmetry with this method, and
   * one the seam no longer blocks: `cleanup` takes an owner, so closing it is a
   * call, deliberately left to the connection-state / reauth slice rather than
   * changing teardown semantics here. A user who wants the vendor-side grant gone
   * meanwhile can revoke it in the vendor's own authorized-apps list.
   */
  async uninstallIdentityConnector(
    userId: string,
    serverName: string,
    opts: { workDir: string },
  ): Promise<void> {
    const { workDir } = opts;
    const store = new IdentityConnectorStore({ workDir });
    // Read the ref BEFORE removing it — its brokered marker decides whether
    // there is also a provider credential dir to clear.
    const ref = await store.get(userId, serverName);

    // 1. Stop + drop the running source from the user's registry (if warm).
    const registry = this.registriesByUser.get(userId);
    if (registry?.hasSource(serverName)) {
      try {
        await registry.getSource(serverName)?.stop();
      } catch (err) {
        log.warn(
          `[lifecycle] identity source.stop() failed for ${userId}|${serverName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await registry.removeSource(serverName);
    }

    // 2. Delete identity credentials. The OAuth records for every personal
    //    connector; the provider's credential dir additionally when the ref
    //    carries a brokered marker.
    await clearIdentityConnectorCredentials(
      workDir,
      userId,
      serverName,
      brokeredRef(ref ?? undefined),
    );

    // 3. Remove the install record — the user-visible "disconnected" state.
    await store.remove(userId, serverName);
  }

  /** The user's personal-connector registry, created on first access. */
  private userRegistry(userId: string): ToolRegistry {
    let registry = this.registriesByUser.get(userId);
    if (!registry) {
      registry = new ToolRegistry();
      this.registriesByUser.set(userId, registry);
    }
    return registry;
  }

  /**
   * Begin an INTERACTIVE OAuth flow to connect a personal connector on the
   * caller's identity — the "Connect" click from the profile. Mirrors the
   * workspace `startAuth`, bound to the `{type:"user"}` owner and the
   * `IdentityConnectorStore`. Returns the authorization URL the caller's browser
   * should be sent to.
   *
   * Single-gate concurrency: the interactive start and the dispatch lazy-start
   * (`getIdentityConnectorSource`) coordinate on ONE synchronously-claimed
   * `identityConnectorStarts` gate per `${userId}|${serverName}`, so neither
   * builds a second `{type:"user"}` provider over the same credential root — two
   * concurrent `source.start()`s would each run the SDK's DCR + verifier writes,
   * clobbering `client.json` / `verifier.json` → `invalid_code`. A concurrent
   * dispatch JOINS this source (coalescing onto `sourceReady`); a concurrent
   * second Connect finds the gate held and throws `ConnectorBusyError` (a
   * retriable 409 at the route) rather than racing a rival `auth()` chain.
   *
   * Minimal connection state by design: the returned URL drives the browser and
   * the source runs once the user returns; the rich per-user connection-state
   * model + reauth surfacing are deferred.
   */
  async startIdentityAuth(
    serverName: string,
    userId: string,
    opts: { workDir: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string | null }> {
    // Reserved-name guard, matching `startBundleSource` (which the lazy-start
    // path routes through). This interactive path builds the source directly,
    // so it enforces the same invariant: a source named `nb` would shadow the
    // system-tool namespace. Install already rejects such names, so reaching
    // here means a hand-edited record — fail closed before any wiring.
    validateServerName(serverName);

    const registry = this.userRegistry(userId);
    const connectorKey = `${userId}|${serverName}`;

    // Synchronous check-and-claim of the shared start gate: the check below and
    // the `set` a few lines down run with no intervening await, so a concurrent
    // dispatch or Connect can't interleave between them. If the source already
    // exists, or a start is already in flight either way, we can't run a clean
    // interactive flow — surface a retriable busy error instead of racing a
    // second `auth()` chain that would clobber the shared credential root.
    if (registry.hasSource(serverName) || this.identityConnectorStarts.has(connectorKey)) {
      throw new ConnectorBusyError(serverName, userId);
    }

    // Claim the gate so a concurrent dispatch JOINS this source (coalescing onto
    // `sourceReady`) instead of starting a parallel one. Resolved with the
    // source the instant it's registered — before the OAuth round-trip — or
    // `undefined` on a pre-registration failure.
    let settleSource!: (s: ToolSource | undefined) => void;
    const sourceReady = new Promise<ToolSource | undefined>((res) => {
      settleSource = res;
    });
    this.identityConnectorStarts.set(connectorKey, sourceReady);
    const clearConnectorGate = (): void => {
      if (this.identityConnectorStarts.get(connectorKey) === sourceReady) {
        this.identityConnectorStarts.delete(connectorKey);
      }
    };

    let backgroundStarted = false;
    try {
      const ref = await new IdentityConnectorStore({ workDir: opts.workDir }).get(
        userId,
        serverName,
      );
      if (!ref || !("url" in ref)) {
        throw new Error(`[lifecycle] "${serverName}" is not a personal connector for ${userId}`);
      }

      let capturedAuthUrl: string | undefined;
      // `null` = connected without an interactive flow (already authenticated) —
      // a success the route surfaces as "already connected" (#679).
      let resolveAuthUrl!: (url: string | null) => void;
      let rejectAuthUrl!: (err: Error) => void;
      const authUrlPromise = new Promise<string | null>((res, rej) => {
        resolveAuthUrl = res;
        rejectAuthUrl = rej;
      });
      authUrlPromise.catch(() => {});

      // Cancel the provider's outbound fetches when we give up (timeout) so an
      // unresponsive auth server's redirect-probe / discovery TCP read doesn't
      // linger for its full network deadline — and so the background start fails
      // fast, freeing the gate. Mirrors `startAuthInner`'s abort.
      const providerAbort = new AbortController();

      const provider = await buildUrlOAuthProvider(
        ref,
        serverName,
        undefined, // no workspace context — identity-owned
        {
          identityOwner: { userId },
          workDir: opts.workDir,
          allowInsecureRemotes: opts.allowInsecureRemotes === true,
          abortSignal: providerAbort.signal,
        },
        (url) => {
          capturedAuthUrl = url;
          resolveAuthUrl(url);
        },
      );
      if (!provider) {
        throw new Error(`[lifecycle] "${serverName}" uses static auth — no interactive OAuth flow`);
      }

      const source = new McpSource(
        serverName,
        {
          type: "remote",
          url: new URL(ref.url),
          transportConfig: ref.transport,
          allowInsecure: opts.allowInsecureRemotes === true,
          authProvider: provider,
        },
        this.eventSink,
        composeBundleMcpContext(undefined, serverName),
        // Identity-owned, so it emits its MARKED name. `startBundleSource` does
        // this from `opts.identityOwner`; this flow hand-rolls its source, so it
        // has to say so itself. Without it the source registered here — the one
        // `getIdentityConnectorSource` returns for the rest of the pod's life,
        // since it never restarts an already-registered source — emits a bare
        // name, and a `data.changed` broadcast lands on a WORKSPACE app of that
        // name. Only visible until the pod restarts, which is why it survives
        // manual testing.
        personalConnectorWireName(serverName),
      );
      // We hold the start gate and `hasSource` was false at claim time, so this
      // source is OURS to own — add it, start it, and tear it down on failure.
      registry.addSource(source);
      settleSource(source); // a coalescing dispatch now joins THIS (pending) source

      // Arm interactive OAuth for THIS user-initiated start only.
      provider.setInteractiveAuthAllowed(true);

      // Background start: the provider's callback resolves `authUrlPromise` when
      // interactive auth is required; the token exchange + reconnect complete
      // when the user returns from the authorization server. The gate is freed
      // when this settles — the end of the OAuth window (bounded by the flow
      // registry's 15-min TTL if the user never returns) — NOT when the race
      // below returns.
      backgroundStarted = true;
      void source
        .start()
        .then(() => {
          if (!capturedAuthUrl) {
            // Connected without an interactive flow (already authenticated) — a
            // success. Resolve with no URL so the route reports "already connected"
            // instead of a spurious failure (#679).
            resolveAuthUrl(null);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message || err.name : String(err);
          log.warn(
            `[lifecycle] startIdentityAuth: ${serverName} start failed for ${userId}: ${msg}`,
          );
          void registry.removeSource(serverName).catch(() => {}); // ours to remove
          rejectAuthUrl(err instanceof Error ? err : new Error(msg));
        })
        .finally(() => {
          clearConnectorGate();
        });

      // Race the auth URL signal against a hard timeout (mirrors `startAuth`).
      const TIMEOUT_MS = 15_000;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timeoutHandle = setTimeout(
          () => rej(new Error(`[lifecycle] startIdentityAuth timed out after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      });
      try {
        return { authorizationUrl: await Promise.race([authUrlPromise, timeout]) };
      } catch (raceErr) {
        // Give up (timeout): abort the provider's in-flight fetches so the
        // background `source.start()` fails fast — which frees the gate via its
        // `.finally` and unblocks a retry — instead of lingering for the network
        // deadline / flow TTL. Mirrors `startAuthInner`.
        providerAbort.abort();
        throw raceErr;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    } catch (err) {
      // A pre-start failure (no record, static auth) never reached
      // `source.start()`, so no background handler will free the gate — free it
      // here and unblock any coalescing dispatch with `undefined`. A post-start
      // failure (timeout) aborts above → the background's `.finally` frees the
      // gate, so we don't double-clear here.
      if (!backgroundStarted) {
        settleSource(undefined);
        clearConnectorGate();
      }
      throw err;
    }
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
    const wsRegistry = this.workspaceRegistries().get(wsId);
    if (!wsRegistry) return false;
    // Liveness, not membership. A boot-failed source stays REGISTERED so it
    // remains visible and HealthMonitor can heal it — so `hasSource` would say
    // "already fine" for exactly the sources that need this path most, and the
    // app-open recovery that used to re-spawn them would never fire.
    if (wsRegistry.hasEstablishedSource(serverName)) return true;

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

    const recovered = wsRegistry.hasEstablishedSource(serverName);
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
        ui: instance.ui,
        placements: instance.ui?.placements ?? null,
      },
    });
  }

  /**
   * Seed instances from the initial bundle startup, and from the install path.
   *
   * A seeded bundle is not necessarily a running one: a URL bundle that was
   * skipped for having no tokens, or that was attempted and failed
   * (`startError`), is seeded too — the state is derived below, not assumed.
   *
   * Stage 2: every URL bundle binds to its workspace explicitly. The
   * disk-read boundary (`buildProcessInventory`) calls
   * `assertBundleRefIsPostStage2` and hard-errors on legacy
   * `oauthScope: "user"` records — see the deploy runbook at
   * the Stage 2 deploy runbook.
   */
  async seedInstance(
    serverName: string,
    bundleName: string,
    ref: BundleRef,
    manifestMeta: SeedManifestMeta | undefined,
    wsId: string,
    /** Boot-start failure message for an installed-but-not-running bundle.
     *  Set only by the boot seeder; makes the seeded Connection `dead` instead
     *  of the auth-derived state. */
    startError?: string,
  ): Promise<void> {
    // Track A: validate authorize-URL params at the seed boundary.
    // Catches reserved-key collisions (client_id, state, PKCE, scope, etc.)
    // before they break OAuth flows at runtime.
    if (ref.additionalAuthorizationParams) {
      validateAdditionalAuthorizationParams(ref.additionalAuthorizationParams);
    }

    this.instances.set(
      `${serverName}|${wsId}`,
      buildSeededInstance(serverName, bundleName, ref, manifestMeta, wsId),
    );
    await this.seedUrlConnectionState(serverName, wsId, ref, startError);
  }

  /**
   * Derive and record the boot-time Connection state for a seeded URL bundle.
   * Outcomes, in priority order:
   *   1. The OAuth provider's interactive callback fired during boot (RT was
   *      persisted but rejected — the SDK fell back to the interactive branch
   *      and the URL was buffered). Record `reauth_required` with the captured
   *      URL so the UI shows a "Reconnect" affordance instead of "Connect".
   *   2. Boot-start was attempted and threw (`startError`) → record `dead` with
   *      the message. Reconnecting is not the recovery path here (the
   *      credential is fine; the endpoint was unreachable), so this must not
   *      fall through to the auth-derived states below.
   *   3. No persisted auth on disk → record `not_authenticated`. The bundle is
   *      silently installed; the user discovers it on the Connections page and
   *      clicks Connect to initiate OAuth.
   *   4. Auth present and source.start() succeeded → record `running`.
   */
  private async seedUrlConnectionState(
    serverName: string,
    wsId: string,
    ref: BundleRef,
    startError?: string,
  ): Promise<void> {
    const pendingAuthUrl = consumePendingAuth(wsId, serverName);
    if (pendingAuthUrl) {
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "reauth_required", {
        authorizationUrl: pendingAuthUrl,
      });
      return;
    }

    // Boot-start failed. The bundle stays installed and its placements stay
    // registered, but the connection is `dead` — the state whose recovery path
    // is "try again", which is what `tryRecoverSource` does on next use.
    if (startError) {
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "dead", {
        lastError: startError,
      });
      return;
    }

    // The runtime's resolved workDir, not `defaultWorkDir()` — this probe reads
    // credential state that install and the OAuth callback wrote under
    // `runtime.getWorkDir()`, and the two diverge exactly when an operator sets
    // `workDir` in `nimblebrain.json` without `NB_WORK_DIR`. Probing the wrong
    // root finds no tokens and seeds `not_authenticated` for every remote
    // connector at boot, however many are actually connected. See
    // `resolvedWorkDir`.
    const workDir = this.resolvedWorkDir ?? defaultWorkDir();
    // A brokered connector's readiness is its provider's to answer, and it is
    // asked FIRST: a brokered bundle carries static transport auth but may still
    // need a per-owner connect, so the generic static-auth check below would
    // seed `running` for an unconnected one and lose its Connect button. A
    // provider with no `hasConnection` has nothing to connect per-owner and
    // falls through. Other static-auth sources (provider / bearer / header)
    // carry their own credential and auto-connect — no interactive Connect step
    // — so they must not seed `not_authenticated` (which the UI renders as a
    // "Connect" button that would spin a bogus OAuth flow). Reaching here means
    // boot-start either succeeded or was never attempted — a failure returned
    // above on `startError` — so `running` is accurate.
    const hasAuth =
      brokeredConnectionPresent(this.managedConnectors, ref, wsId, workDir) ??
      (bundleHasStaticAuth(ref) ||
        (await hasMcpOAuthTokens(workDir, { type: "workspace", wsId }, serverName)));
    if (!hasAuth) {
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "not_authenticated");
    } else {
      this.recordConnectionStateChange(serverName, wsId, "_workspace", "running");
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Remove a personal connector's local credentials: the OAuth records every
 * personal connector has, plus the provider's credential dir when the ref is
 * brokered. Best-effort and independently guarded — a failure on one must not
 * skip the other, and `force` makes a never-connected connector a no-op.
 */
async function clearIdentityConnectorCredentials(
  workDir: string,
  userId: string,
  serverName: string,
  brokered: BrokeredRef | undefined,
): Promise<void> {
  const owner: ConnectorOwner = { type: "user", userId };
  try {
    await new McpOAuthRecords({ owner, serverName, workDir }).deleteAll();
  } catch (err) {
    log.warn(
      `[lifecycle] failed to clear identity OAuth records for ${userId}|${serverName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!brokered) return;
  try {
    rmSync(brokeredConnectorDir(workDir, owner, brokered.provider, brokered.connectorId), {
      recursive: true,
      force: true,
    });
  } catch (err) {
    log.warn(
      `[lifecycle] failed to clear the identity ${brokered.provider} dir for ` +
        `${userId}|${serverName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build the `BundleInstance` `seedInstance` records.
 *
 * **`state` is hardcoded `"running"` here and corrected afterwards** —
 * `seedUrlConnectionState` is what resolves `dead` / `not_authenticated` /
 * `reauth_required` / `running` and recomputes `instance.state` from the
 * Connection.
 */
function buildSeededInstance(
  serverName: string,
  bundleName: string,
  ref: BundleRef,
  manifestMeta: SeedManifestMeta | undefined,
  wsId: string,
): BundleInstance {
  return {
    serverName,
    bundleName: manifestMeta?.manifestName ?? bundleName,
    // Config key for reliable uninstall — the original value from nimblebrain.json
    configKey: bundleName,
    version: manifestMeta?.version ?? "unknown",
    description: manifestMeta?.description,
    state: "running",
    ui: ref.ui ?? manifestMeta?.ui ?? null,
    briefing: manifestMeta?.briefing ?? null,
    wsId,
    oauthScope: "workspace",
    // Needed to reconstruct McpSources on-demand (URL, transport config,
    // oauthClient + scopes). Stored as an opaque copy.
    ref: { ...ref },
  };
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

/** Atomically remove a bundle entry from the config. */
function atomicConfigRemove(configPath: string, key: string): void {
  const config = readConfig(configPath);
  const bundles = (config.bundles ?? []) as Array<Record<string, unknown>>;
  config.bundles = bundles.filter((b) => b.url !== key);
  atomicWrite(configPath, config);
}
