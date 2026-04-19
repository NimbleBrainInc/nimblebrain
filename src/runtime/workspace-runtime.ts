/**
 * Workspace-aware bundle lifecycle helpers.
 *
 * These functions build a process inventory from workspace definitions and
 * manage hot install/uninstall of bundles within individual workspaces.
 * Each workspace gets its own ToolRegistry with plain tool names (no compound keys).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { deriveServerName, resolveBundleDataDir } from "../bundles/paths.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type { BundleRef, LocalBundleMeta } from "../bundles/types.ts";
import { clearAllWorkspaceCredentials } from "../config/workspace-credentials.ts";
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
  // Required. Propagated to every McpSource so task-augmented tool calls
  // can emit `tool.progress` events that reach the SSE broadcast layer.
  // Pass `new NoopEventSink()` only if intentionally discarding events.
  eventSink: import("../engine/types.ts").EventSink,
  configDir: string | undefined,
  opts?: {
    allowInsecureRemotes?: boolean;
    workDir?: string;
  },
): Promise<{ registries: Map<string, ToolRegistry>; entries: ProcessInventoryEntry[] }> {
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

  for (const [wsId, wsEntries] of byWorkspace) {
    const wsRegistry = createWorkspaceRegistry(platformSources, systemSource);

    // Start workspace-specific bundles and add to the workspace registry
    for (const entry of wsEntries) {
      try {
        const result = await startBundleSource(entry.bundle, wsRegistry, eventSink, configDir, {
          allowInsecureRemotes: opts?.allowInsecureRemotes,
          dataDir: entry.dataDir,
          // Thread workspace id + work dir so the named-bundle path can
          // resolve `user_config` from the workspace credential store before
          // prepareServer validates it.
          wsId: entry.wsId,
          workDir,
        });
        // Use the actual source name from the registry (may differ from path-derived name)
        resultEntries.push({ ...entry, serverName: result.sourceName, meta: result.meta });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[workspace-runtime] Failed to start ${entry.serverName} in ${wsId}: ${msg}\n`,
        );
      }
    }

    registries.set(wsId, wsRegistry);
  }

  return { registries, entries: resultEntries };
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
  // Required. Threaded into the new McpSource so task-augmented tools'
  // progress events reach the SSE broadcast layer (Synapse useDataSync).
  eventSink: import("../engine/types.ts").EventSink,
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

  const result = await startBundleSource(bundleRef, registry, eventSink, configDir, {
    allowInsecureRemotes: opts?.allowInsecureRemotes,
    dataDir,
    // Thread workspace id + work dir so the named-bundle path can resolve
    // `user_config` from the workspace credential store before prepareServer
    // validates it.
    wsId,
    workDir,
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
 * Also clears the workspace-scoped credential file for the bundle (best-effort —
 * failures are logged but do not fail the uninstall). Data directories are
 * intentionally preserved.
 */
export async function uninstallBundleFromWorkspace(
  wsId: string,
  bundleName: string,
  registry: ToolRegistry,
  opts?: { workDir?: string },
): Promise<void> {
  const serverName = deriveServerName(bundleName);

  if (!registry.hasSource(serverName)) {
    throw new Error(`No bundle "${serverName}" found in workspace "${wsId}"`);
  }

  await registry.removeSource(serverName);

  // Best-effort credential cleanup — don't fail uninstall if it errors.
  // Credentials are config, not data: they should not persist across uninstalls.
  const workDir = opts?.workDir ?? process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  try {
    await clearAllWorkspaceCredentials(wsId, bundleName, workDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[workspace-runtime] Failed to clear credentials for ${bundleName} in ${wsId}: ${msg}\n`,
    );
  }
}
