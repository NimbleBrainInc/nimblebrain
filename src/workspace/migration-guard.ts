import type { Workspace } from "./types.ts";

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
