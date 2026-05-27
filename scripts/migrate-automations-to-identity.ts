#!/usr/bin/env bun
/**
 * Phase C migration: move every automation into the owner-partitioned identity
 * store `{workDir}/users/{ownerId}/automations/` (`automations.json` + `runs/`).
 *
 * Automations become identity-owned (see ACCESS_MODEL / IDENTITY_APP_SURFACE).
 * They are partitioned per owner — not flat top-level like conversations —
 * because automation ids are kebab-case (derived from the name) and collide
 * across owners; partitioning makes ownership structural and ids unique per
 * owner. A scheduled run fires as its owner, focused on its provenance
 * workspace (`Automation.workspaceId`).
 *
 * Sources merged (the pre-Phase-C mess this fixes):
 *   - Instance-level `{workDir}/automations/automations.json` (the scheduler's
 *     boot store).
 *   - Per-workspace `{workDir}/workspaces/{wsId}/automations/automations.json`
 *     (created by the buggy workspace-scoped tool override).
 *
 * Owner resolution (shared with the files migration — `resolveWorkspaceOwner`):
 *   - An automation's existing `ownerId` wins when present.
 *   - Else, for a workspace-scoped source, resolve from the workspace
 *     (personal → `ownerUserId`; team → earliest admin).
 *   - An instance-level automation with no `ownerId`, or an unresolvable
 *     workspace, is **[FATAL]** — operator must assign an owner.
 *
 * The owning user is stamped (`ownerId`) and the source workspace is preserved
 * as the focus/provenance (`workspaceId`). Same `(ownerId, id)` from two
 * sources is a **[FATAL]** collision — we won't merge two automations' run
 * histories under one key.
 *
 * Clean one-way move, idempotent on the destination: an automation already
 * present in the owner's store is left untouched; run files copy then the
 * source is removed; emptied source `automations/` dirs are removed entirely.
 *
 * Usage:
 *     bun run scripts/migrate-automations-to-identity.ts [--work-dir <path>] [--dry-run]
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireMigrationLock } from "./lib/migration-lock.ts";
import { resolveWorkspaceOwner } from "./lib/resolve-workspace-owner.ts";

/** Minimal view of an on-disk automation — opaque except the fields we route
 * on. Inlined so the script survives type changes in the bundle. */
type Automation = Record<string, unknown> & {
  id: string;
  ownerId?: string;
  workspaceId?: string;
};

interface AutomationsFile {
  version: number;
  updatedAtMs: number;
  automations: Automation[];
}

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface Source {
  /** Absolute path to the `automations/` dir. */
  dir: string;
  /** Source workspace id, or null for the instance-level store. */
  wsId: string | null;
  /** Human label for logs. */
  label: string;
}

interface Candidate {
  source: Source;
  ownerId: string;
  automation: Automation;
}

interface Stats {
  found: number;
  migrated: number;
  alreadyMigrated: number;
  runsMoved: number;
  dirsRemoved: number;
  errors: { ctx: string; message: string }[];
}

const AUTOMATIONS_FILE = "automations.json";
const RUNS_DIR = "runs";

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
      console.error(`[migrate-automations] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!workDir) {
    console.error("[migrate-automations] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, dryRun };
}

function printHelp(): void {
  console.log(`
migrate-automations-to-identity — Phase C of the identity-app surface

Merges instance-level and per-workspace automation stores into the
owner-partitioned identity store users/{ownerId}/automations/, stamping owner
and provenance workspace. Owner is the automation's ownerId, or the personal-
workspace user / a team workspace's earliest admin.

Usage:
  bun run scripts/migrate-automations-to-identity.ts [options]

Options:
  --work-dir <path>   Override the work directory. Defaults to
                      $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           Report the planned moves without writing.
  -h, --help          This message.

Run during a maintenance window with the platform stopped. Idempotent.
Unresolvable ownership and same-owner id collisions exit non-zero with
[FATAL]; operators decide.
`);
}

async function readAutomationsFile(path: string): Promise<Automation[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as AutomationsFile;
    return Array.isArray(parsed.automations) ? parsed.automations : [];
  } catch {
    return [];
  }
}

async function writeAutomationsFile(dir: string, automations: Automation[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file: AutomationsFile = { version: 1, updatedAtMs: Date.now(), automations };
  const path = join(dir, AUTOMATIONS_FILE);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
  await rename(tmp, path);
}

/** Discover every source automations store: instance-level + per-workspace. */
async function discoverSources(workDir: string): Promise<Source[]> {
  const sources: Source[] = [];
  const instanceDir = join(workDir, "automations");
  if (existsSync(join(instanceDir, AUTOMATIONS_FILE))) {
    sources.push({ dir: instanceDir, wsId: null, label: "(instance)" });
  }
  const workspacesDir = join(workDir, "workspaces");
  if (existsSync(workspacesDir)) {
    for (const ws of await readdir(workspacesDir, { withFileTypes: true })) {
      if (!ws.isDirectory() || ws.name.startsWith(".")) continue;
      const dir = join(workspacesDir, ws.name, "automations");
      if (existsSync(join(dir, AUTOMATIONS_FILE))) {
        sources.push({ dir, wsId: ws.name, label: ws.name });
      }
    }
  }
  return sources;
}

async function plan(
  workDir: string,
): Promise<{ candidates: Candidate[]; unresolvable: string[]; collisions: Map<string, string[]>; sources: Source[] }> {
  const sources = await discoverSources(workDir);
  const workspacesDir = join(workDir, "workspaces");
  const ownerCache = new Map<string, string | null>();
  const candidates: Candidate[] = [];
  const unresolvable: string[] = [];
  // (ownerId/id) -> source labels, for collision detection.
  const seen = new Map<string, string[]>();

  for (const source of sources) {
    const automations = await readAutomationsFile(join(source.dir, AUTOMATIONS_FILE));
    for (const automation of automations) {
      if (typeof automation.id !== "string" || automation.id.length === 0) continue;
      let owner = typeof automation.ownerId === "string" ? automation.ownerId : null;
      if (!owner && source.wsId) {
        if (!ownerCache.has(source.wsId)) {
          ownerCache.set(source.wsId, await resolveWorkspaceOwner(workspacesDir, source.wsId));
        }
        owner = ownerCache.get(source.wsId) ?? null;
      }
      if (!owner) {
        unresolvable.push(`${source.label}/${automation.id}`);
        continue;
      }
      const key = `${owner}/${automation.id}`;
      seen.set(key, [...(seen.get(key) ?? []), source.label]);
      candidates.push({ source, ownerId: owner, automation });
    }
  }

  const collisions = new Map<string, string[]>();
  for (const [key, labels] of seen) {
    if (labels.length > 1) collisions.set(key, labels);
  }
  return { candidates, unresolvable, collisions, sources };
}

async function moveRunFile(
  sourceDir: string,
  destDir: string,
  id: string,
  dryRun: boolean,
): Promise<boolean> {
  const src = join(sourceDir, RUNS_DIR, `${id}.jsonl`);
  if (!existsSync(src)) return false;
  const dest = join(destDir, RUNS_DIR, `${id}.jsonl`);
  if (existsSync(dest)) return false; // already moved (idempotent)
  if (dryRun) return true;
  await mkdir(join(destDir, RUNS_DIR), { recursive: true });
  await copyFile(src, dest);
  await rm(src, { force: true });
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`[migrate-automations] workDir=${args.workDir}${args.dryRun ? " (dry-run)" : ""}`);
  if (!existsSync(args.workDir)) {
    console.error(`[migrate-automations] workDir does not exist: ${args.workDir}`);
    process.exit(1);
  }

  acquireMigrationLock(args.workDir, "migrate-automations-to-identity");

  const { candidates, unresolvable, collisions, sources } = await plan(args.workDir);

  // Phase 1 — fatal conditions.
  if (collisions.size > 0) {
    console.error(
      `[migrate-automations] [FATAL] same (owner, automation id) in multiple sources (${collisions.size}):`,
    );
    for (const [key, labels] of collisions) {
      console.error(`[migrate-automations]   ${key}: ${labels.join(", ")}`);
    }
    console.error(`[migrate-automations] [FATAL] won't merge two automations' run histories. Refusing.`);
    process.exit(2);
  }
  if (unresolvable.length > 0) {
    console.error(
      `[migrate-automations] [FATAL] ${unresolvable.length} automation(s) with no resolvable owner ` +
        `(instance-level with no ownerId, or a workspace with no admin):`,
    );
    for (const ref of unresolvable) console.error(`[migrate-automations]   ${ref}`);
    console.error(`[migrate-automations] [FATAL] operator must assign an owner. Refusing to guess.`);
    process.exit(2);
  }

  const stats: Stats = {
    found: candidates.length,
    migrated: 0,
    alreadyMigrated: 0,
    runsMoved: 0,
    dirsRemoved: 0,
    errors: [],
  };

  // Build each owner's destination map, seeded from any existing store, then
  // write once at the end. Tracks whether a map changed to avoid rewriting
  // untouched owner stores.
  const destDirOf = (ownerId: string) => join(args.workDir, "users", ownerId, "automations");
  const destMaps = new Map<string, { map: Map<string, Automation>; changed: boolean }>();
  async function destFor(ownerId: string) {
    const dir = destDirOf(ownerId);
    const cached = destMaps.get(dir);
    if (cached) return cached;
    const map = new Map<string, Automation>();
    for (const a of await readAutomationsFile(join(dir, AUTOMATIONS_FILE))) map.set(a.id, a);
    const entry = { map, changed: false };
    destMaps.set(dir, entry);
    return entry;
  }

  for (const cand of candidates) {
    const ctx = `${cand.source.label}/${cand.automation.id}`;
    try {
      const destDir = destDirOf(cand.ownerId);
      const dest = await destFor(cand.ownerId);

      if (dest.map.has(cand.automation.id)) {
        // Already in the owner's store (prior run). Still finish the run-file move.
        if (await moveRunFile(cand.source.dir, destDir, cand.automation.id, args.dryRun)) {
          stats.runsMoved++;
        }
        stats.alreadyMigrated++;
        continue;
      }

      if (args.dryRun) {
        console.error(
          `[migrate-automations]   [dry-run] would move ${ctx} → users/${cand.ownerId}/automations` +
            ` (ownerId=${cand.ownerId}, workspaceId=${cand.source.wsId ?? cand.automation.workspaceId ?? "(none)"})`,
        );
        stats.migrated++;
        if (await moveRunFile(cand.source.dir, destDir, cand.automation.id, true)) stats.runsMoved++;
        continue;
      }

      // Stamp owner + provenance/focus workspace. A workspace-scoped source
      // contributes its wsId; an instance-level automation keeps its own.
      const stamped: Automation = {
        ...cand.automation,
        ownerId: cand.ownerId,
        ...(cand.source.wsId ? { workspaceId: cand.source.wsId } : {}),
      };
      dest.map.set(stamped.id, stamped);
      dest.changed = true;
      if (await moveRunFile(cand.source.dir, destDir, cand.automation.id, false)) stats.runsMoved++;
      stats.migrated++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrate-automations] ERROR ${ctx}: ${message}`);
      stats.errors.push({ ctx, message });
    }
  }

  // Commit each changed owner store.
  if (!args.dryRun && stats.errors.length === 0) {
    for (const [dir, { map, changed }] of destMaps) {
      if (changed) await writeAutomationsFile(dir, Array.from(map.values()));
    }
    // Clean one-way move: remove every source automations dir we drained.
    // After migration the per-workspace + instance-level stores are vestigial
    // (the scheduler reads users/*/automations/). A dir is removed only if its
    // automations.json now lists nothing it still owns on disk.
    for (const source of sources) {
      const remaining = await readAutomationsFile(join(source.dir, AUTOMATIONS_FILE));
      const stillHere = remaining.some((a) => existsSync(join(source.dir, RUNS_DIR, `${a.id}.jsonl`)));
      if (stillHere) {
        console.error(`[migrate-automations]   left ${source.dir} in place (run history remains)`);
        continue;
      }
      await rm(source.dir, { recursive: true, force: true });
      stats.dirsRemoved++;
    }
  }

  console.error("");
  console.error(`[migrate-automations] summary${args.dryRun ? " (dry-run)" : ""}:`);
  console.error(`[migrate-automations]   automations found:   ${stats.found}`);
  console.error(`[migrate-automations]   migrated:            ${stats.migrated}`);
  console.error(`[migrate-automations]   already migrated:    ${stats.alreadyMigrated}`);
  console.error(`[migrate-automations]   run files moved:     ${stats.runsMoved}`);
  console.error(`[migrate-automations]   source dirs removed: ${stats.dirsRemoved}`);
  console.error(`[migrate-automations]   collisions:          0`);
  console.error(`[migrate-automations]   unresolvable owners: 0`);
  console.error(`[migrate-automations]   errors:              ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors) console.error(`[migrate-automations]     [error] ${e.ctx}: ${e.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
