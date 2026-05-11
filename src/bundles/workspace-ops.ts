/**
 * Workspace-scoped bundle install/uninstall operations.
 *
 * These are consumed by system tools for hot bundle management within workspaces.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { clearAllWorkspaceCredentials } from "../config/workspace-credentials.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { bundleNameFromRef, resolveBundleDataDir, serverNameFromRef } from "./paths.ts";
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
 * True if this ref is a `.mcpb` archive — the only ref variant whose canonical
 * server name and data-dir cannot be known until the manifest is peeked at
 * startup. All other variants (name/url, plain local-dir paths) derive a stable
 * name from `serverNameFromRef` directly. Callers must defer .mcpb registration
 * to `startBundleSource`, which peeks the manifest and uses `result.sourceName`.
 */
function isMcpbRef(ref: BundleRef): ref is { path: string } & BundleRef {
  return "path" in ref && ref.path.endsWith(".mcpb");
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
  const wsPath = join(workDir, "workspaces", wsId);
  const isMcpb = isMcpbRef(bundleRef);

  // Pre-flight duplicate check + dataDir derivation only run for refs whose
  // canonical name is knowable from the ref string itself. For .mcpb, the
  // manifest-derived name lives inside the archive — startBundleSource peeks
  // it. Pre-computing here would use the path-derived name ("echo-mcpb" for
  // "/uploads/echo.mcpb") which won't match the actual registered name
  // ("echo"). Skip and let startBundleSource own the registration; if the
  // name is already registered, registry.addSource throws.
  let preflightDataDir: string | undefined;
  if (!isMcpb) {
    const serverName = serverNameFromRef(bundleRef);
    if (registry.hasSource(serverName)) {
      throw new Error(`Bundle "${serverName}" is already running in workspace "${wsId}"`);
    }
    preflightDataDir = resolveBundleDataDir(wsPath, bundleNameFromRef(bundleRef));
  }

  const result = await startBundleSource(bundleRef, registry, eventSink, configDir, {
    allowInsecureRemotes: opts?.allowInsecureRemotes,
    dataDir: preflightDataDir,
    // Thread workspace id + work dir so the named-bundle path can resolve
    // `user_config` from the workspace credential store before prepareServer
    // validates it. Required for .mcpb too (workspace-scoped credentials).
    wsId,
    workDir,
  });

  // For .mcpb, the manifest-derived name only became knowable after
  // startBundleSource peeked the archive. Derive the canonical data-dir from
  // it so re-uploads land in the same dir across restarts (matches the named
  // branch convention).
  const dataDir = isMcpb
    ? resolveBundleDataDir(wsPath, result.sourceName)
    : (preflightDataDir as string);

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
 * Stops the MCP source, removes it from the registry, and clears the
 * workspace-scoped credential file for the bundle (best-effort —
 * failures are logged but do not fail the uninstall). Data directories
 * are intentionally preserved.
 *
 * `serverName` is the resolved lifecycle key — caller is responsible
 * for reading it from the persisted `BundleRef.serverName` (set at
 * install time from `slugifyServerName(entry.id)`) with
 * `deriveServerName(bundleName)` as a back-compat fallback for legacy
 * refs. Passing the canonical name here would skip the slug and miss
 * the registered source.
 */
export async function uninstallBundleFromWorkspace(
  wsId: string,
  bundleName: string,
  serverName: string,
  registry: ToolRegistry,
  opts?: { workDir?: string },
): Promise<void> {
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
      `[workspace-ops] Failed to clear credentials for ${bundleName} in ${wsId}: ${msg}\n`,
    );
  }
}
