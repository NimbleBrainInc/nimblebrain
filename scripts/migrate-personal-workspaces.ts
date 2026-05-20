#!/usr/bin/env bun
/**
 * Stage 1 migration: rename personal workspaces to the canonical
 * `ws_user_<userId>` form and stamp identity fields (`isPersonal`,
 * `ownerUserId`) on every workspace.
 *
 * Idempotent and one-phase. Designed to run during a maintenance window
 * with the platform stopped. The complementary
 * `migrate-conversations-to-top-level.ts` should run AFTER this one so
 * conversation metadata's `workspaceId` references the post-rename id.
 *
 * For each user:
 *  - If a workspace exists at the new canonical id → stamp identity
 *    fields if missing, ensure membership.
 *  - Else, if a legacy-form workspace exists (`ws_<deriveSlug(user.id)>`)
 *    and the user is a member → rename it: move the directory atomically,
 *    rewrite `workspace.json`, rewrite `workspaceId` in any conversation
 *    metadata that still lives under the workspace dir.
 *  - Else → leave alone. `ensureUserWorkspace` will create the personal
 *    workspace lazily on next login.
 *
 * For every non-personal workspace: stamp `isPersonal: false` eagerly so
 * operators inspecting workspace.json see the field.
 *
 * Usage:
 *     bun run scripts/migrate-personal-workspaces.ts [--work-dir <path>] [--dry-run]
 */

import { existsSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserStore } from "../src/identity/user.ts";
import { writeJsonAtomic } from "../src/util/atomic-json.ts";
import {
  personalWorkspaceIdFor,
  WorkspaceStore,
} from "../src/workspace/workspace-store.ts";
import type { Workspace } from "../src/workspace/types.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface Stats {
  usersScanned: number;
  personalAtNewId: number;
  renamed: number;
  noPersonalWorkspace: number;
  nonPersonalStamped: number;
  errors: { ctx: string; message: string }[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--work-dir") {
      workDir = argv[++i] ?? "";
    } else if (arg?.startsWith("--work-dir=")) {
      workDir = arg.slice("--work-dir=".length);
    } else {
      console.error(`[migrate] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!workDir) {
    console.error("[migrate] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, dryRun };
}

function printHelp(): void {
  console.log(`
migrate-personal-workspaces — Stage 1 of the delegation-model refactor

Renames personal workspaces to ws_user_<userId> and stamps isPersonal /
ownerUserId fields on every workspace.

Usage:
  bun run scripts/migrate-personal-workspaces.ts [options]

Options:
  --work-dir <path>   Override the work directory.
                      Defaults to $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           Report planned changes without writing.
  -h, --help          This message.

Idempotent: running twice produces no changes the second time.
Run with --dry-run first to verify the plan.
`);
}

/**
 * Replicate the pre-Stage-1 slug derivation so we can detect a user's
 * legacy personal workspace.
 *
 * The old `ensureUserWorkspace` did:
 *   slug = userId.replace(/^user_/, "").toLowerCase()
 *
 * Kept here as a private constant — NOT exported, because no code path
 * outside this migration should care about the legacy convention.
 */
function legacySlugForUserId(userId: string): string {
  return userId.replace(/^user_/, "").toLowerCase();
}

function legacyPersonalIdFor(userId: string): string {
  return `ws_${legacySlugForUserId(userId)}`;
}

function isPersonalWorkspaceOf(ws: Workspace, userId: string): boolean {
  // A workspace counts as "this user's personal workspace" if they are
  // a member with admin role. Stage 0 ensureUserWorkspace always added
  // the owning user as admin; conservative pattern.
  return ws.members.some((m) => m.userId === userId && m.role === "admin");
}

/**
 * Rename `workspaces/{oldId}` → `workspaces/{newId}` and rewrite the
 * embedded id + identity fields in workspace.json. Also scans the
 * renamed workspace's `conversations/` dir and rewrites the
 * `workspaceId` field in any conversation metadata lines that still
 * point at the old id. Atomic at the directory level via `rename(2)`;
 * the subsequent in-dir rewrites are best-effort per-file atomic.
 */
async function renameWorkspace(
  workspacesDir: string,
  oldId: string,
  newId: string,
  userId: string,
  dryRun: boolean,
): Promise<void> {
  const oldDir = join(workspacesDir, oldId);
  const newDir = join(workspacesDir, newId);

  if (existsSync(newDir)) {
    throw new Error(
      `cannot rename ${oldId} → ${newId}: target ${newId} already exists`,
    );
  }

  if (dryRun) {
    console.error(`[migrate]   [dry-run] would rename ${oldId} → ${newId}`);
    return;
  }

  // Atomic directory rename.
  await rename(oldDir, newDir);

  // Rewrite workspace.json embedded id + stamp identity fields.
  const wsPath = join(newDir, "workspace.json");
  const raw = await readFile(wsPath, "utf-8");
  const ws = JSON.parse(raw) as Workspace;
  const updated: Workspace = {
    ...ws,
    id: newId,
    isPersonal: true,
    ownerUserId: userId,
    about: ws.about ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(wsPath, updated);

  // Rewrite any conversation metadata pointing at the old id.
  const convDir = join(newDir, "conversations");
  if (!existsSync(convDir)) return;
  for (const fname of await readdir(convDir)) {
    if (!fname.endsWith(".jsonl")) continue;
    await rewriteConversationWorkspaceId(join(convDir, fname), oldId, newId);
  }
}

/**
 * Rewrite the metadata line (line 1) of a conversation JSONL so its
 * `workspaceId` reflects the renamed workspace. Other lines are passed
 * through byte-identical — never reparse run/llm/tool events here.
 */
async function rewriteConversationWorkspaceId(
  filePath: string,
  oldId: string,
  newId: string,
): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx < 0) return;

  const metadataLine = raw.slice(0, newlineIdx);
  const rest = raw.slice(newlineIdx); // includes the leading \n

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadataLine);
  } catch {
    // Malformed metadata; leave the file alone. Operator can fix.
    return;
  }
  if (meta.workspaceId !== oldId) return; // already migrated or different ws
  meta.workspaceId = newId;
  const newMetadata = JSON.stringify(meta);

  // Atomic write: tmp file + rename.
  const tmp = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmp, `${newMetadata}${rest}`, { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}

/**
 * Stamp `isPersonal: false` (and stamp `about: null` defensively) on a
 * non-personal workspace that's missing those fields. Idempotent — if
 * the fields already match the canonical-shape, no write.
 */
async function stampNonPersonal(
  store: WorkspaceStore,
  ws: Workspace,
  dryRun: boolean,
): Promise<boolean> {
  const wantsPersonalStamp = ws.isPersonal !== false;
  const wantsAboutStamp = ws.about === undefined;
  if (!wantsPersonalStamp && !wantsAboutStamp) return false;
  if (dryRun) return true;

  // Write directly — `store.update` strips isPersonal/ownerUserId by
  // design (Task 001). For the migration we DO need to write isPersonal,
  // so we bypass the patch shape and write the full record.
  const updated: Workspace = {
    ...ws,
    isPersonal: false,
    about: ws.about ?? null,
    updatedAt: new Date().toISOString(),
  };
  // ownerUserId is forbidden on non-personal workspaces — if some
  // bogus state has it set, strip it.
  delete (updated as { ownerUserId?: string }).ownerUserId;

  const wsPath = join(store.getWorkspacesDir(), ws.id, "workspace.json");
  await writeJsonAtomic(wsPath, updated);
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`[migrate] workDir=${args.workDir}${args.dryRun ? " (dry-run)" : ""}`);

  const workspacesDir = join(args.workDir, "workspaces");
  const usersDir = join(args.workDir, "users");

  if (!existsSync(workspacesDir)) {
    console.error(`[migrate] no workspaces dir at ${workspacesDir} — nothing to do`);
    return;
  }
  if (!existsSync(usersDir)) {
    console.error(`[migrate] no users dir at ${usersDir} — nothing to do`);
    return;
  }

  // Block concurrent migrations on the same workDir. Two operators
  // racing rename / writeJsonAtomic on the same workspace would corrupt
  // it; the lock makes the contention visible instead of silent.
  acquireMigrationLock(args.workDir, "migrate-personal-workspaces");

  const userStore = new UserStore(args.workDir);
  const wsStore = new WorkspaceStore(args.workDir);
  const stats: Stats = {
    usersScanned: 0,
    personalAtNewId: 0,
    renamed: 0,
    noPersonalWorkspace: 0,
    nonPersonalStamped: 0,
    errors: [],
  };

  const users = await userStore.list();
  for (const user of users) {
    stats.usersScanned++;
    const newId = personalWorkspaceIdFor(user.id);
    const oldId = legacyPersonalIdFor(user.id);

    try {
      const atNew = await wsStore.get(newId);
      if (atNew) {
        // Personal workspace already at the new id. Stamp identity
        // fields if missing.
        //
        // Partial-rename recovery: if a prior run crashed between
        // `rename(oldDir, newDir)` and the workspace.json rewrite,
        // the file at the new path still carries `id: oldId` inside.
        // Spread-without-override would preserve that stale id; the
        // explicit `id: newId` below heals that state on rerun. The
        // stamping condition (`isPersonal !== true ||
        // ownerUserId !== user.id`) holds in this partial-rename
        // case because the workspace.json rewrite never ran, so we
        // reliably enter this branch and write the corrected id.
        if (atNew.isPersonal !== true || atNew.ownerUserId !== user.id) {
          if (!args.dryRun) {
            const wsPath = join(workspacesDir, newId, "workspace.json");
            const updated: Workspace = {
              ...atNew,
              id: newId,
              isPersonal: true,
              ownerUserId: user.id,
              about: atNew.about ?? null,
              updatedAt: new Date().toISOString(),
            };
            await writeJsonAtomic(wsPath, updated);
          }
          console.error(
            `[migrate] ${user.id} → ${newId}: stamped identity fields`,
          );
        }

        // Surface the both-exist data-corruption case. The user's
        // personal workspace at the new id is canonical, but if a
        // legacy-shaped workspace ALSO exists for them at the old id,
        // it's now orphaned (no rename target). Operators should
        // decide what to do with it (delete? merge? archive?) —
        // log loudly so it doesn't sit silently in `workspaces/`.
        if (oldId !== newId) {
          const atOldStrayed = await wsStore.get(oldId);
          if (atOldStrayed && isPersonalWorkspaceOf(atOldStrayed, user.id)) {
            console.warn(
              `[migrate] ${user.id}: ORPHANED legacy workspace at ${oldId} — ` +
                `${newId} already exists; the legacy workspace is left in place. ` +
                `Operator action required: inspect and decide whether to delete / merge / archive ${oldId}.`,
            );
          }
        }

        stats.personalAtNewId++;
        continue;
      }

      // No workspace at new id. Check for the legacy form.
      if (oldId !== newId) {
        const atOld = await wsStore.get(oldId);
        if (atOld && isPersonalWorkspaceOf(atOld, user.id)) {
          // Found legacy personal workspace. Rename it.
          console.error(`[migrate] ${user.id}: renaming ${oldId} → ${newId}`);
          await renameWorkspace(workspacesDir, oldId, newId, user.id, args.dryRun);
          stats.renamed++;
          continue;
        }
      }

      // Neither at the new id nor at the legacy id. Lazy-create on
      // next login is fine.
      console.error(
        `[migrate] ${user.id}: no personal workspace found (will be created on next login)`,
      );
      stats.noPersonalWorkspace++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] ERROR for user ${user.id}: ${message}`);
      stats.errors.push({ ctx: user.id, message });
    }
  }

  // Stamp isPersonal: false on every non-personal workspace.
  try {
    const allWorkspaces = await wsStore.list();
    for (const ws of allWorkspaces) {
      if (ws.isPersonal === true) continue; // personal, handled above
      try {
        const stamped = await stampNonPersonal(wsStore, ws, args.dryRun);
        if (stamped) stats.nonPersonalStamped++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[migrate] ERROR stamping non-personal ${ws.id}: ${message}`);
        stats.errors.push({ ctx: `non-personal:${ws.id}`, message });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[migrate] ERROR listing workspaces: ${message}`);
    stats.errors.push({ ctx: "non-personal-pass", message });
  }

  console.error("");
  console.error(`[migrate] summary${args.dryRun ? " (dry-run)" : ""}:`);
  console.error(`[migrate]   users scanned:                 ${stats.usersScanned}`);
  console.error(`[migrate]   personal workspaces at new id: ${stats.personalAtNewId}`);
  console.error(`[migrate]   personal workspaces renamed:   ${stats.renamed}`);
  console.error(`[migrate]   users without personal ws:     ${stats.noPersonalWorkspace}`);
  console.error(`[migrate]   non-personal workspaces stamped: ${stats.nonPersonalStamped}`);
  console.error(`[migrate]   errors:                        ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors) console.error(`[migrate]     [error] ${e.ctx}: ${e.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
