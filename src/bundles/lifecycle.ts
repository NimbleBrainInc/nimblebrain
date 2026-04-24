import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearAllWorkspaceCredentials } from "../config/workspace-credentials.ts";
import { extractText } from "../engine/content-helpers.ts";
import type { EventSink } from "../engine/types.ts";
import type { PlacementRegistry } from "../runtime/placement-registry.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { getMpak } from "./mpak.ts";
import { deriveBundleDataDir, deriveServerName } from "./paths.ts";
import { startBundleSource } from "./startup.ts";
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
// BundleLifecycleManager — owns the state of all installed bundles and
// provides the formal install / uninstall / start / stop / restart flows
// described in PRODUCT_SPEC ss3.2-3.4.
// ---------------------------------------------------------------------------

export class BundleLifecycleManager {
  private instances = new Map<string, BundleInstance>();
  private placementRegistry: PlacementRegistry | null = null;

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
    // Thread wsId + workDir through to startBundleSource so the URL-bundle
    // branch can key OAuth credentials by (wsId, serverName) instead of
    // falling back to `ws_default`. Without this, a URL bundle installed
    // via `installRemote` from any workspace would share OAuth tokens across
    // workspaces under the default id — silent cross-tenant credential
    // leakage.
    const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
    const { sourceName, meta } = await startBundleSource(
      { url, serverName, transport: transportConfig, ui: ui ?? null },
      registry,
      this.eventSink,
      this.configPath ? dirname(this.configPath) : undefined,
      { allowInsecureRemotes: this.allowInsecureRemotes, wsId, workDir: nbWorkDir },
    );

    const instance: BundleInstance = {
      serverName: sourceName,
      bundleName: url,
      version: meta?.version ?? "remote",
      state: "running",
      trustScore: trustScore ?? null,
      ui: ui ?? null,
      briefing: null,
      protected: false,
      type: "plain",
      wsId,
    };
    this.transition(instance, "running");

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

    this.instances.set(`${sourceName}|${wsId}`, instance);

    // Emit event
    this.eventSink.emit({
      type: "bundle.installed",
      data: {
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
      data: { serverName, bundleName: instance.bundleName, wsId },
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
      data: { serverName, bundleName: instance.bundleName, wsId },
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
      data: { serverName, bundleName: instance.bundleName, wsId },
    });
  }

  // ---- Bundle-contributed automations -------------------------------------

  /**
   * Extract schedules from an Upjack manifest and create automations via the
   * tool registry.  Idempotent — create returns existing if the id matches.
   * Errors are logged but never fail the install (graceful degradation).
   */
  private async syncBundleAutomations(
    manifest: BundleManifest,
    bundleName: string,
    registry: ToolRegistry,
  ): Promise<void> {
    const upjackMeta = manifest._meta?.["ai.nimblebrain/upjack"] as
      | Record<string, unknown>
      | undefined;
    if (!upjackMeta) return;

    const schedules = upjackMeta.schedules as UpjackScheduleDeclaration[] | undefined;
    if (!schedules || !Array.isArray(schedules) || schedules.length === 0) return;

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

        await registry.execute({
          id: `lifecycle-auto-create-${automationId}`,
          name: "automations__create",
          input: {
            name: automationId,
            prompt: sched.prompt,
            schedule: sched.schedule,
            description: sched.description,
            skill: sched.skill,
            allowedTools: sched.allowedTools,
            maxIterations: sched.maxIterations,
            maxInputTokens: sched.maxInputTokens,
            model: sched.model,
            enabled: sched.enabled ?? true,
            source: "bundle",
            bundleName,
          },
        });
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
   * Lists automations with source="bundle", filters by bundleName, and deletes each.
   * Errors are logged but never fail the uninstall.
   */
  private async removeBundleAutomations(bundleName: string, registry: ToolRegistry): Promise<void> {
    try {
      // List automations with source="bundle"
      const listResult = await registry.execute({
        id: "lifecycle-auto-list",
        name: "automations__list",
        input: { source: "bundle" },
      });

      if (listResult.isError) return;

      // Parse the result to find automations matching this bundle
      const parsed = JSON.parse(extractText(listResult.content)) as {
        automations?: Array<{ name: string; id?: string; source?: string; bundleName?: string }>;
      };

      const toDelete = (parsed.automations ?? []).filter((a) => a.bundleName === bundleName);

      for (const auto of toDelete) {
        try {
          await registry.execute({
            id: `lifecycle-auto-delete-${auto.name}`,
            name: "automations__delete",
            input: { name: auto.name },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[lifecycle] Failed to delete automation "${auto.name}" during uninstall of ${bundleName}: ${msg}\n`,
          );
        }
      }
    } catch (err) {
      // automations source may not be registered — that's fine
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
  ): void {
    // Resolve entity data root from dataDir + upjack namespace at seed time.
    // This is the single source of truth — downstream consumers read it directly.
    const entityDataRoot =
      dataDir && manifestMeta?.upjackNamespace
        ? join(dataDir, manifestMeta.upjackNamespace, "data")
        : undefined;

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
      ...(entityDataRoot !== undefined ? { entityDataRoot } : {}),
    };
    const key = `${serverName}|${wsId}`;
    this.instances.set(key, instance);
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
