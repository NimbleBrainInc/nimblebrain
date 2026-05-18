/**
 * Workspace-scoped bundle install/uninstall operations.
 *
 * These are consumed by system tools for hot bundle management within workspaces.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolRegistry } from "../tools/registry.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { bundleNameFromRef, deriveBundleDataDir, serverNameFromRef } from "./paths.ts";
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
  const workDir = opts?.workDir ?? process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  const wsContext = new WorkspaceContext({ wsId, workDir });
  const serverName = serverNameFromRef(bundleRef);
  const bundleName = bundleNameFromRef(bundleRef);
  const dataDir = wsContext.getDataPath("data", deriveBundleDataDir(bundleName));

  // Check for existing registration
  if (registry.hasSource(serverName)) {
    throw new Error(`Bundle "${serverName}" is already running in workspace "${wsId}"`);
  }

  const result = await startBundleSource(bundleRef, registry, eventSink, configDir, {
    allowInsecureRemotes: opts?.allowInsecureRemotes,
    dataDir,
    // Thread the workspace context so the named-bundle path can resolve
    // `user_config` from the workspace credential store before prepareServer
    // validates it.
    workspaceContext: wsContext,
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
    await new WorkspaceContext({ wsId, workDir }).getCredentialStore().clearAll(bundleName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[workspace-ops] Failed to clear credentials for ${bundleName} in ${wsId}: ${msg}\n`,
    );
  }
}
