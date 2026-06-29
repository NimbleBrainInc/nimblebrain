#!/usr/bin/env bun
/**
 * Lint: workspace-scoped on-disk paths must flow through `WorkspaceContext`.
 *
 * The cross-workspace refactor (Stage 0)
 * moves every `{workDir}/workspaces/{wsId}/...` derivation into a single
 * typed handle (`src/workspace/context.ts`). After Stage 0, any new
 * occurrence of the legacy free-form pattern is a regression — it
 * reintroduces a place where a caller could mistype `wsId`, skip
 * validation, or escape the workspace tree via path traversal.
 *
 * What this script flags: any call to `join(...)` whose argument list
 * matches the literal sequence `<anything>, "workspaces", <wsId>, ...`
 * — i.e. building a path under a specific workspace by hand rather than
 * via `ctx.getDataPath(...)`.
 *
 * What it allows:
 *   - `join(workDir, "workspaces")` (no wsId) — the parent directory
 *     itself, which is correct in scope-classification code.
 *   - Sites inside the implementation files that DEFINE the layout
 *     (`src/workspace/context.ts`, `src/workspace/workspace-store.ts`,
 *     `src/config/workspace-credentials.ts`, and
 *     `src/conversation/paths.ts` for the room-owned
 *     `workspaces/<wsId>/conversations/...` subtree) — those are the
 *     source of truth and the lint shouldn't fight itself.
 *   - A `// lint-ok:workspace-path` marker on the line immediately
 *     above the call, for the rare future case where the typed handle
 *     genuinely doesn't apply.
 *
 * Scope: only `src/**\/*.ts`. Tests and bundles are out of scope
 * (tests deliberately exercise the legacy shims; bundles are
 * subprocesses that don't share the host's path layout).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:workspace-path";

// Files that legitimately define the workspace path layout. The lint
// would otherwise flag the definitions it exists to protect.
const ALLOWED_FILES = new Set(
  [
    "workspace/context.ts",
    "workspace/workspace-store.ts",
    "config/workspace-credentials.ts",
    // Defines the `workspaces/<wsId>/conversations/...` room-owned conversation
    // layout — the one sanctioned site that hand-builds that subtree.
    "conversation/paths.ts",
    // Defines the `workspaces/<wsId>/files/...` workspace-owned file layout —
    // the one sanctioned site that hand-builds that subtree (`workspaceFilesDir`).
    "files/paths.ts",
  ].map((f) => f.split("/").join(sep)),
);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

/**
 * Returns true iff `node` is a call to `join(...)` whose second
 * argument is the string literal "workspaces" AND a third argument
 * exists (the workspace id). Matches both `join("workspaces", ...)`
 * shapes and the more common `join(workDir, "workspaces", wsId, ...)`.
 *
 * We accept any callee named `join` (whether `join`, `path.join`, or
 * `node:path`'s `join`) — the lint is conservative; the pattern is
 * specific enough that false positives are unlikely.
 */
function isWorkspaceJoinWithWsId(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (calleeName !== "join") return false;

  // We need at least one "workspaces" string literal followed by another arg
  // (the wsId positional). Scan args looking for that adjacency.
  const args = node.arguments;
  for (let i = 0; i < args.length - 1; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
      arg.text === "workspaces"
    ) {
      // The next arg is treated as the wsId placeholder. It must NOT be
      // a string literal "workspaces" or empty (which would be parent-
      // dir-with-extra-noise rather than a wsId). The legitimate
      // pattern `join(workDir, "workspaces")` exits the loop without
      // matching because there's no next arg after position i.
      const next = args[i + 1];
      if (!next) return false;
      // Allow the pattern `join(workDir, "workspaces", someConstStringLikeAnotherFolder)`
      // ONLY when the next arg is itself a static folder name that we know
      // isn't a workspace id — but in practice this never appears. Be
      // conservative: any positional after "workspaces" trips the lint.
      return true;
    }
  }
  return false;
}

function hasAllowMarker(node: ts.Node, sourceFile: ts.SourceFile, src: string): boolean {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  if (line === 0) return false;
  const lines = src.split("\n");
  for (let i = line - 1; i >= Math.max(0, line - 5); i--) {
    const lineText = lines[i] ?? "";
    if (lineText.includes(ALLOW_MARKER)) return true;
    const trimmed = lineText.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }
    return false;
  }
  return false;
}

function scanFile(absPath: string, violations: Violation[]): void {
  const relPath = relative(SRC_ROOT, absPath);
  if (ALLOWED_FILES.has(relPath)) return;
  const src = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isWorkspaceJoinWithWsId(node)) {
      if (!hasAllowMarker(node, sourceFile, src)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relative(ROOT, absPath),
          line: line + 1,
          column: character + 1,
          snippet: (src.split("\n")[line] ?? "").trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.ts");
  let scanned = 0;

  for await (const rel of glob.scan({ cwd: SRC_ROOT })) {
    const abs = join(SRC_ROOT, rel);
    if (abs.includes("/node_modules/") || abs.includes("/dist/")) continue;
    if (abs.endsWith(".d.ts")) continue;
    scanned++;
    scanFile(abs, violations);
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} hand-built workspace-scoped path(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Workspace-scoped paths must flow through WorkspaceContext (src/workspace/context.ts).",
    );
    console.error(
      'Use `ctx.getDataPath(scope, ...subpaths)` instead of `join(workDir, "workspaces", wsId, ...)`.',
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the call.`,
    );
    process.exit(1);
  }

  console.log(`✓ No raw workspace path construction in ${scanned} src/ files`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
