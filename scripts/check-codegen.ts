#!/usr/bin/env bun
/**
 * Verifies that `web/src/_generated/` matches what the generator just
 * produced — including a file the generator emitted that was never
 * added to git.
 *
 * Why `git status --porcelain` and not `git diff`: a diff compares
 * tracked paths only. Adding a schema source under
 * `src/tools/platform/schemas/` makes the generator emit a matching
 * `.d.ts` that no diff can see, so the guard passes with the artifact
 * missing and it lands later in whatever unrelated change next runs
 * codegen. `--porcelain` (v1) is git's documented stable-for-scripts
 * format, and `-uall` names each untracked file instead of collapsing
 * a directory to `dir/`.
 *
 * Why this is a script and not a shell one-liner: a `git status | grep`
 * pipeline reports grep's exit status, not git's. A git that cannot run
 * at all — no repository, unreadable index — produces empty output, no
 * match, and a passing check. A guard that reports "clean" when it
 * cannot see is the same defect as one that cannot see untracked files,
 * so `verdictFor` fails closed on every path that is not an explicit
 * clean answer from a git that succeeded.
 *
 * Run: `bun run check:codegen` (regenerates first — see package.json).
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..");

/** The generated tree this guard watches, as a pathspec from the repo root. */
export const GENERATED_DIR = "web/src/_generated/";

export interface DriftEntry {
  /** Two-character porcelain-v1 status code, e.g. `??`, ` M`, `D `. */
  code: string;
  /** Path as git reported it, quoted by git when it holds special characters. */
  path: string;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: "git-failed"; detail: string }
  | { ok: false; reason: "drift"; entries: DriftEntry[] };

/** Shape of the git call's result, narrowed to what the verdict depends on. */
export interface GitResult {
  error?: Error | undefined;
  status: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Splits `git status --porcelain` output into one entry per reported path.
 *
 * Porcelain v1 lines are `XY<space><path>`, so the code is the first two
 * characters and the path begins at index 3. A rename reports
 * `orig -> new`; the tail is kept verbatim, since naming the path is all
 * this guard does with it.
 */
export function parseStatus(output: string): DriftEntry[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

/**
 * Plain-language reason for a porcelain status code.
 *
 * `??` is named distinctly rather than folded into "changed" because it
 * is the case a diff over tracked paths cannot report at all, and the
 * fix a reader reaches for differs: the file needs adding, not
 * regenerating.
 */
export function describeCode(code: string): string {
  if (code === "??") return "generated but never added to git";
  if (code.includes("D")) return "missing from the working tree";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added but not committed";
  if (code.includes("M")) return "differs from the committed copy";
  return "reported as changed";
}

/**
 * Decides the guard's verdict from the git call's raw result.
 *
 * `ok: true` requires a git that exited 0 AND reported nothing. Anything
 * else — a git that failed to spawn, a non-zero exit, a signal, or any
 * reported path — is a failure. Pinning that here is the point of the
 * split: it is the property a shell pipeline silently gives up.
 */
export function verdictFor(result: GitResult): Verdict {
  if (result.error) {
    return { ok: false, reason: "git-failed", detail: result.error.message };
  }
  if (result.status !== 0) {
    const how =
      result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
    const stderr = result.stderr.trim();
    return {
      ok: false,
      reason: "git-failed",
      detail: stderr ? `git status ${how}\n${stderr}` : `git status ${how}`,
    };
  }
  const entries = parseStatus(result.stdout);
  return entries.length === 0 ? { ok: true } : { ok: false, reason: "drift", entries };
}

function main(): void {
  const result = spawnSync("git", ["status", "--porcelain", "-uall", "--", GENERATED_DIR], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const verdict = verdictFor(result);

  if (verdict.ok) {
    console.log(`✓ ${GENERATED_DIR} matches the generator's output`);
    return;
  }

  if (verdict.reason === "git-failed") {
    console.error(`✗ could not read the state of ${GENERATED_DIR}:`);
    console.error(verdict.detail);
    process.exit(1);
  }

  console.error(`✗ ${GENERATED_DIR} does not match the generator's output:\n`);
  for (const { code, path } of verdict.entries) {
    console.error(`  ${path} — ${describeCode(code)}`);
  }
  console.error("\nRun `bun run codegen` and commit the result.");
  process.exit(1);
}

// Gate the side effect on direct invocation so unit tests can import the
// predicates above without spawning git or exiting the process.
if (import.meta.main) {
  main();
}
