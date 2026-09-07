#!/usr/bin/env bun
/**
 * One-time migration: a workspace's connector list moves to `connectors[]`.
 *
 * The runtime reads `connectors[]` and nothing else — there is no dual-read and
 * no boot-time rewrite of tenant state — so a `workspace.json` still on the old
 * key refuses to start, naming this script. Run it once against a deployed
 * instance's work dir before the upgrade.
 *
 * The population is every `workspaces/<wsId>/workspace.json` under a runtime
 * work dir. Point it at that work dir (or any parent of several).
 *
 * Usage:
 *   bun run migrate:workspace-connectors <dir> [<dir> ...]   # dry-run (default)
 *   bun run migrate:workspace-connectors <dir> --write       # apply in place
 *
 * Safe by default: prints what WOULD change and exits non-zero if anything is
 * pending, so it doubles as a pre-deploy check. `--write` performs the rewrite.
 * A file that already reads `connectors[]` is left untouched, so a second run
 * is a no-op rather than a second rewrite.
 *
 * The transform itself is pure and unit-tested in
 * `scripts/lib/migrate-workspace-connectors.ts`; this wrapper only walks the tree.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Glob } from "bun";
import { writeJsonAtomic } from "../src/util/atomic-json.ts";
import {
  migrateWorkspaceContent,
  type WorkspaceMigrationStatus,
} from "./lib/migrate-workspace-connectors.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

const MIGRATION_NAME = "workspace-connectors";

interface Outcome {
  path: string;
  status: WorkspaceMigrationStatus;
  detail?: string;
}

/** Migrate one workspace record, writing it only on the destructive path. */
async function migrateFile(abs: string, rel: string, write: boolean): Promise<Outcome> {
  try {
    const result = migrateWorkspaceContent(readFileSync(abs, "utf-8"));
    if (result.status !== "changed") {
      return { path: rel, status: result.status, detail: result.error };
    }
    // `writeJsonAtomic` takes the parsed value and re-serializes it the way the
    // workspace store writes — same indentation, same trailing newline, same
    // 0600 mode — so a migrated file is byte-identical to one the runtime would
    // have written itself.
    if (write) await writeJsonAtomic(abs, JSON.parse(result.content ?? "{}"));
    return { path: rel, status: "changed", detail: result.detail };
  } catch (err) {
    return {
      path: rel,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function migrateDir(root: string, write: boolean): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const glob = new Glob("**/workspaces/*/workspace.json");
  for (const abs of glob.scanSync({ cwd: root, absolute: true })) {
    if (abs.includes("/archived/") || abs.includes("/node_modules/")) continue;
    outcomes.push(await migrateFile(abs, relative(root, abs), write));
  }
  return outcomes;
}

/** Migrate every root, holding the work-dir lock only on the destructive path. */
async function collectOutcomes(roots: string[], write: boolean): Promise<Outcome[]> {
  const all: Outcome[] = [];
  for (const root of roots) {
    const resolved = resolve(root);
    // Lock only the destructive path; concurrent dry-runs are read-only and safe.
    const lock = write ? acquireMigrationLock(resolved, MIGRATION_NAME) : null;
    try {
      all.push(...(await migrateDir(resolved, write)));
    } finally {
      lock?.release();
    }
  }
  return all;
}

/** Print the per-file lines and the summary tally for a completed run. */
function report(all: Outcome[], write: boolean): void {
  const changed = all.filter((o) => o.status === "changed");
  const errors = all.filter((o) => o.status === "error");

  const verb = write ? "Migrated" : "Would migrate";
  const mark = write ? "✓" : "·";
  for (const o of changed) console.log(`  ${mark} ${verb}: ${o.path} — ${o.detail}`);
  for (const o of errors) console.error(`  × Failed: ${o.path} — ${o.detail}`);

  const state = write ? "migrated" : "pending";
  const done = all.length - changed.length - errors.length;
  console.log(
    `\n${all.length} workspace record(s) scanned · ${changed.length} ${state} · ${done} already on connectors[] · ${errors.length} error(s)`,
  );
}

/** Parse CLI argv into the write flag and the root dirs (defaulting to cwd). */
function parseArgs(argv: string[]): { write: boolean; roots: string[] } {
  const write = argv.includes("--write");
  const roots = argv.filter((a) => !a.startsWith("--"));
  if (roots.length === 0) roots.push(process.cwd());
  return { write, roots };
}

/** Exit code: non-zero on any error, or on a dry-run with pending changes. */
function exitCode(all: Outcome[], write: boolean): number {
  if (all.some((o) => o.status === "error")) return 1;
  if (!write && all.some((o) => o.status === "changed")) return 1;
  return 0;
}

async function main(): Promise<void> {
  const { write, roots } = parseArgs(process.argv.slice(2));
  const all = await collectOutcomes(roots, write);
  report(all, write);
  const code = exitCode(all, write);
  if (code !== 0) process.exit(code);
}

await main();
