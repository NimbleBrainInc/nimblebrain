#!/usr/bin/env bun
/**
 * Stage 1.1 cleanup: enforce sole-owner-admin membership on existing
 * personal workspaces.
 *
 * Stage 1 introduced personal workspaces (`isPersonal: true`,
 * `ownerUserId: <user>`) but didn't enforce that their `members` array
 * matched the canonical sole-owner shape. The hq production tenant
 * surfaced a personal workspace with three admins, which Stage 1.1
 * now disallows at the store layer. Operators with pre-existing data
 * shaped by the looser invariant run this script once to converge.
 *
 * For each workspace where `isPersonal === true`:
 *   - If `members` is already `[{ userId: ownerUserId, role: "admin" }]`
 *     → no-op (idempotent — running twice produces no changes).
 *   - If `members` contains non-owner entries OR the owner's role is
 *     not "admin" → rewrite to the canonical shape:
 *     `[{ userId: ownerUserId, role: "admin" }]`. Any non-owner
 *     members are dropped from the personal workspace; they retain
 *     their own personal workspaces and any shared-workspace
 *     memberships elsewhere.
 *   - If `ownerUserId` is missing on a personal workspace → hard-error.
 *     We can't safely guess the owner; an operator must repair
 *     manually (or delete the workspace if it's an orphan).
 *
 * Non-personal workspaces are untouched.
 *
 * Usage:
 *     bun run scripts/cleanup-personal-workspace-members.ts [--work-dir <path>] [--dry-run | --apply]
 *
 * Default is dry-run. Use `--apply` to actually write.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/util/atomic-json.ts";
import type { Workspace } from "../src/workspace/types.ts";
import { WorkspaceStore } from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

interface Args {
  workDir: string;
  apply: boolean;
}

interface Stats {
  workspacesScanned: number;
  personalScanned: number;
  alreadyClean: number;
  cleaned: number;
  nonPersonalSkipped: number;
  errors: { ctx: string; message: string }[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  // Default to dry-run — operator opts into writes via --apply. This
  // mirrors the Stage 1 migration ergonomics; the cleanup is
  // destructive (drops non-owner members) so the bias is toward
  // visibility-first.
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--work-dir") {
      workDir = argv[++i] ?? "";
    } else if (arg?.startsWith("--work-dir=")) {
      workDir = arg.slice("--work-dir=".length);
    } else {
      console.error(`[cleanup] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!workDir) {
    console.error("[cleanup] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, apply };
}

function printHelp(): void {
  console.log(`
cleanup-personal-workspace-members — Stage 1.1 follow-up

Enforces sole-owner-admin membership on every personal workspace.
Non-owner members on personal workspaces are dropped; the owner's
role is forced to "admin".

Usage:
  bun run scripts/cleanup-personal-workspace-members.ts [options]

Options:
  --work-dir <path>   Override the work directory.
                      Defaults to $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           Report planned changes without writing (default).
  --apply             Actually write changes.
  -h, --help          This message.

Idempotent: running twice produces no changes the second time.
Run with --dry-run first to verify the plan.
`);
}

/**
 * Compute the canonical sole-owner-admin members array for a personal
 * workspace. Single source of truth — both the planner and the writer
 * use it so the dry-run reflects the same end state as `--apply`.
 */
function canonicalMembers(ownerUserId: string): Workspace["members"] {
  return [{ userId: ownerUserId, role: "admin" }];
}

/**
 * Decide whether `ws` already matches the canonical sole-owner-admin
 * shape. A personal workspace passes iff:
 *   - exactly one member,
 *   - that member's `userId` is the workspace's `ownerUserId`,
 *   - that member's `role` is "admin".
 */
function isCanonical(ws: Workspace): boolean {
  if (!ws.ownerUserId) return false;
  if (ws.members.length !== 1) return false;
  const sole = ws.members[0];
  if (!sole) return false;
  return sole.userId === ws.ownerUserId && sole.role === "admin";
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(
    `[cleanup] workDir=${args.workDir}${args.apply ? " (apply)" : " (dry-run)"}`,
  );

  const workspacesDir = join(args.workDir, "workspaces");
  if (!existsSync(workspacesDir)) {
    console.error(`[cleanup] no workspaces dir at ${workspacesDir} — nothing to do`);
    return;
  }

  // Hold the same lock the Stage 1 migrations use. Even a dry-run
  // reading state concurrently with a real migration could surface
  // inconsistent results.
  acquireMigrationLock(args.workDir, "cleanup-personal-workspace-members");

  const wsStore = new WorkspaceStore(args.workDir);
  const stats: Stats = {
    workspacesScanned: 0,
    personalScanned: 0,
    alreadyClean: 0,
    cleaned: 0,
    nonPersonalSkipped: 0,
    errors: [],
  };

  const workspaces = await wsStore.list();
  for (const ws of workspaces) {
    stats.workspacesScanned++;

    if (ws.isPersonal !== true) {
      stats.nonPersonalSkipped++;
      continue;
    }

    stats.personalScanned++;

    if (!ws.ownerUserId) {
      // Hard-error rather than guess. A personal workspace with no
      // owner is data corruption; running the Stage 1 migration
      // (`migrate:personal-workspaces`) should have stamped one, or
      // the workspace is an orphan that needs operator triage.
      const message = `personal workspace ${ws.id} has isPersonal:true but no ownerUserId — operator action required (stamp manually or delete)`;
      console.error(`[cleanup] ERROR: ${message}`);
      stats.errors.push({ ctx: ws.id, message });
      continue;
    }

    if (isCanonical(ws)) {
      stats.alreadyClean++;
      continue;
    }

    // Report the diff so operators have a clear before/after in the
    // dry-run output. Non-owner members are listed by id so the log
    // doubles as a record of what got dropped.
    const currentSummary = ws.members
      .map((m) => `${m.userId}:${m.role}`)
      .join(", ");
    const dropped = ws.members
      .filter((m) => m.userId !== ws.ownerUserId)
      .map((m) => m.userId);
    const targetSummary = `${ws.ownerUserId}:admin`;
    console.error(
      `[cleanup] ${ws.id} (owner=${ws.ownerUserId}): members [${currentSummary}] → [${targetSummary}]` +
        (dropped.length > 0 ? ` (dropped: ${dropped.join(", ")})` : ""),
    );

    if (!args.apply) {
      stats.cleaned++;
      continue;
    }

    try {
      // Write the full record directly — `WorkspaceStore.update` now
      // rejects member mutations on personal workspaces (by design),
      // and the same is true at the addMember/removeMember layer.
      // The cleanup script's purpose is precisely to repair the state
      // that the store no longer permits to be reached through normal
      // mutation, so it writes around the guard at the filesystem
      // layer using the same precedent set by Stage 1's
      // `stampNonPersonal` (which also bypassed `update`).
      const updated: Workspace = {
        ...ws,
        members: canonicalMembers(ws.ownerUserId),
        updatedAt: new Date().toISOString(),
      };
      const wsPath = join(workspacesDir, ws.id, "workspace.json");
      await writeJsonAtomic(wsPath, updated);
      stats.cleaned++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cleanup] ERROR writing ${ws.id}: ${message}`);
      stats.errors.push({ ctx: ws.id, message });
    }
  }

  console.error("");
  console.error(`[cleanup] summary${args.apply ? "" : " (dry-run)"}:`);
  console.error(`[cleanup]   workspaces scanned:      ${stats.workspacesScanned}`);
  console.error(`[cleanup]   non-personal skipped:    ${stats.nonPersonalSkipped}`);
  console.error(`[cleanup]   personal scanned:        ${stats.personalScanned}`);
  console.error(`[cleanup]   already canonical:       ${stats.alreadyClean}`);
  console.error(`[cleanup]   ${args.apply ? "cleaned" : "would clean"}:${
    args.apply ? "          " : "       "
  } ${stats.cleaned}`);
  console.error(`[cleanup]   errors:                  ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors) console.error(`[cleanup]     [error] ${e.ctx}: ${e.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
