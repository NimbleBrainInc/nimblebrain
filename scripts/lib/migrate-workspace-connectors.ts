/**
 * The pure half of the workspace-connector migration: one `workspace.json`'s
 * text in, its migrated text out. Kept separate from the tree walk so the
 * transform is unit-testable without a filesystem.
 *
 * The runtime reads a workspace's connectors from `connectors[]`. A file that
 * declares them under the older key is rewritten here — in place, at the same
 * position in the object, so a diff of a migrated file is one line.
 */

/** What the transform did to one file. */
export type WorkspaceMigrationStatus =
  /** The file was rewritten. */
  | "changed"
  /** Already reads `connectors[]`; nothing to do. */
  | "unchanged"
  /** Malformed, ambiguous, or not a workspace record — reported, never written. */
  | "error";

export interface WorkspaceMigrationResult {
  status: WorkspaceMigrationStatus;
  /** The file's new contents. Only meaningful when `status === "changed"`. */
  content?: string;
  /** Why the file could not be migrated. Only set when `status === "error"`. */
  error?: string;
  /** One line describing what changed, for the run report. */
  detail?: string;
}

const OLD_KEY = "bundles";
const NEW_KEY = "connectors";

/**
 * Migrate one `workspace.json`'s text.
 *
 * Four cases, and the last two are why this is not a string replace:
 *  - only the old key → renamed in place.
 *  - only `connectors` → already migrated.
 *  - both keys → refused. Two connector lists is a state no run should pick
 *    a winner for.
 *  - neither → an empty `connectors[]` is written, because a record with no
 *    connector list at all cannot start and the migration is the one place
 *    positioned to say so.
 */
/** Parse the file, or say why it is not a workspace record. */
function parseRecord(raw: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `not valid JSON — ${err instanceof Error ? err.message : String(err)}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  return parsed as Record<string, unknown>;
}

/** Refuse a record this migration must not guess at. Null means it may proceed. */
function refuse(record: Record<string, unknown>, hasOld: boolean, hasNew: boolean): string | null {
  if (hasOld && hasNew) {
    return `declares both "${OLD_KEY}" and "${NEW_KEY}" — resolve by hand, then re-run`;
  }
  if (hasNew && !Array.isArray(record[NEW_KEY])) return `"${NEW_KEY}" is not an array`;
  if (hasOld && !Array.isArray(record[OLD_KEY])) return `"${OLD_KEY}" is not an array`;
  return null;
}

export function migrateWorkspaceContent(raw: string): WorkspaceMigrationResult {
  const record = parseRecord(raw);
  if (typeof record === "string") return { status: "error", error: record };

  const hasOld = Object.hasOwn(record, OLD_KEY);
  const hasNew = Object.hasOwn(record, NEW_KEY);

  const refusal = refuse(record, hasOld, hasNew);
  if (refusal) return { status: "error", error: refusal };
  if (hasNew) return { status: "unchanged" };

  // Rebuild so the renamed key keeps its position; a migrated file differs
  // from the original by one line.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key === OLD_KEY ? NEW_KEY : key] = value;
  }
  if (!hasOld) out[NEW_KEY] = [];

  return {
    status: "changed",
    content: `${JSON.stringify(out, null, 2)}\n`,
    detail: hasOld
      ? `${OLD_KEY} → ${NEW_KEY} (${(record[OLD_KEY] as unknown[]).length} entries)`
      : `no connector list — wrote an empty ${NEW_KEY}[]`,
  };
}
