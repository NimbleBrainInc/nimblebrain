/**
 * Workspace-scoped connector install operation.
 *
 * Consumed by connector install for hot connector management within a
 * workspace. (Uninstall is owned by `ConnectorLifecycleManager.uninstall`,
 * which resolves the server name, clears credentials, and unregisters
 * placements and config in one place.)
 */

import type { EventSink } from "../../engine/types.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import { WorkspaceContext } from "../../workspace/context.ts";
import { defaultWorkDir, resolveConnectorDataDirForRef, serverNameFromRef } from "./paths.ts";
import { type ConnectorMcpDeps, startConnectorSource } from "./startup.ts";
import type { ConnectorRef, LocalConnectorMeta } from "./types.ts";

/** A single entry in the process inventory — one per (workspace, connector) pair. */
export interface ProcessInventoryEntry {
  wsId: string;
  connector: ConnectorRef;
  dataDir: string;
  serverName: string;
  meta?: LocalConnectorMeta | null;
}

/**
 * Install a connector in a specific workspace (hot — no restart required).
 *
 * Connects to the remote endpoint and registers the source in the workspace's
 * ToolRegistry under its plain server name.
 */
export async function installConnectorInWorkspace(
  wsId: string,
  connectorRef: ConnectorRef,
  registry: ToolRegistry,
  // Required — threaded into the new McpSource so task-augmented tools'
  // progress events reach SSE. See mcp-source.ts for the full rationale.
  eventSink: EventSink,
  opts?: {
    allowInsecureRemotes?: boolean;
    workDir?: string;
    /**
     * Per-workspace host-resources deps. Caller (`connector-tools`,
     * catalog/hot install) pulls from Runtime. Passed through to
     * `startConnectorSource` so the new McpSource registers inbound
     * `ai.nimblebrain/resources/*` handlers.
     */
    connectorMcp?: ConnectorMcpDeps;
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
  const serverName = serverNameFromRef(connectorRef);
  if (serverName === null) {
    // Install builds this ref from a catalog entry, so a null here is a
    // caller bug rather than stale disk data — say so instead of failing
    // later with a name nothing can look up.
    throw new Error(
      `[connectors] cannot install into "${wsId}": the connector ref names no server ` +
        `(url: ${JSON.stringify(connectorRef.url)}).`,
    );
  }
  const dataDir = resolveConnectorDataDirForRef(workDir, wsId, connectorRef);

  // Liveness, not membership: a registered-but-dead source (a retained
  // boot-start failure) is installed, not running, and rejecting the install
  // with "already running" would be both false and unactionable. Let it through
  // — `startConnectorSource` adopts over the dead entry.
  if (registry.hasEstablishedSource(serverName)) {
    throw new Error(`Connector "${serverName}" is already running in workspace "${wsId}"`);
  }

  const result = await startConnectorSource(connectorRef, registry, eventSink, {
    allowInsecureRemotes: opts?.allowInsecureRemotes,
    workspaceContext: wsContext,
    connectorMcp: opts?.connectorMcp,
  });

  return {
    wsId,
    connector: connectorRef,
    dataDir,
    serverName: result.sourceName,
    meta: result.meta,
  };
}
