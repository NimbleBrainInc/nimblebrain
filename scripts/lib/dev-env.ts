/**
 * `.env` discovery + merge for `dev:worktree`.
 *
 * The user expectation: "I have an `ANTHROPIC_API_KEY` in my main
 * repo's `.env`; `bun run dev:worktree` should pick it up." Without
 * this, the spawned API child runs with `cwd: <worktree>` and Bun's
 * built-in `.env` loader looks there, finds nothing (`.env` is
 * gitignored so worktrees don't share it), and the runtime errors at
 * the first model call.
 *
 * Discovery order — first hit wins:
 *  1. `<worktree>/.env` — explicit per-worktree override.
 *  2. `<main-repo>/.env` — discovered via `git rev-parse
 *     --git-common-dir`. For the main checkout this equals (1) and
 *     the worktree check finds it. For a linked worktree this is one
 *     level up from the shared `.git` dir.
 *
 * Merge semantics: shell env wins. We only set keys not already
 * present in `process.env`. That way an operator with a different
 * `ANTHROPIC_API_KEY` exported in their shell can still override the
 * file-on-disk value, and `direnv` / `mise` workflows continue to
 * work unchanged.
 *
 * Silent when no `.env` is found — the current "set in your shell"
 * contract still works, the auto-load is purely additive.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EnvFileLoadResult {
  /** Absolute path of the `.env` we loaded, or null if none found. */
  path: string | null;
  /** Variables we set on `process.env`. Excludes pre-existing keys (shell wins). */
  applied: string[];
  /** Variables we skipped because the shell already exported them. */
  skipped: string[];
}

/**
 * Find the `.env` to load for a given worktree root. Returns the
 * first existing path in the discovery order, or `null`.
 *
 * `mainRepoRoot` is computed via `git rev-parse --git-common-dir` and
 * walking one level up. The `--git-common-dir` of a worktree is the
 * shared `.git/` of the main checkout; its parent is the main repo
 * root. We pull it via `execFileSync` (sync is fine — this runs
 * exactly once at process start).
 */
export function findDotenvFile(worktreeRoot: string): string | null {
  const local = join(worktreeRoot, ".env");
  if (existsSync(local)) return local;

  const mainRoot = mainRepoRootFor(worktreeRoot);
  if (!mainRoot || mainRoot === worktreeRoot) return null;

  const main = join(mainRoot, ".env");
  if (existsSync(main)) return main;
  return null;
}

/**
 * Resolve the main repo's working tree given the absolute path of a
 * worktree. Returns `null` when not in a git checkout (e.g. tarball
 * extract).
 */
export function mainRepoRootFor(worktreeRoot: string): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktreeRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commonDir) return null;
    // `--git-common-dir` can be relative ("`.git`") for the main
    // checkout — resolve it against cwd.
    const abs = commonDir.startsWith("/") ? commonDir : join(worktreeRoot, commonDir);
    return dirname(abs);
  } catch {
    return null;
  }
}

/**
 * Parse `.env` content into a key → value map. Designed to match
 * Bun's built-in `.env` loader behavior where it matters for
 * operators — diverging from Bun was the bug class the PR review
 * round flagged. Specifically:
 *
 *  - `KEY=VALUE`, blank lines and `#` lines skipped.
 *  - A leading `export ` on the key is stripped (so an operator can
 *    keep a `.env` that's also `source`-able from a shell). Without
 *    this, `export FOO=bar` parses with key `"export FOO"` and the
 *    intended var is silently never set.
 *  - For UNQUOTED values, a trailing ` # comment` is stripped. For
 *    QUOTED values (single or double), the value is preserved
 *    verbatim — operators with `#` inside a URL fragment, an
 *    anchor, or a password must wrap the value in quotes (matches
 *    Bun + standard `.env` tooling).
 *  - Single or double wrapping quotes on the value are stripped.
 *  - No `${VAR}` interpolation. Keep this dumb; if an operator wants
 *    interpolation they're already using `direnv`.
 *
 * Exported standalone so the unit test can exercise it without an
 * fs round-trip.
 */
export function parseDotenv(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no `=` or starts with `=` — skip
    let key = line.slice(0, eq).trim();
    // Strip a leading `export ` so source-able `.env` files work.
    // Matches Bun's loader.
    key = key.replace(/^export\s+/, "");
    // A key that still contains whitespace after the export strip is
    // malformed (e.g. accidental `FOO BAR=baz`); skip rather than
    // store a never-fetchable variable.
    if (/\s/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      // Strip trailing ` # comment` from unquoted values to match Bun.
      // The boundary is `whitespace + #` so we don't truncate values
      // that legitimately contain `#` mid-token (e.g. a base64 chunk
      // with no surrounding whitespace).
      const inlineComment = value.search(/\s+#/);
      if (inlineComment !== -1) {
        value = value.slice(0, inlineComment).trimEnd();
      }
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Load `.env` (if any) into `process.env`. Shell-exported keys win
 * over file values. Returns a structured result so the caller can
 * log which file was used and what was applied (or just discard it).
 */
export function loadDotenvIntoProcess(worktreeRoot: string): EnvFileLoadResult {
  const path = findDotenvFile(worktreeRoot);
  if (!path) return { path: null, applied: [], skipped: [] };
  const content = readFileSync(path, "utf-8");
  const parsed = parseDotenv(content);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [k, v] of parsed) {
    if (process.env[k] !== undefined) {
      skipped.push(k);
      continue;
    }
    process.env[k] = v;
    applied.push(k);
  }
  return { path, applied, skipped };
}
