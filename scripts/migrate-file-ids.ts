#!/usr/bin/env bun
/**
 * One-time migration: stored files with a retired `fl_<base36>_<8 hex>` id get a
 * current `fl_<24 hex>` id, and every reference the runtime reads is rewritten.
 *
 * The runtime serves only the current id form, so a file still on a legacy id
 * is unreachable until this has run. Run it once against a deployed instance's
 * work dir (the runtime's `NB_WORK_DIR`), with that instance's runtime stopped
 * (scaled to 0) for `--apply`: the runtime appends to and rewrites conversation
 * files, and a write racing the rewrite would be lost or would restore an old id.
 *
 * Usage:
 *   bun run migrate:file-ids <workDir>            # dry-run (default)
 *   bun run migrate:file-ids <workDir> --dry-run  # same
 *   bun run migrate:file-ids <workDir> --apply    # rename and rewrite in place
 *
 * The dry-run prints counts and an anonymised old → new plan, and exits
 * non-zero while anything is pending. A dry-run that prints "Nothing to do" and
 * exits 0 is the check that the instance is ready for a runtime that serves only
 * the current id form.
 * `--apply` writes `<workDir>/.migrations/file-ids/mapping.json` (the full
 * old → new audit record) first, backs up each file before rewriting it under
 * `.migrations/file-ids/backups/<run>/`, then rewrites references and renames
 * blobs. A second run is a no-op. `logs/` is history and is never rewritten.
 *
 * What is read and written is described, and unit-tested, in
 * `scripts/lib/migrate-file-ids.ts`; this wrapper parses flags and reports.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyFileIdMigration,
  type FileIdPlan,
  planFileIdMigration,
} from "./lib/migrate-file-ids.ts";

/** Replace the parts of a path that identify a tenant's workspace, owner, or conversation. */
function anonymisePath(rel: string): string {
  const parts = rel.split("/");
  if (parts[0] === "workspaces" && parts[1]) parts[1] = "*";
  if (parts[0] === "workspaces" && parts[2] === "files" && parts[3]) parts[3] = "*";
  if (parts[0] === "workspaces" && parts[2] === "conversations") {
    return [...parts.slice(0, 3), "…"].join("/");
  }
  return parts.join("/");
}

/** Mask workspace, owner, and file ids in free text (error messages carry paths). */
function anonymiseText(text: string): string {
  return text
    .replace(/workspaces\/[^/\s]+/g, "workspaces/*")
    .replace(/files\/[^/\s]+/g, "files/*")
    .replace(/fl_[a-z0-9]+_[a-f0-9]{8}|fl_[a-f0-9]{24}/g, "fl_*");
}

function printPlan(plan: FileIdPlan): void {
  const entries = Object.entries(plan.mapping);
  const renamesByOld = new Map<string, { blob: number; sidecar: number }>();
  for (const r of plan.renames) {
    const c = renamesByOld.get(r.oldId) ?? { blob: 0, sidecar: 0 };
    c[r.kind]++;
    renamesByOld.set(r.oldId, c);
  }

  console.log("Plan (ids anonymised; the full mapping is written on --apply):");
  entries.forEach(([old, rec], i) => {
    const c = renamesByOld.get(old) ?? { blob: 0, sidecar: 0 };
    const pending = c.blob + c.sidecar > 0;
    const state = plan.minted.includes(old) ? "new" : pending ? "resumed" : "done";
    const where = rec.partitions.map(anonymisePath).join(" + ");
    console.log(
      `  #${i + 1}  ${where}  fl_<base36>_<8hex> → fl_<24hex>` +
        `  blob=${c.blob} sidecar=${c.sidecar} (${state})`,
    );
  });

  const byKind = {
    registry: { files: 0, refs: 0 },
    conversation: { files: 0, refs: 0 },
    other: { files: 0, refs: 0 },
  };
  for (const t of plan.rewrites) {
    byKind[t.kind].files++;
    byKind[t.kind].refs += t.refs;
  }
  console.log("\nReferences to rewrite:");
  for (const [kind, { files, refs }] of Object.entries(byKind)) {
    console.log(`  ${kind.padEnd(12)} ${files} file(s), ${refs} reference(s)`);
  }
  const otherPaths = new Map<string, number>();
  for (const t of plan.rewrites.filter((x) => x.kind === "other")) {
    const p = anonymisePath(t.path);
    otherPaths.set(p, (otherPaths.get(p) ?? 0) + 1);
  }
  for (const [p, n] of otherPaths) console.log(`    other: ${p} ×${n}`);

  console.log("\nLeft alone (legacy-shaped ids, counted only):");
  console.log(`  logs/                 ${plan.skipped.logs} file(s)`);
  console.log(`  archived/             ${plan.skipped.archived} file(s)`);
  console.log(`  users/*/files/        ${plan.skipped.users} file(s) (no runtime reader)`);
  console.log(`  file contents         ${plan.skipped.fileContents} blob/sidecar(s) (user data)`);
  console.log(`  unowned references    ${plan.orphanRefs} (no partition holds the id)`);

  const shared = entries.filter(([, rec]) => rec.partitions.length > 1).length;
  const partitions = new Set(entries.flatMap(([, rec]) => rec.partitions)).size;
  console.log(
    `\n${partitions} owner partition(s) · ${shared} id(s) held by more than one owner (each copy takes the same new id)`,
  );
  for (const e of plan.errors) console.error(`  × ${anonymiseText(e)}`);
}

function parseArgs(argv: string[]): { apply: boolean; workDir: string } {
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) {
    throw new Error("pass --dry-run or --apply, not both");
  }
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--apply" && a !== "--dry-run");
  if (unknown.length > 0) throw new Error(`unknown flag(s): ${unknown.join(", ")}`);
  const dirs = argv.filter((a) => !a.startsWith("--"));
  if (dirs.length > 1) throw new Error("pass one work dir");
  return { apply, workDir: resolve(dirs[0] ?? process.cwd()) };
}

function main(): void {
  const { apply, workDir } = parseArgs(process.argv.slice(2));
  if (!existsSync(join(workDir, "workspaces"))) {
    console.error(
      `No workspaces/ under ${workDir}. Point this at a runtime work dir (the runtime's NB_WORK_DIR).`,
    );
    process.exit(1);
  }

  const plan = planFileIdMigration(workDir);
  const ids = Object.keys(plan.mapping).length;
  const pending = plan.minted.length + plan.renames.length + plan.rewrites.length;

  printPlan(plan);
  console.log(
    `\n${ids} legacy file id(s) · ${plan.renames.length} rename(s) · ` +
      `${plan.rewrites.length} file(s) to rewrite · ${plan.errors.length} error(s)`,
  );
  if (plan.errors.length > 0) process.exit(1);

  if (!apply) {
    console.log(pending > 0 ? "Dry run: nothing written. Re-run with --apply." : "Nothing to do.");
    if (pending > 0) process.exit(1);
    return;
  }
  if (pending === 0) {
    console.log("Nothing to do.");
    return;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const result = applyFileIdMigration(workDir, plan, runId);
  console.log(
    `Applied: ${result.rewritten} file(s) rewritten (${result.refs} reference(s)), ` +
      `${result.renamed} rename(s). Mapping: .migrations/file-ids/mapping.json · ` +
      `backups: ${result.backupDir}`,
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
