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
import { readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { UserStore } from "../src/identity/user.ts";
import { writeJsonAtomic } from "../src/util/atomic-json.ts";
import type { Workspace } from "../src/workspace/types.ts";
import {
  personalWorkspaceIdFor,
  WorkspaceStore,
} from "../src/workspace/workspace-store.ts";
import {
  readConversationMetadata,
  rewriteConversationWorkspaceId,
} from "./lib/conversation-metadata.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface Stats {
  usersScanned: number;
  healed: number;
  partialRenameHealed: number;
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
 *
 * O(N) scan of the conversations dir per call. Acceptable for a
 * maintenance script that runs during a window — small tenants spend
 * milliseconds, large tenants spend seconds. If a future tenant has
 * a per-user count high enough to make this hot, build a single
 * `Map<workspaceId, count>` once in main and pass it in.
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
 * Recursively walk `dir`, returning the relative path of the first file
 * that ISN'T an expected sentinel. Used to detect canonical-stub content
 * a bundles+convRefs check alone misses — populated data/credentials/
 * skills/files/ subdirs, a legacy conversations/ subdir, or any other
 * file an `rm -rf` would silently destroy.
 *
 * Allowed:
 *  - `workspace.json` at the root.
 *  - Any `.gitkeep` (scaffolding sentinel for empty subdirs).
 *  - Any directory itself (recursion descends into it).
 *
 * Returns null when the tree contains only allowed entries.
 */
async function findUnexpectedContent(
  dir: string,
  root: string = dir,
): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      const rel = relative(root, full);
      if (rel === "workspace.json") continue;
      if (entry.name === ".gitkeep") continue;
      return rel;
    }
    if (entry.isDirectory()) {
      const inside = await findUnexpectedContent(full, root);
      if (inside) return inside;
    }
  }
  return null;
}

/**
 * Keys allowed on a "truly empty" canonical stub. Anything outside
 * this set is forbidden — new optional fields on `Workspace` default
 * to forbidden, which is the safe direction (a denylist would silently
 * allow new fields, e.g. `allowHttpProxy`, that the script doesn't
 * know about yet).
 *
 * Members of this set still have value-level checks below — `bundles`
 * must be empty, `members` must be exactly the owner-admin, etc.
 */
const ALLOWED_STUB_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "members",
  "bundles",
  "createdAt",
  "updatedAt",
  "about",
  "isPersonal",
  "ownerUserId",
]);

/**
 * Return the first populated `workspace.json` field whose contents
 * would be lost if this canonical stub is rm'd. The minimum shape for
 * a "truly empty" canonical stub is:
 *   - only structural keys present (allowlisted above)
 *   - exactly the owner as sole admin member
 *   - zero bundles
 *   - `about` null or empty
 *
 * Inverted from the prior denylist style. The previous version
 * enumerated `agents`/`skillDirs`/`models`/`identity`/
 * `connectorsAllowList`/`oauthOperatorApps` explicitly and would have
 * silently passed any new optional field added to `Workspace` later
 * (round-2 QA caught `allowHttpProxy` missing from that list). Adding
 * an unfamiliar field to the allowlist is now an explicit operator
 * decision.
 */
function findPopulatedWorkspaceField(
  ws: Workspace,
  ownerUserId: string,
): string | null {
  // 1. Reject any field outside the allowlist — covers `agents`,
  //    `skillDirs`, `models`, `identity`, `allowHttpProxy`,
  //    `connectorsAllowList`, `oauthOperatorApps`, and anything added
  //    to `Workspace` in the future.
  for (const key of Object.keys(ws)) {
    if (!ALLOWED_STUB_KEYS.has(key)) {
      return `unexpected field: ${key}`;
    }
  }

  // 2. Value-level checks on the allowlisted keys.
  if ((ws.bundles ?? []).length > 0) return `bundles (${ws.bundles.length})`;

  const members = ws.members ?? [];
  if (members.length !== 1) {
    return `members (${members.length} — expected exactly the owner as sole admin)`;
  }
  const sole = members[0];
  if (!sole || sole.userId !== ownerUserId || sole.role !== "admin") {
    return `members[0] (expected ${ownerUserId} as admin, got ${sole?.userId} as ${sole?.role})`;
  }

  if (typeof ws.about === "string" && ws.about.length > 0) {
    return "about (non-empty)";
  }
  if (ws.ownerUserId !== undefined && ws.ownerUserId !== ownerUserId) {
    return `ownerUserId (got ${ws.ownerUserId}, expected ${ownerUserId})`;
  }
  return null;
}

/**
 * Walk `conversationsDir` and rewrite every top-level conversation
 * JSONL whose metadata's `workspaceId` matches `oldId` to `newId`.
 * Returns the count of files that were (or would be, in dry-run)
 * rewritten. Used twice in main: the happy-path rename and the
 * partial-rename heal.
 */
async function rewriteConvRefs(
  conversationsDir: string,
  oldId: string,
  newId: string,
  dryRun: boolean,
): Promise<number> {
  if (!existsSync(conversationsDir)) return 0;
  let rewrites = 0;
  for (const fname of await readdir(conversationsDir)) {
    if (!fname.endsWith(".jsonl")) continue;
    const cpath = join(conversationsDir, fname);
    const meta = await readConversationMetadata(cpath);
    if (!meta || meta.workspaceId !== oldId) continue;
    if (dryRun) {
      rewrites++;
      continue;
    }
    if (await rewriteConversationWorkspaceId(cpath, oldId, newId)) {
      rewrites++;
    }
  }
  return rewrites;
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
  //
  // Three layers of "is this stub truly empty?" gate the `rm -rf`. Any
  // populated workspace.json field, any reference from a top-level
  // conversation, or any unexpected file under the canonical dir flips
  // to a hard-error — the script never auto-merges or silently
  // destroys real state. Operator must reconcile.
  if (existsSync(canonicalDir)) {
    const canonicalWsPath = join(canonicalDir, "workspace.json");

    if (existsSync(canonicalWsPath)) {
      const canonicalWs = JSON.parse(
        await readFile(canonicalWsPath, "utf-8"),
      ) as Workspace;

      const populatedField = findPopulatedWorkspaceField(canonicalWs, userId);
      if (populatedField) {
        return {
          error:
            `canonical stub ${canonicalId} workspace.json is populated ` +
            `(${populatedField}) — manual reconciliation required`,
        };
      }

      const refCount = await countConversationRefs(conversationsDir, canonicalId);
      if (refCount > 0) {
        return {
          error:
            `canonical stub ${canonicalId} is referenced by ${refCount} ` +
            "top-level conversation(s) — manual reconciliation required",
        };
      }
    }

    // Recursive content walk. Catches:
    //  - populated data/credentials/skills/files/ subdirs (anything
    //    beyond their `.gitkeep` sentinels)
    //  - legacy `conversations/` subdir from Stage-0 stubs
    //  - any other unanticipated file
    const extra = await findUnexpectedContent(canonicalDir);
    if (extra) {
      return {
        error:
          `canonical stub ${canonicalId} has unexpected content (${extra}) — ` +
          "manual reconciliation required",
      };
    }

    console.error(
      `[heal] ${userId}: ${dryRun ? "[dry-run] would " : ""}delete empty canonical stub ${canonicalId}`,
    );
    if (!dryRun) await rm(canonicalDir, { recursive: true, force: true });
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
  const rewrites = await rewriteConvRefs(
    conversationsDir,
    truncatedId,
    canonicalId,
    dryRun,
  );
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
    partialRenameHealed: 0,
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
        // No truncated workspace. Common path: this user was always at
        // the canonical id (Stage 0 lazy-create) — nothing to do.
        //
        // Less-common path: a previous heal crashed between
        // `rename(truncated, canonical)` and the workspace.json rewrite,
        // leaving the canonical dir on disk but its embedded `id` /
        // `isPersonal` / `ownerUserId` still pointing at the pre-rename
        // values. Detect and stamp on rerun — mirrors Stage 1's
        // `migrate-personal-workspaces.ts` partial-rename heal.
        //
        // Two safety gates before stamping — the canonical might be an
        // unrelated workspace that happens to share the id:
        //   - name must match `<displayName>'s Workspace` (the rename
        //     preserved name from the original truncated workspace)
        //   - user must be an admin member (claims ownership)
        // The empty-content gates that `healOne` applies to stubs do
        // NOT apply here — a partially-renamed canonical legitimately
        // carries the user's bundles, settings, and pre-PR-C extra
        // collaborators. We're stamping identity, not deleting.
        const canonicalWs = await wsStore.get(canonicalId);
        const needsStamp =
          canonicalWs !== null &&
          (canonicalWs.id !== canonicalId ||
            canonicalWs.isPersonal !== true ||
            canonicalWs.ownerUserId !== user.id);
        if (canonicalWs && needsStamp) {
          const expectedName = `${user.displayName}'s Workspace`;
          if (canonicalWs.name !== expectedName) {
            console.error(
              `[heal] ${user.id}: canonical ${canonicalId} exists with stale identity ` +
                `but name ${JSON.stringify(canonicalWs.name)} != expected ${JSON.stringify(expectedName)} — ` +
                "refuse to stamp (manual reconciliation required)",
            );
            stats.errors.push({
              ctx: user.id,
              message: `canonical ${canonicalId} has stale identity but unexpected name — operator must reconcile`,
            });
            continue;
          }
          if (!isAdminOf(canonicalWs, user.id)) {
            console.error(
              `[heal] ${user.id}: canonical ${canonicalId} exists with stale identity ` +
                `but ${user.id} is not an admin member — refuse to stamp ` +
                "(manual reconciliation required)",
            );
            stats.errors.push({
              ctx: user.id,
              message: `canonical ${canonicalId} has stale identity but ${user.id} is not an admin — operator must reconcile`,
            });
            continue;
          }

          console.error(
            `[heal] ${user.id}: ${args.dryRun ? "[dry-run] would " : ""}` +
              `stamp identity on partial-rename canonical ${canonicalId} ` +
              `(was id=${canonicalWs.id}, isPersonal=${canonicalWs.isPersonal}, ` +
              `ownerUserId=${canonicalWs.ownerUserId})`,
          );
          if (!args.dryRun) {
            const wsPath = join(workspacesDir, canonicalId, "workspace.json");
            const updated: Workspace = {
              ...canonicalWs,
              id: canonicalId,
              isPersonal: true,
              ownerUserId: user.id,
              about: canonicalWs.about ?? null,
              updatedAt: new Date().toISOString(),
            };
            await writeJsonAtomic(wsPath, updated);
          }
          const rewrites = await rewriteConvRefs(
            conversationsDir,
            truncatedId,
            canonicalId,
            args.dryRun,
          );
          console.error(
            `[heal] ${user.id}: ${args.dryRun ? "[dry-run] would " : ""}` +
              `rewrite workspaceId on ${rewrites} conversation(s) referencing truncated id`,
          );
          stats.partialRenameHealed++;
          continue;
        }
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
  console.error(`[heal]   partial-rename healed:         ${stats.partialRenameHealed}`);
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
