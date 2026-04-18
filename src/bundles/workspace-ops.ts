/**
 * Workspace-scoped bundle install/uninstall operations.
 *
 * These are consumed by system tools for hot bundle management within workspaces.
 */

import { join } from "node:path";
import type { ToolRegistry } from "../tools/registry.ts";
import { deriveServerName, resolveBundleDataDir } from "./paths.ts";
import { startBundleSource } from "./startup.ts";
import type { BundleRef } from "./types.ts";

/** A single entry in the process inventory — one per (workspace, bundle) pair. */
export interface ProcessInventoryEntry {
  wsId: string;
  bundle: BundleRef;
  dataDir: string;
  serverName: string;
  meta?: import("./types.ts").LocalBundleMeta | null;
}

/**
 * Derive a server name from a BundleRef (handles name, path, and url variants).
 */
function serverNameFromRef(ref: BundleRef): string {
  if ("name" in ref) return deriveServerName(ref.name);
  if ("path" in ref) return deriveServerName(ref.path);
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
 * Install a bundle in a specific workspace (hot — no restart required).
 *
 * Spawns the bundle process with a workspace-scoped data directory
 * and registers it in the workspace's ToolRegistry with its plain server name.
 */
export async function installBundleInWorkspace(
  wsId: string,
  bundleRef: BundleRef,
  registry: ToolRegistry,
  // Required — threaded into the new McpSource so task-augmented tools'
  // progress events reach SSE. See mcp-source.ts for the full rationale.
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
