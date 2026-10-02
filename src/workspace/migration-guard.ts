import type { Workspace } from "./types.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/**
 * A `workspace.json` on disk still declares its connectors under the old key.
 * The runtime reads `connectors[]` and nothing else, so this is fatal rather
 * than something to tolerate: a workspace that boots with its connector list
 * silently empty looks identical to one that has none.
 */
export class UnmigratedWorkspaceError extends Error {
  readonly wsId: string;
  constructor(wsId: string) {
    super(
      `[workspace] ${wsId}: workspace.json has no "connectors" array. ` +
        "Run `bun run migrate:workspace-connectors <workDir> --write` before starting the platform.",
    );
    this.name = "UnmigratedWorkspaceError";
    this.wsId = wsId;
  }
}

/**
 * Assert a `Workspace` read from disk carries the connector array the runtime
 * reads. Throws `UnmigratedWorkspaceError` naming the operator step — the
 * migration is a one-shot the operator runs, never something the runtime
 * performs on boot, so the read boundary's only job is to refuse.
 *
 * Absent is the failure. An empty array is a workspace with no connectors and
 * passes.
 */
export function assertWorkspaceIsMigrated(ws: Workspace): void {
  // Widen to the on-disk shape: an un-migrated file parses fine and only the
  // static type says the field is there.
  const widened = ws as unknown as { connectors?: unknown };
  if (!Array.isArray(widened.connectors)) {
    throw new UnmigratedWorkspaceError(ws.id);
  }
}

/**
 * `workspaces/` holds a workspace whose directory name is not a workspace id.
 * Every id is `ws_` and 16 lowercase hex chars (`WORKSPACE_ID_PATTERN`), and
 * no door addresses any other form, so booting past one would serve an
 * instance with that workspace silently missing.
 */
export class NonConformingWorkspaceIdError extends Error {
  readonly wsIds: readonly string[];
  constructor(wsIds: readonly string[]) {
    super(
      `[workspace] workspaces/ holds ${wsIds.length} workspace(s) whose id is not ` +
        `ws_ followed by 16 lowercase hex chars: ${wsIds.join(", ")}. ` +
        "Each must be renamed to a generated id (directory, workspace.json `id`, and every " +
        "reference to the old id) before starting the platform.",
    );
    this.name = "NonConformingWorkspaceIdError";
    this.wsIds = wsIds;
  }
}

/**
 * Refuse to boot while `workspaces/` holds a `ws_*` directory with a
 * `workspace.json` whose name fails `WORKSPACE_ID_RE`. Like the connector
 * check above, renaming a workspace is an operator step, never something the
 * runtime performs on boot: an id is in URLs, external MCP client
 * configurations, and stored references the runtime cannot see.
 */
export async function assertWorkspaceIdsConform(store: WorkspaceStore): Promise<void> {
  const nonConforming = await store.listNonConformingIds();
  if (nonConforming.length > 0) throw new NonConformingWorkspaceIdError(nonConforming);
}
