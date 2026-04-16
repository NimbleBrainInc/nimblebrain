import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extractText } from "../engine/content-helpers.ts";
import type { EventSink } from "../engine/types.ts";
import type { PlacementRegistry } from "../runtime/placement-registry.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { filterEnvForBundle } from "./env-filter.ts";
import { validateManifest } from "./manifest.ts";
import { getMpak } from "./mpak.ts";
import { deriveBundleDataDir, deriveServerName, validateServerName } from "./paths.ts";
import { resolveLocalBundle } from "./resolve.ts";
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
import { validateBundleUrl } from "./url-validator.ts";

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
    env?: Record<string, string>,
  ): Promise<BundleInstance> {
    const serverName = deriveServerName(name);
    validateServerName(serverName);

    // Step 1 — Download/cache via SDK
    const mpak = getMpak(this.mpakHome);
    await mpak.bundleCache.loadBundle(name);

    // Step 2 — Read manifest from SDK cache
    const manifest = mpak.bundleCache.getBundleManifest(name) as BundleManifest | null;
    if (!manifest) {
      throw new Error(`No manifest found for ${name} after install`);
    }

    // Step 3 — Detect Upjack
    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;

    // Step 4 — Spawn MCP server
    const instance = createInstance(serverName, name, manifest, isUpjack);
    instance.configKey = name; // config entry uses the mpak name

    this.transition(instance, "starting");

    const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
    const bundleDataDir = join(nbWorkDir, "data", deriveBundleDataDir(name));
    const server = await mpak.prepareServer({ name }, { workspaceDir: bundleDataDir });

    const source = new McpSource(serverName, {
      type: "stdio",
      spawn: {
        command: server.command,
        args: server.args,
        env: {
          ...server.env,
          ...filterEnvForBundle(process.env as Record<string, string>),
          ...(env ?? {}),
          MPAK_WORKSPACE: bundleDataDir,
          UPJACK_ROOT: bundleDataDir,
        },
        cwd: server.cwd,
      },
    });
    await source.start();
    registry.addSource(source);

    this.transition(instance, "running");

    // Step 5 — Record trust score
    instance.trustScore = await fetchTrustScore(name, this.mpakHome);

    // Step 6 — Read UI + briefing metadata
    instance.ui = extractUiMeta(manifest);
    instance.briefing = extractBriefing(manifest);

    // Step 6b — Register placements in PlacementRegistry
    this.registerPlacements(serverName, instance.ui, instance.bundleName);

    // Step 7 — Atomic config write
    if (this.configPath) {
      const entry: Record<string, unknown> = { name };
      if (instance.trustScore != null) entry.trustScore = instance.trustScore;
      if (instance.ui) entry.ui = instance.ui;
      atomicConfigAdd(this.configPath, entry);
    }

    this.instances.set(serverName, instance);

    // Step 8a — Sync bundle-contributed automations (non-blocking)
    await this.syncBundleAutomations(manifest, name, registry);

    // Step 8 — Emit event
    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        serverName,
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
    env?: Record<string, string>,
  ): Promise<BundleInstance> {
    const bundleDir = resolveLocalBundle(bundlePath);
    if (!bundleDir) {
      throw new Error(`Local bundle not found: ${bundlePath}`);
    }

    const manifestPath = join(bundleDir, "manifest.json");
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const result = validateManifest(raw);
    if (!result.valid || !result.manifest) {
      throw new Error(`Invalid manifest in ${bundlePath}:\n${result.errors.join("\n")}`);
    }
    const manifest = result.manifest;
    const serverName = deriveServerName(manifest.name);
    validateServerName(serverName);
    const isUpjack = manifest._meta?.["ai.nimblebrain/upjack"] != null;
    // Use manifest.name (scoped name) as bundleName, not the filesystem path
    const instance = createInstance(serverName, manifest.name, manifest, isUpjack);
    instance.configKey = bundlePath; // config entry uses the filesystem path

    this.transition(instance, "starting");

    const source = buildLocalMcpSource(bundleDir, manifest, env);
    await source.start();
    registry.addSource(source);

    this.transition(instance, "running");

    instance.ui = extractUiMeta(manifest);
    instance.briefing = extractBriefing(manifest);

    // Register placements in PlacementRegistry
    this.registerPlacements(serverName, instance.ui, instance.bundleName);

    if (this.configPath) {
      const entry: Record<string, unknown> = { path: bundlePath };
      if (instance.ui) entry.ui = instance.ui;
      atomicConfigAdd(this.configPath, entry);
    }

    this.instances.set(serverName, instance);

    // Sync bundle-contributed automations (non-blocking)
    await this.syncBundleAutomations(manifest, manifest.name, registry);

    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        serverName,
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
    transportConfig?: RemoteTransportConfig,
    ui?: BundleUiMeta | null,
    trustScore?: number | null,
  ): Promise<BundleInstance> {
    // SSRF protection: validate URL before connecting
    validateBundleUrl(new URL(url), { allowInsecure: this.allowInsecureRemotes });

    const instance: BundleInstance = {
      serverName,
      bundleName: url,
      version: "remote",
      state: "starting",
      trustScore: trustScore ?? null,
      ui: ui ?? null,
      briefing: null,
      protected: false,
      type: "plain",
    };

    this.transition(instance, "starting");

    const source = new McpSource(serverName, {
      type: "remote",
      url: new URL(url),
      transportConfig,
    });
    await source.start();
    registry.addSource(source);

    // Discover tools to populate tool count in version string
    const tools = await source.tools();
    instance.version = `remote (${tools.length} tools)`;

    this.transition(instance, "running");

    // Register placements in PlacementRegistry
    this.registerPlacements(serverName, instance.ui, instance.bundleName);

    // Atomic config write
    if (this.configPath) {
      const entry: Record<string, unknown> = { url, serverName };
      if (transportConfig) entry.transport = transportConfig;
      if (ui) entry.ui = ui;
      if (trustScore != null) entry.trustScore = trustScore;
      atomicConfigAdd(this.configPath, entry);
    }

    this.instances.set(serverName, instance);

    // Emit event
    this.eventSink.emit({
      type: "bundle.installed",
      data: {
        serverName,
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
  async uninstall(nameOrPath: string, registry: ToolRegistry): Promise<void> {
    // Resolve the server name: try direct derivation first, then look up by bundleName
    let serverName = deriveServerName(nameOrPath);
    let instance = this.instances.get(serverName);
    if (!instance) {
      // Try finding by bundleName (handles local paths)
      for (const [key, inst] of this.instances) {
        if (inst.bundleName === nameOrPath) {
          serverName = key;
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

    // Step 3b — Unregister placements
    if (this.placementRegistry) {
      this.placementRegistry.unregister(serverName);
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
      this.instances.delete(serverName);
    }

    // Step 5 — Emit event (data NOT deleted — step 6)
    this.eventSink.emit({
      type: "bundle.uninstalled",
      data: { serverName, bundleName: nameOrPath },
    });
  }

  // ---- Start / Stop / Restart -------------------------------------------

  /**
   * Start a stopped bundle (re-creates the MCP subprocess).
   * Dead bundles must be explicitly restarted with this method.
   */
  async startBundle(serverName: string, registry: ToolRegistry): Promise<void> {
    const instance = this.instances.get(serverName);
    if (!instance) {
      throw new Error(`No bundle instance found for "${serverName}"`);
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
  async stopBundle(serverName: string, registry: ToolRegistry): Promise<void> {
    const instance = this.instances.get(serverName);
    if (!instance) {
      throw new Error(`No bundle instance found for "${serverName}"`);
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
  recordCrash(serverName: string): void {
    const instance = this.instances.get(serverName);
    if (!instance) return;
    this.transition(instance, "crashed");
    this.eventSink.emit({
      type: "bundle.crashed",
      data: { serverName, bundleName: instance.bundleName },
    });
  }

  /**
   * Record a successful recovery by HealthMonitor.
   * Emits bundle.recovered event and updates state.
   */
  recordRecovery(serverName: string): void {
    const instance = this.instances.get(serverName);
    if (!instance) return;
    this.transition(instance, "running");
    this.eventSink.emit({
      type: "bundle.recovered",
      data: { serverName, bundleName: instance.bundleName },
    });
  }

  /**
   * Record that a bundle has exhausted restart attempts.
   * Emits bundle.dead event and updates state.
   */
  recordDead(serverName: string): void {
    const instance = this.instances.get(serverName);
    if (!instance) return;
    this.transition(instance, "dead");
    this.eventSink.emit({
      type: "bundle.dead",
      data: { serverName, bundleName: instance.bundleName },
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
   */
  private registerPlacements(
    serverName: string,
    ui: BundleUiMeta | null,
    _bundleName?: string,
  ): void {
    if (!this.placementRegistry || !ui) return;

    if (ui.placements && ui.placements.length > 0) {
      this.placementRegistry.register(serverName, ui.placements);
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
    manifestMeta?: {
      manifestName?: string;
      version: string;
      description?: string;
      ui: BundleUiMeta | null;
      briefing?: BriefingBlock | null;
      type: "upjack" | "plain";
      upjackNamespace?: string;
    },
    wsId?: string, // TODO: make required once all install paths are workspace-scoped
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
      ...(wsId !== undefined ? { wsId } : {}),
      ...(entityDataRoot !== undefined ? { entityDataRoot } : {}),
    };
    if (!wsId) {
      throw new Error(
        `seedInstance requires wsId for "${serverName}". Every bundle must be workspace-scoped.`,
      );
    }
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

/** Build an McpSource from a local bundle path + manifest (direct spawn, no SDK).
 *  Local bundles are unpacked directories — the SDK's prepareServer({ local }) expects
 *  .mcpb archives, so we handle local paths directly. */
function buildLocalMcpSource(
  bundleDir: string,
  manifest: BundleManifest,
  extraEnv?: Record<string, string>,
  allowedEnv?: string[],
): McpSource {
  const serverName = deriveServerName(manifest.name);
  const mcpConfig = manifest.server.mcp_config;

  let command = mcpConfig.command;
  const args = (mcpConfig.args ?? []).map((arg) =>
    arg.replace(/\$\{__dirname\}/g, resolve(bundleDir)),
  );

  const spawnEnv: Record<string, string> = {
    ...filterEnvForBundle(process.env as Record<string, string>, mcpConfig.env, allowedEnv),
    ...(extraEnv ?? {}),
  };

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

  return new McpSource(serverName, {
    type: "stdio",
    spawn: {
      command,
      args,
      env: spawnEnv,
      cwd: resolve(bundleDir),
    },
  });
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
