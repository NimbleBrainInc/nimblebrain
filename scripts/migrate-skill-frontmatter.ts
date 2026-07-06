#!/usr/bin/env bun
/**
 * One-time migration: legacy SKILL.md frontmatter → the canonical shape.
 *
 * The cutover to the canonical manifest schema (strict `validateFrontmatter`,
 * `metadata.nimblebrain.*`) means a skill still in the legacy flat shape
 * (`type` / `version` / top-level `priority` / `applies-to-tools` /
 * `requires-bundles` / `metadata.{triggers,keywords}`) now FAILS validation and
 * is silently skipped at load. This rewrites such files in place.
 *
 * Vendored core/builtin skills are already canonical (converted in the cutover).
 * The population this targets is TENANT skills on a deployed instance: the
 * `skills/`, `workspaces/<id>/skills/`, and `users/<id>/skills/` dirs under a
 * runtime workDir. Point it at that workDir (or any parent).
 *
 * Usage:
 *   bun run migrate:skill-frontmatter <dir> [<dir> ...]   # dry-run (default)
 *   bun run migrate:skill-frontmatter <dir> --write       # apply in place
 *
 * Safe by default: prints what WOULD change and exits non-zero if anything is
 * pending, so it doubles as a CI guard. `--write` performs the rewrite.
 *
 * The transform itself is pure and unit-tested in
 * `scripts/lib/migrate-skill-frontmatter.ts`; this wrapper only walks the tree.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { atomicWriteFile } from "../src/skills/writer.ts";
import { migrateSkillContent } from "./lib/migrate-skill-frontmatter.ts";

interface Outcome {
  path: string;
  status: "changed" | "unchanged" | "error";
  detail?: string;
}

function migrateDir(root: string, write: boolean): Outcome[] {
  const outcomes: Outcome[] = [];
  // All markdown under any `skills/` tree, excluding version snapshots and deps.
  const glob = new Glob("**/skills/**/*.md");
  for (const abs of glob.scanSync({ cwd: root, absolute: true })) {
    if (abs.includes("/_versions/") || abs.includes("/node_modules/")) continue;
    const rel = relative(root, abs);
    try {
      const raw = readFileSync(abs, "utf-8");
      const { content, changed, error } = migrateSkillContent(raw);
      if (error) {
        // Migrated output would fail the loader's validation (e.g. a legacy name
        // the strict pattern rejects) — surface it loudly instead of writing a
        // file the runtime then silently skips.
        outcomes.push({ path: rel, status: "error", detail: error });
        continue;
      }
      if (!changed) {
        outcomes.push({ path: rel, status: "unchanged" });
        continue;
      }
      if (write) atomicWriteFile(abs, content);
      outcomes.push({ path: rel, status: "changed" });
    } catch (err) {
      outcomes.push({
        path: rel,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/**
 * `.migration-lock` — a PID file at the work-dir root, held for the duration of a
 * `--write` run, per the platform migration convention (CHANGELOG / AGENTS.md):
 * concurrent writers refuse to start instead of racing the same SKILL.md files.
 * A stale lock (holder PID no longer alive) is reclaimed.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(root: string): string {
  const lockPath = join(root, ".migration-lock");
  if (existsSync(lockPath)) {
    const heldBy = Number(readFileSync(lockPath, "utf-8").trim());
    if (heldBy && pidAlive(heldBy)) {
      throw new Error(
        `.migration-lock at ${root} is held by PID ${heldBy} — another migration is running; refusing to start.`,
      );
    }
    // Stale lock (holder gone) — reclaim it.
  }
  writeFileSync(lockPath, String(process.pid), "utf-8");
  return lockPath;
}

function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort release; a stale lock is reclaimed on the next run.
  }
}

/** Parse CLI argv into the write flag and the root dirs (defaulting to cwd). */
function parseArgs(argv: string[]): { write: boolean; roots: string[] } {
  const write = argv.includes("--write");
  const roots = argv.filter((a) => !a.startsWith("--"));
  if (roots.length === 0) roots.push(process.cwd());
  return { write, roots };
}

/** Migrate every root, holding the write-lock only on the destructive path. */
function collectOutcomes(roots: string[], write: boolean): Outcome[] {
  const all: Outcome[] = [];
  for (const root of roots) {
    const resolved = resolve(root);
    // Lock only the destructive path; concurrent dry-runs are read-only and safe.
    const lock = write ? acquireLock(resolved) : null;
    try {
      all.push(...migrateDir(resolved, write));
    } finally {
      if (lock) releaseLock(lock);
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
  for (const o of changed) console.log(`  ${mark} ${verb}: ${o.path}`);
  for (const o of errors) console.error(`  × Failed: ${o.path} — ${o.detail}`);

  const state = write ? "migrated" : "pending";
  const canonical = all.length - changed.length - errors.length;
  console.log(
    `\n${all.length} skill file(s) scanned · ${changed.length} ${state} · ${canonical} already canonical · ${errors.length} error(s)`,
  );
}

/** Exit code: non-zero on any error, or on a dry-run with pending changes (CI gate). */
function exitCode(all: Outcome[], write: boolean): number {
  const errors = all.filter((o) => o.status === "error").length;
  const changed = all.filter((o) => o.status === "changed").length;
  if (errors > 0) return 1;
  if (!write && changed > 0) return 1;
  return 0;
}

function main(): void {
  const { write, roots } = parseArgs(process.argv.slice(2));
  const all = collectOutcomes(roots, write);
  report(all, write);
  const code = exitCode(all, write);
  if (code !== 0) process.exit(code);
}

main();
