import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface WorkspaceMeta {
  isPersonal?: boolean;
  ownerUserId?: string;
  members?: { userId: string; role: "admin" | "member" }[];
}

/**
 * Resolve the owning user of a workspace from its on-disk `workspace.json`,
 * for the identity migrations (Phase B files, Phase C automations).
 *
 *   - Personal workspace (`isPersonal`): owner = `ownerUserId`.
 *   - Team workspace: owner = the earliest `role: "admin"` in `members[]`
 *     (members are stored in creation order, so this is the creator when the
 *     creator is still an admin). Team workspaces are forbidden from carrying
 *     `ownerUserId`, so membership is the only source.
 *
 * Returns `null` when ownership can't be determined (no readable
 * `workspace.json`, or a team workspace with no admin). Callers treat `null`
 * as a [FATAL] operator-reconcile — we never invent an owner.
 *
 * One source of truth so files and automations resolve ownership identically.
 */
export async function resolveWorkspaceOwner(
  workspacesDir: string,
  wsId: string,
): Promise<string | null> {
  const metaPath = join(workspacesDir, wsId, "workspace.json");
  if (!existsSync(metaPath)) return null;
  let meta: WorkspaceMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf-8")) as WorkspaceMeta;
  } catch {
    return null;
  }
  if (meta.isPersonal === true) {
    return typeof meta.ownerUserId === "string" && meta.ownerUserId.length > 0
      ? meta.ownerUserId
      : null;
  }
  return meta.members?.find((m) => m.role === "admin")?.userId ?? null;
}
