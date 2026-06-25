#!/usr/bin/env bun
/**
 * Lint: files are identity-owned and reached through one constructor.
 *
 * Phase B moved files from the per-workspace store
 * (`{workDir}/workspaces/{wsId}/files/`) to the identity store
 * (`{workDir}/users/{userId}/files/`). To keep that single, two things are
 * enforced in `src/`:
 *
 *   1. `createFileStore(...)` is called only in `src/runtime/runtime.ts` —
 *      via `Runtime.getFileStore(userId)` (the sanctioned identity-scoped
 *      constructor) and the host-resources resolver closure. Any other call
 *      site builds a store off a path the caller chose, which is how files
 *      drifted back into a workspace silo.
 *   2. `join(getWorkspaceScopedDir(...), ..., "files")` — building a
 *      workspace-scoped files dir by hand — is forbidden anywhere in `src/`.
 *
 * Allowed: a `// lint-ok:file-path` marker on a line just above the call,
 * for the rare future case the constructor genuinely can't cover.
 *
 * Scope: `src/**\/*.ts`. Tests and `scripts/` are out of scope (the
 * migration deliberately reads the old workspace-scoped layout).
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

// `runtime.ts` owns FileStore construction: the `getFileStore` method (the
// sanctioned identity-scoped constructor) and the host-resources resolver
// closure both legitimately call `createFileStore`.
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

/** True iff `node` is `getWorkspaceScopedDir(...)` / `x.getWorkspaceScopedDir(...)`. */
function isGetWorkspaceScopedDirCall(node: ts.CallExpression): boolean {
  return calleeName(node) === "getWorkspaceScopedDir";
}

/**
 * True iff `node` is `join(getWorkspaceScopedDir(...), ..., "files")` — a
 * hand-built workspace-scoped files dir. The first arg is the workspace-scoped
 * root; any literal `"files"` argument anywhere in the `join` trips it.
 */
export function isWorkspaceScopedFilesJoin(node: ts.CallExpression): boolean {
  if (calleeName(node) !== "join") return false;
  const args = node.arguments;
  const firstIsWsScoped =
    args.length > 0 &&
    args[0] !== undefined &&
    ts.isCallExpression(args[0]) &&
    isGetWorkspaceScopedDirCall(args[0]);
  if (!firstIsWsScoped) return false;
  return args.some(
    (a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "files",
  );
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
        record(node, "createFileStore() outside runtime.ts — use runtime.getFileStore(userId)");
      } else if (isWorkspaceScopedFilesJoin(node)) {
        record(node, 'join(getWorkspaceScopedDir(...), ..., "files") — files are identity-owned');
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
      `✗ Found ${violations.length} workspace-scoped / unsanctioned file path(s) in src/:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error("Phase B: files are identity-owned at `{workDir}/users/{userId}/files/`.");
    console.error("Build a store only via `runtime.getFileStore(userId)`.");
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above.`,
    );
    process.exit(1);
  }

  console.log(`✓ No workspace-scoped file paths in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
