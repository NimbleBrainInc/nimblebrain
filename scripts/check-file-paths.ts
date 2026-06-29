#!/usr/bin/env bun
/**
 * Lint: files are workspace-owned — never built at the identity level.
 *
 * A file lives under the workspace it was created in, with the owner as a
 * privacy sub-partition:
 *
 *   workspaces/<wsId>/files/<ownerId>/   a member's files (private by default)
 *
 * The identity-owned `{workDir}/users/<userId>/files/` layout is gone. Any new
 * occurrence of identity-level file construction — `getDataPath("files")` on an
 * `IdentityContext`, or joining `"files"` directly onto a non-workspace root —
 * is a regression: it drops the workspace wall the permission model depends on
 * (§2.3).
 *
 * What this script flags:
 *   - `x.getDataPath("files")` / `getDataPath("files")` — the identity store
 *     constructor. Files are no longer identity-owned.
 *   - `join(...)` whose `"files"` segment is NOT qualified by a workspace root
 *     before it (neither a literal `"workspaces", <wsId>` pair nor a
 *     workspace-scoped base like `this.workspacesRoot` / `getWorkspaceScopedDir()`).
 *
 * What it allows:
 *   - `src/files/paths.ts` — the single sanctioned construction (and parse)
 *     site for the `workspaces/<wsId>/files/<ownerId>` layout. It *is* the
 *     definition this lint protects. Build the dir via `workspaceFilesDir()`.
 *   - `scripts/migrate-files-to-room.ts` — it must read the legacy
 *     `{workDir}/users/<userId>/files/` SOURCE paths to move them into the
 *     workspace-owned layout (and it lives under `scripts/`, out of the src
 *     scan anyway).
 *   - A `// lint-ok:file-path` marker on a line just above the construction,
 *     for the rare future case the typed helper genuinely can't cover.
 *
 * Scope: `src/**\/*.ts`. Tests and `scripts/` are out of scope.
 *
 * Exports its AST predicates for a potential self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:file-path";

// Files (relative to repo root) that legitimately reference the file layout —
// either because they DEFINE the workspace-owned layout, or because they
// migrate data off the identity one. The lint would otherwise fight the
// definitions it exists to protect.
const ALLOWED_FILES = new Set(
  [
    // The single sanctioned site that builds + parses the workspace-owned
    // `workspaces/<wsId>/files/<ownerId>` layout.
    "src/files/paths.ts",
    // Migrates files off the identity layout — reads the old
    // `{workDir}/users/<userId>/files/` source paths to relocate them.
    "scripts/migrate-files-to-room.ts",
  ].map((f) => f.split("/").join(sep)),
);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

/** The callee's simple name for `f(...)` / `x.f(...)`, else `null`. */
function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
}

/** The static string value of a string / no-substitution-template literal, else `null`. */
function staticText(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

const WORKSPACE_RE = /workspace/i;

/**
 * True iff `node` carries a workspace-root signal — a `"workspaces"`-ish string
 * literal, or an identifier / property / call whose name references a workspace
 * (`this.workspacesRoot`, `getWorkspaceScopedDir()`, …). Used to decide whether
 * a `"files"` segment is already workspace-scoped rather than identity-level.
 */
function referencesWorkspaces(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const text = staticText(node);
  if (text !== null) return WORKSPACE_RE.test(text);
  if (ts.isIdentifier(node)) return WORKSPACE_RE.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return WORKSPACE_RE.test(node.name.text);
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    return name !== null && WORKSPACE_RE.test(name);
  }
  return false;
}

/** True iff any argument before `idx` qualifies the path with a workspace root. */
function hasWorkspaceQualifierBefore(args: ts.NodeArray<ts.Expression>, idx: number): boolean {
  for (let i = 0; i < idx; i++) {
    if (referencesWorkspaces(args[i])) return true;
  }
  return false;
}

/**
 * Returns true iff `node` is `join(...)` building an identity-level / flat files
 * path — a `"files"` string-literal argument that is NOT qualified by a
 * workspace root before it. `join(usersDir, userId, "files")` flags;
 * `join(workDir, "workspaces", wsId, "files", ownerId)` and
 * `join(this.workspacesRoot, wsId, "files")` do not (already workspace-scoped).
 *
 * Exported for a self-test under `test/unit/scripts/`.
 */
export function isUnscopedFilesJoin(node: ts.CallExpression): boolean {
  if (calleeName(node) !== "join") return false;
  const args = node.arguments;
  for (let j = 0; j < args.length; j++) {
    if (staticText(args[j]) !== "files") continue;
    if (!hasWorkspaceQualifierBefore(args, j)) return true;
  }
  return false;
}

/**
 * True iff `node` is `getDataPath("files")` / `x.getDataPath("files")` — the
 * `IdentityContext` constructor for the identity-owned files dir.
 *
 * Exported for a self-test under `test/unit/scripts/`.
 */
export function isIdentityFilesGetDataPath(node: ts.CallExpression): boolean {
  if (calleeName(node) !== "getDataPath") return false;
  return staticText(node.arguments[0]) === "files";
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
  const relPath = relative(ROOT, absPath);
  if (ALLOWED_FILES.has(relPath)) return;
  const src = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function record(node: ts.Node, reason: string): void {
    if (hasAllowMarker(node, sourceFile, src)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: relative(ROOT, absPath),
      line: line + 1,
      column: character + 1,
      snippet: (src.split("\n")[line] ?? "").trim(),
      reason,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (isIdentityFilesGetDataPath(node)) {
        record(node, 'getDataPath("files") — files are workspace-owned, not identity-owned');
      } else if (isUnscopedFilesJoin(node)) {
        record(node, 'join(..., "files") not under a workspace root — files are workspace-owned');
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
    console.error(`✗ Found ${violations.length} identity-level / unscoped file path(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error("Files are workspace-owned: `workspaces/<wsId>/files/<ownerId>/` (§2.3).");
    console.error(
      "Build the directory via `workspaceFilesDir()` (src/files/paths.ts) or `runtime.getFileStore(wsId, ownerId)` — never the identity `users/<userId>/files/` path.",
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
    );
    process.exit(1);
  }

  console.log(`✓ No identity-level file paths in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
