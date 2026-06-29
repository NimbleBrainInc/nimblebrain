#!/usr/bin/env bun
/**
 * Lint: files are workspace-owned and reached through one constructor.
 *
 * Files live under the workspace that owns them, with the owner as a privacy
 * sub-partition (`{workDir}/workspaces/<wsId>/files/<ownerId>/`). To keep that
 * single, two things are enforced in `src/`:
 *
 *   1. `createFileStore(...)` is called only in `src/runtime/runtime.ts` —
 *      via `Runtime.getWorkspaceFileStore(wsId, ownerId)` (the sanctioned workspace-scoped
 *      constructor) and the host-resources resolver closure. Any other call
 *      site builds a store off a path the caller chose, which is how files
 *      drift out of the workspace-owned layout.
 *   2. `getIdentityContext(...).getDataPath("files")` /
 *      `new IdentityContext(...).getDataPath("files")` — reaching the legacy
 *      identity-owned files dir (`users/<userId>/files`) — is forbidden
 *      anywhere in `src/`. The owning workspace, not the caller's identity, decides
 *      where a file lives; the dir comes only from `workspaceFilesDir()` in
 *      `src/files/paths.ts`.
 *
 * Allowed: a `// lint-ok:file-path` marker on a line just above the call,
 * for the rare future case the constructor genuinely can't cover.
 *
 * Scope: `src/**\/*.ts`. Tests and `scripts/` are out of scope (the
 * migration deliberately reads the old identity-scoped layout).
 *
 * Exports its AST predicates for the self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:file-path";

// `runtime.ts` owns FileStore construction: the `getWorkspaceFileStore` method (the
// sanctioned workspace-scoped constructor) and the host-resources resolver closure
// both legitimately call `createFileStore`. `src/files/paths.ts` defines
// `workspaceFilesDir` (the only sanctioned dir builder) and is never a call site for
// `createFileStore`, so it needs no exemption here.
const CREATE_STORE_ALLOWED_FILES = new Set(
  ["runtime/runtime.ts"].map((f) => f.split("/").join(sep)),
);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
}

/** True iff `node` is a `createFileStore(...)` call. */
export function isCreateFileStoreCall(node: ts.CallExpression): boolean {
  return calleeName(node) === "createFileStore";
}

/**
 * True iff `expr` produces an `IdentityContext` directly — a call to
 * `getIdentityContext(...)` / `x.getIdentityContext(...)`, or a
 * `new IdentityContext(...)` / `IdentityContext(...)` construction.
 */
function chainsFromIdentityContext(expr: ts.Expression): boolean {
  if (ts.isCallExpression(expr)) {
    const name = calleeName(expr);
    return name === "getIdentityContext" || name === "IdentityContext";
  }
  if (ts.isNewExpression(expr)) {
    const target = expr.expression;
    const name = ts.isIdentifier(target)
      ? target.text
      : ts.isPropertyAccessExpression(target)
        ? target.name.text
        : null;
    return name === "IdentityContext" || name === "getIdentityContext";
  }
  return false;
}

/**
 * True iff `node` is `<identityCtx>.getDataPath("files", ...)` — reaching the
 * legacy identity-owned files dir. Matches only when the `getDataPath` receiver
 * chains directly from `getIdentityContext`/`IdentityContext` and the first
 * argument is the string literal `"files"`.
 */
export function isIdentityFilesDataPath(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "getDataPath") return false;
  const first = node.arguments[0];
  const firstIsFiles =
    first !== undefined &&
    (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
    first.text === "files";
  if (!firstIsFiles) return false;
  return chainsFromIdentityContext(callee.expression);
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
  const createStoreAllowed = CREATE_STORE_ALLOWED_FILES.has(relPath);
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
      if (isCreateFileStoreCall(node) && !createStoreAllowed) {
        record(
          node,
          "createFileStore() outside runtime.ts — use runtime.getWorkspaceFileStore(wsId, ownerId)",
        );
      } else if (isIdentityFilesDataPath(node)) {
        record(
          node,
          'getIdentityContext(...).getDataPath("files") — files are workspace-owned; use workspaceFilesDir()',
        );
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
    console.error(
      `✗ Found ${violations.length} identity-owned / unsanctioned file path(s) in src/:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Files are workspace-owned at `{workDir}/workspaces/<wsId>/files/<ownerId>/` — build the dir only",
    );
    console.error(
      "via `workspaceFilesDir()` (src/files/paths.ts) and the store via `runtime.getWorkspaceFileStore(wsId, ownerId)`.",
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above.`,
    );
    process.exit(1);
  }

  console.log(`✓ No identity-owned file paths in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
