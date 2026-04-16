/**
 * Workspace-aware bundle lifecycle helpers.
 *
 * These functions build a process inventory from workspace definitions and
 * manage hot install/uninstall of bundles within individual workspaces.
 * Each workspace gets its own ToolRegistry with plain tool names (no compound keys).
 */

import { join } from "node:path";
import { deriveServerName, resolveBundleDataDir } from "../bundles/paths.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type { BundleRef, LocalBundleMeta } from "../bundles/types.ts";
import type { EventSink } from "../engine/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import type { Workspace } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the process inventory — one per (workspace, bundle) pair. */
export interface ProcessInventoryEntry {
  /** Workspace id (e.g., "ws_engineering"). */
  wsId: string;
  /** The bundle reference from the workspace definition. */
  bundle: BundleRef;
  /** Absolute path to the workspace-scoped data directory for this bundle. */
  dataDir: string;
  /** Plain server name (e.g., "crm"). */
  serverName: string;
  /** Manifest metadata captured during startup (if available). */
  meta?: LocalBundleMeta | null;
}

/** A bundle whose startup threw — the process is not running, but we record it
 *  for operator visibility (workspace log, SSE, /v1/health). */
export interface BundleStartFailure {
  wsId: string;
  serverName: string;
  bundleName: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Process inventory
// ---------------------------------------------------------------------------

/**
 * Derive a server name from a BundleRef (handles name, path, and url variants).
 */
function serverNameFromRef(ref: BundleRef): string {
  if ("name" in ref) return deriveServerName(ref.name);
  if ("path" in ref) return deriveServerName(ref.path);
  // url variant — use serverName override or derive from URL
  return (ref as { url: string; serverName?: string }).serverName ?? deriveServerName(ref.url);
}

/**
 * Derive the bundle name string from a BundleRef (for data-dir resolution).
 */
function bundleNameFromRef(ref: BundleRef): string {
  if ("name" in ref) return ref.name;
  if ("path" in ref) return ref.path;
  return (ref as { url: string }).url;
}

/**
 * Build a flat process inventory from a list of workspaces.
 *
 * For each workspace, iterates its declared bundles and produces one
 * ProcessInventoryEntry per (workspace, bundle) pair. The `dataDir`
 * is workspace-scoped via `resolveBundleDataDir`.
 */
export function buildProcessInventory(
  workspaces: Workspace[],
  workDir: string,
): ProcessInventoryEntry[] {
  const entries: ProcessInventoryEntry[] = [];

  for (const ws of workspaces) {
    const wsPath = join(workDir, "workspaces", ws.id);

    for (const bundle of ws.bundles) {
      const serverName = serverNameFromRef(bundle);
      const bundleName = bundleNameFromRef(bundle);
      const dataDir = resolveBundleDataDir(wsPath, bundleName);

      entries.push({
        wsId: ws.id,
        bundle,
        dataDir,
        serverName,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Workspace registry creation (shared by boot-time and JIT paths)
// ---------------------------------------------------------------------------

/**
 * Create a ToolRegistry for a workspace with platform sources and the system source.
 *
 * Both boot-time startup and JIT workspace provisioning use this function to
 * ensure consistent registry contents. All sources are InlineSources with no-op
 * stop(), so they are added directly (no SharedSourceRef wrapper needed).
 */
export function createWorkspaceRegistry(
  platformSources: ToolSource[],
  systemSource: ToolSource | null,
): ToolRegistry {
  const wsRegistry = new ToolRegistry();

  for (const src of platformSources) {
    wsRegistry.addSource(src);
  }

  if (systemSource) {
    wsRegistry.addSource(systemSource);
  }

  return wsRegistry;
}

// ---------------------------------------------------------------------------
// Workspace-scoped bundle startup
// ---------------------------------------------------------------------------

/**
 * Start all bundles across all workspaces, returning a per-workspace ToolRegistry.
 *
 * Reads workspaces from the store, builds the process inventory,
 * and spawns one bundle process per entry. Each workspace gets its own
 * ToolRegistry containing:
 * - Platform InlineSources directly (conversations, files, home, etc.)
 * - System source directly (InlineSource with no-op stop)
 * - Workspace-specific bundle sources (real stop)
 *
 * Returns a Map<wsId, ToolRegistry> plus the inventory entries for lifecycle seeding.
 */
export async function startWorkspaceBundles(
  workspaceStore: WorkspaceStore,
  platformSources: ToolSource[],
  systemSource: ToolSource | null,
  configDir: string | undefined,
  opts?: {
    allowInsecureRemotes?: boolean;
    workDir?: string;
    /**
     * Optional event sink. When provided, bundle start failures emit a
     * `bundle.start_failed` event (workspace log + SSE). Callers that invoke
     * this before the runtime's sink is wired (e.g. some tests) may omit it.
     */
    eventSink?: EventSink;
  },
): Promise<{
  registries: Map<string, ToolRegistry>;
  entries: ProcessInventoryEntry[];
  startFailures: BundleStartFailure[];
}> {
  const workDir = opts?.workDir ?? join(process.env.NB_WORK_DIR ?? "", ".nimblebrain");
  const workspaces = await workspaceStore.list();
  const inventory = buildProcessInventory(workspaces, workDir);

  // Group inventory by workspace
  const byWorkspace = new Map<string, ProcessInventoryEntry[]>();
  for (const entry of inventory) {
    const list = byWorkspace.get(entry.wsId) ?? [];
    list.push(entry);
    byWorkspace.set(entry.wsId, list);
  }

  // Also create registries for workspaces with no bundles
  for (const ws of workspaces) {
    if (!byWorkspace.has(ws.id)) {
      byWorkspace.set(ws.id, []);
    }
  }

  const registries = new Map<string, ToolRegistry>();
  const resultEntries: ProcessInventoryEntry[] = [];
  const startFailures: BundleStartFailure[] = [];

  for (const [wsId, wsEntries] of byWorkspace) {
    const wsRegistry = createWorkspaceRegistry(platformSources, systemSource);

    // Start workspace-specific bundles and add to the workspace registry
    for (const entry of wsEntries) {
      try {
        const result = await startBundleSource(entry.bundle, wsRegistry, configDir, {
          allowInsecureRemotes: opts?.allowInsecureRemotes,
          dataDir: entry.dataDir,
        });
        // Use the actual source name from the registry (may differ from path-derived name)
        resultEntries.push({ ...entry, serverName: result.sourceName, meta: result.meta });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const bundleName = bundleNameFromRef(entry.bundle);
        // Keep stderr logging for Docker/k8s operators tailing container logs.
        process.stderr.write(
          `[workspace-runtime] Failed to start ${entry.serverName} in ${wsId}: ${msg}\n`,
        );
        const failure: BundleStartFailure = {
          wsId,
          serverName: entry.serverName,
          bundleName,
          error: msg,
        };
        startFailures.push(failure);
        // Surface to the workspace log and to SSE clients. Same failure data
        // is handed back to the caller so HealthMonitor can report it via
        // /v1/health (bundle never became an McpSource, so the monitor has
        // no other way to know it exists).
        opts?.eventSink?.emit({
          type: "bundle.start_failed",
          data: { ...failure },
        });
      }
    }

    registries.set(wsId, wsRegistry);
  }

  return { registries, entries: resultEntries, startFailures };
}

// ---------------------------------------------------------------------------
// Hot install / uninstall within a workspace
// ---------------------------------------------------------------------------

/**
 * Install a bundle in a specific workspace (hot — no restart required).
 *
 * Spawns the bundle process with a workspace-scoped data directory
 * and registers it in the workspace's ToolRegistry with its plain server name.
 */
export async function installBundleInWorkspace(
  wsId: string,
  bundleRef: BundleRef,
  registry: ToolRegistry,
  configDir: string | undefined,
  opts?: {
    allowInsecureRemotes?: boolean;
    workDir?: string;
  },
): Promise<ProcessInventoryEntry> {
  const workDir = opts?.workDir ?? process.env.NB_WORK_DIR ?? "";
  const serverName = serverNameFromRef(bundleRef);
  const bundleName = bundleNameFromRef(bundleRef);
  const wsPath = join(workDir, "workspaces", wsId);
  const dataDir = resolveBundleDataDir(wsPath, bundleName);

  // Check for existing registration
  if (registry.hasSource(serverName)) {
    throw new Error(`Bundle "${serverName}" is already running in workspace "${wsId}"`);
  }

  const result = await startBundleSource(bundleRef, registry, configDir, {
    allowInsecureRemotes: opts?.allowInsecureRemotes,
    dataDir,
  });

  return {
    wsId,
    bundle: bundleRef,
    dataDir,
    serverName: result.sourceName,
    meta: result.meta,
  };
}

/**
 * Uninstall a bundle from a specific workspace (hot — stops process and deregisters).
 *
 * Looks up the plain server name, stops the MCP source, and removes it from the registry.
 */
export async function uninstallBundleFromWorkspace(
  wsId: string,
  bundleName: string,
  registry: ToolRegistry,
): Promise<void> {
  const serverName = deriveServerName(bundleName);

  if (!registry.hasSource(serverName)) {
    throw new Error(`No bundle "${serverName}" found in workspace "${wsId}"`);
  }

  await registry.removeSource(serverName);
}
