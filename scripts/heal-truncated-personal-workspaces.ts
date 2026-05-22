#!/usr/bin/env bun
/**
 * Stage 1 follow-up: heal personal workspaces whose legacy slug used
 * the 16-char-truncated form (e.g. `ws_01kp730nhbcj3ck2`) instead of
 * the full lowercased ULID (`ws_01kp730nhbcj3ck2hfhe3hmnf6`).
 *
 * `migrate-personal-workspaces.ts` assumed the pre-Stage-1 slug was the
 * full `user.id` with the `user_` prefix stripped (`legacySlugForUserId`,
 * 26 chars). Production tenants like hq turned out to use the 16-char
 * truncation, so the migration didn't recognize those workspaces as
 * personal: they ended up stamped `isPersonal: false` and, where Stage 0
 * had backfilled it, an empty canonical-form stub holds the Personal
 * slot at `ws_user_<userId>`.
 *
 * For each user:
 *  - `truncatedId = "ws_" + userId.replace(/^user_/, "").toLowerCase().slice(0, 16)`
 *  - `canonicalId = personalWorkspaceIdFor(userId)`
 *  - If `truncatedId` directory exists AND `workspace.json.name` is
 *    exactly `<displayName>'s Workspace` AND the user is an admin
 *    member → eligible.
 *  - If `canonicalId` exists too: it MUST be empty (0 bundles, 0
 *    top-level conversations referencing it) to be deleted. If it has
 *    bundles or referencing conversations, hard-error — operator
 *    reconciles. Auto-merging a stub holding real state would be
 *    silently destructive.
 *  - Rename `truncatedId` → `canonicalId` atomically; rewrite
 *    `workspace.json` (id, isPersonal, ownerUserId, about, updatedAt);
 *    rewrite the metadata line of every `{workDir}/conversations/*.jsonl`
 *    whose `workspaceId` equals `truncatedId`.
 *
 * Idempotent and one-phase. Designed to run during a maintenance window
 * with the platform stopped, AFTER `migrate-personal-workspaces`. Holds
 * the same `.migration-lock` PID file; concurrent runs refuse to start.
 *
 * Usage:
 *     bun run scripts/heal-truncated-personal-workspaces.ts [--work-dir <path>] [--dry-run]
 */

import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserStore } from "../src/identity/user.ts";
import { writeJsonAtomic } from "../src/util/atomic-json.ts";
import type { Workspace } from "../src/workspace/types.ts";
import {
  personalWorkspaceIdFor,
  WorkspaceStore,
} from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface Stats {
  usersScanned: number;
  healed: number;
  alreadyCanonical: number;
  noTruncatedWorkspace: number;
  skippedNameMismatch: number;
  skippedNotAdmin: number;
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
      console.error(`[heal] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!workDir) {
    console.error("[heal] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, dryRun };
}

function printHelp(): void {
  console.log(`
heal-truncated-personal-workspaces — Stage 1 follow-up

Heals personal workspaces whose legacy slug used the 16-char-truncated
form, which the original migrate-personal-workspaces did not recognize.

Usage:
  bun run scripts/heal-truncated-personal-workspaces.ts [options]

Options:
  --work-dir <path>   Override the work directory.
                      Defaults to $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           Report planned changes without writing.
  -h, --help          This message.

Run AFTER migrate-personal-workspaces. Idempotent: running twice produces
no changes the second time. Run with --dry-run first to verify the plan.
`);
}

/**
 * Build the 16-char-truncated personal-workspace id this script targets.
 * The truncation form was an artifact of pre-Stage-1 hq production — a
 * legacy convention not used elsewhere and intentionally not exported.
 */
function truncatedPersonalIdFor(userId: string): string {
  const slug = userId.replace(/^user_/, "").toLowerCase().slice(0, 16);
  return `ws_${slug}`;
}

function isAdminOf(ws: Workspace, userId: string): boolean {
  return ws.members.some((m) => m.userId === userId && m.role === "admin");
}

/**
 * Count top-level conversation JSONL files whose metadata's
 * `workspaceId` equals `id`. Conversations are stored at
 * `{workDir}/conversations/*.jsonl` post-Stage-1.
 */
async function countConversationRefs(
  conversationsDir: string,
  id: string,
): Promise<number> {
  if (!existsSync(conversationsDir)) return 0;
  let n = 0;
  for (const fname of await readdir(conversationsDir)) {
    if (!fname.endsWith(".jsonl")) continue;
    const meta = await readConversationMetadata(join(conversationsDir, fname));
    if (meta && meta.workspaceId === id) n++;
  }
  return n;
}

/**
 * Read the metadata line (line 1) of a conversation JSONL. Returns null
 * if unreadable / unparseable — the file is left alone in that case.
 */
async function readConversationMetadata(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const newlineIdx = raw.indexOf("\n");
    const firstLine = newlineIdx < 0 ? raw : raw.slice(0, newlineIdx);
    return JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Rewrite the metadata line of a conversation JSONL so its
 * `workspaceId` reflects the renamed workspace. Returns true if
 * rewritten. Other lines pass through byte-identical.
 */
async function rewriteConversationWorkspaceId(
  filePath: string,
  oldId: string,
  newId: string,
): Promise<boolean> {
  const raw = await readFile(filePath, "utf-8");
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx < 0) return false;

  const metadataLine = raw.slice(0, newlineIdx);
  const rest = raw.slice(newlineIdx); // includes the leading \n

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadataLine);
  } catch {
    return false;
  }
  if (meta.workspaceId !== oldId) return false;
  meta.workspaceId = newId;
  const newMetadata = JSON.stringify(meta);

  const tmp = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmp, `${newMetadata}${rest}`, { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
  return true;
}

/**
 * Heal one user's truncated personal workspace. All filesystem mutations
 * are confined to here; the caller composes pre-checks + stats.
 */
async function healOne(opts: {
  workspacesDir: string;
  conversationsDir: string;
  truncatedId: string;
  canonicalId: string;
  userId: string;
  truncatedWs: Workspace;
  dryRun: boolean;
}): Promise<{ ok: true } | { error: string }> {
  const {
    workspacesDir,
    conversationsDir,
    truncatedId,
    canonicalId,
    userId,
    dryRun,
  } = opts;

  const truncatedDir = join(workspacesDir, truncatedId);
  const canonicalDir = join(workspacesDir, canonicalId);

  // Stub-handling on the canonical id.
  if (existsSync(canonicalDir)) {
    const canonicalWsPath = join(canonicalDir, "workspace.json");
    if (existsSync(canonicalWsPath)) {
      const canonicalWs = JSON.parse(
        await readFile(canonicalWsPath, "utf-8"),
      ) as Workspace;
      const bundleCount = canonicalWs.bundles?.length ?? 0;
      const refCount = await countConversationRefs(conversationsDir, canonicalId);
      if (bundleCount > 0 || refCount > 0) {
        return {
          error:
            `canonical stub ${canonicalId} holds state ` +
            `(bundles=${bundleCount}, convRefs=${refCount}) — ` +
            "manual reconciliation required",
        };
      }
      console.error(
        `[heal] ${userId}: ${dryRun ? "[dry-run] would " : ""}delete empty canonical stub ${canonicalId}`,
      );
      if (!dryRun) await rm(canonicalDir, { recursive: true, force: true });
    } else {
      console.error(
        `[heal] ${userId}: ${dryRun ? "[dry-run] would " : ""}delete stub dir ${canonicalId} (no workspace.json)`,
      );
      if (!dryRun) await rm(canonicalDir, { recursive: true, force: true });
    }
  }

  // Rename truncatedId → canonicalId.
  console.error(
    `[heal] ${userId}: ${dryRun ? "[dry-run] would " : ""}rename ${truncatedId} → ${canonicalId}`,
  );
  if (!dryRun) {
    await rename(truncatedDir, canonicalDir);
    // Rewrite workspace.json with identity stamps.
    const wsPath = join(canonicalDir, "workspace.json");
    const raw = await readFile(wsPath, "utf-8");
    const ws = JSON.parse(raw) as Workspace;
    const updated: Workspace = {
      ...ws,
      id: canonicalId,
      isPersonal: true,
      ownerUserId: userId,
      about: ws.about ?? null,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(wsPath, updated);
  }

  // Rewrite workspaceId on conversations that point at the truncated id.
  let rewrites = 0;
  if (existsSync(conversationsDir)) {
    for (const fname of await readdir(conversationsDir)) {
      if (!fname.endsWith(".jsonl")) continue;
      const cpath = join(conversationsDir, fname);
      const meta = await readConversationMetadata(cpath);
      if (!meta || meta.workspaceId !== truncatedId) continue;
      if (dryRun) {
        rewrites++;
        continue;
      }
      if (await rewriteConversationWorkspaceId(cpath, truncatedId, canonicalId)) {
        rewrites++;
      }
    }
  }
  console.error(
    `[heal] ${userId}: ${dryRun ? "[dry-run] would " : ""}rewrite workspaceId on ${rewrites} conversation(s)`,
  );

  return { ok: true };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(
    `[heal] workDir=${args.workDir}${args.dryRun ? " (dry-run)" : ""}`,
  );

  const workspacesDir = join(args.workDir, "workspaces");
  const usersDir = join(args.workDir, "users");
  const conversationsDir = join(args.workDir, "conversations");

  if (!existsSync(workspacesDir)) {
    console.error(`[heal] no workspaces dir at ${workspacesDir} — nothing to do`);
    return;
  }
  if (!existsSync(usersDir)) {
    console.error(`[heal] no users dir at ${usersDir} — nothing to do`);
    return;
  }

  // Same lock as the Stage 1 migrations. Auto-released on exit / signal.
  acquireMigrationLock(args.workDir, "heal-truncated-personal-workspaces");

  const userStore = new UserStore(args.workDir);
  const wsStore = new WorkspaceStore(args.workDir);
  const stats: Stats = {
    usersScanned: 0,
    healed: 0,
    alreadyCanonical: 0,
    noTruncatedWorkspace: 0,
    skippedNameMismatch: 0,
    skippedNotAdmin: 0,
    errors: [],
  };

  const users = await userStore.list();
  for (const user of users) {
    stats.usersScanned++;
    const canonicalId = personalWorkspaceIdFor(user.id);
    const truncatedId = truncatedPersonalIdFor(user.id);

    // The truncation only matters when the truncated form differs from
    // the canonical form (it always will for real `user_<ULID>` ids, but
    // synthetic / short test ids may collapse — skip those cleanly).
    if (truncatedId === canonicalId) {
      stats.alreadyCanonical++;
      continue;
    }

    try {
      const truncatedWs = await wsStore.get(truncatedId);
      if (!truncatedWs) {
        console.error(
          `[heal] ${user.id}: no truncated workspace ${truncatedId} — skip`,
        );
        stats.noTruncatedWorkspace++;
        continue;
      }

      const expectedName = `${user.displayName}'s Workspace`;
      if (truncatedWs.name !== expectedName) {
        console.error(
          `[heal] ${user.id}: ${truncatedId} name ${JSON.stringify(truncatedWs.name)} != expected ${JSON.stringify(expectedName)} — skip (not a personal workspace)`,
        );
        stats.skippedNameMismatch++;
        continue;
      }

      if (!isAdminOf(truncatedWs, user.id)) {
        console.error(
          `[heal] ${user.id}: not admin of ${truncatedId} — skip`,
        );
        stats.skippedNotAdmin++;
        continue;
      }

      const result = await healOne({
        workspacesDir,
        conversationsDir,
        truncatedId,
        canonicalId,
        userId: user.id,
        truncatedWs,
        dryRun: args.dryRun,
      });
      if ("error" in result) {
        console.error(`[heal] ${user.id}: ERROR: ${result.error}`);
        stats.errors.push({ ctx: user.id, message: result.error });
        continue;
      }
      stats.healed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[heal] ERROR for user ${user.id}: ${message}`);
      stats.errors.push({ ctx: user.id, message });
    }
  }

  console.error("");
  console.error(`[heal] summary${args.dryRun ? " (dry-run)" : ""}:`);
  console.error(`[heal]   users scanned:                 ${stats.usersScanned}`);
  console.error(`[heal]   healed users:                  ${stats.healed}`);
  console.error(`[heal]   already canonical (skipped):   ${stats.alreadyCanonical}`);
  console.error(`[heal]   no truncated workspace:        ${stats.noTruncatedWorkspace}`);
  console.error(`[heal]   skipped (name mismatch):       ${stats.skippedNameMismatch}`);
  console.error(`[heal]   skipped (not admin):           ${stats.skippedNotAdmin}`);
  console.error(`[heal]   errors:                        ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors) {
      console.error(`[heal]     [error] ${e.ctx}: ${e.message}`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
