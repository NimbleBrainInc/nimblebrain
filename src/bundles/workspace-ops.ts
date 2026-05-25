/**
 * Workspace-scoped bundle install operation.
 *
 * Consumed by connector install for hot bundle management within a
 * workspace. (Uninstall is owned by `BundleLifecycleManager.uninstall`,
 * which resolves the server name, clears credentials, and unregisters
 * placements/config/automations in one place.)
 */

import type { EventSink } from "../engine/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { defaultWorkDir, resolveBundleDataDirForRef, serverNameFromRef } from "./paths.ts";
import { type BundleMcpDeps, startBundleSource } from "./startup.ts";
import type { BundleRef, LocalBundleMeta } from "./types.ts";

/** A single entry in the process inventory — one per (workspace, bundle) pair. */
export interface ProcessInventoryEntry {
  wsId: string;
  bundle: BundleRef;
  dataDir: string;
  serverName: string;
  meta?: LocalBundleMeta | null;
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
  eventSink: EventSink,
  configDir: string | undefined,
  opts?: {
    allowInsecureRemotes?: boolean;
    workDir?: string;
    /**
     * Per-workspace host-resources deps. Caller (`connector-tools`,
     * catalog/hot install) pulls from Runtime. Passed through to
     * `startBundleSource` so the spawned bundle's McpSource registers
     * inbound `ai.nimblebrain/resources/*` handlers.
     */
    bundleMcp?: BundleMcpDeps;
  },
): Promise<ProcessInventoryEntry> {
  // Default workDir to `~/.nimblebrain` — previously this function fell
  // through to `""` and emitted relative paths from cwd (a latent bug),
  // out of step with every other workspace-scoped entry point. A caller
  // that explicitly passes `workDir: ""` now hits the `WorkspaceContext`
  // constructor's empty-string rejection (deliberate — relative paths in
  // this code path were never correct).
  const workDir = opts?.workDir ?? defaultWorkDir();
  const wsContext = new WorkspaceContext({ wsId, workDir });
  const serverName = serverNameFromRef(bundleRef);
  // Slug source is `manifest.name`, resolved via the canonical helper so the
  // launch-path data dir agrees with the seedInstance / briefing reader path.
  const dataDir = resolveBundleDataDirForRef(workDir, wsId, bundleRef, configDir);

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
    bundleMcp: opts?.bundleMcp,
  });

  return {
    wsId,
    bundle: bundleRef,
    dataDir,
    serverName: result.sourceName,
    meta: result.meta,
  };
}
