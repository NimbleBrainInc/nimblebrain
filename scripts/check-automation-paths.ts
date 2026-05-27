#!/usr/bin/env bun
/**
 * Lint: automations are identity-owned and live under the owner's dir.
 *
 * Phase C moved automations from the per-workspace store
 * (`workspaces/{wsId}/automations/`, created by a buggy tool override) and the
 * instance-level store to the owner-partitioned identity store
 * (`users/{userId}/automations/`). The store dir must be resolved from the
 * caller's identity (`getIdentityContext(userId).getDataPath("automations")`),
 * never the workspace.
 *
 * Flags `join(getWorkspaceScopedDir(...), ..., "automations")` anywhere in
 * `src/` — building a workspace-scoped automations dir by hand, the exact
 * regression this migration removes.
 *
 * Allowed: a `// lint-ok:automation-path` marker on the line above. Scope:
 * `src/**\/*.ts`; tests + `scripts/` are out of scope (the migration reads the
 * old workspace-scoped layout deliberately).
 *
 * Exports its AST predicate for the self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:automation-path";

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
}

/** True iff `node` is `getWorkspaceScopedDir(...)` / `x.getWorkspaceScopedDir(...)`. */
function isGetWorkspaceScopedDirCall(node: ts.CallExpression): boolean {
  return calleeName(node) === "getWorkspaceScopedDir";
}

/**
 * True iff `node` is `join(getWorkspaceScopedDir(...), ..., "automations")` — a
 * hand-built workspace-scoped automations dir.
 */
export function isWorkspaceScopedAutomationsJoin(node: ts.CallExpression): boolean {
  if (calleeName(node) !== "join") return false;
  const args = node.arguments;
  const firstIsWsScoped =
    args.length > 0 &&
    args[0] !== undefined &&
    ts.isCallExpression(args[0]) &&
    isGetWorkspaceScopedDirCall(args[0]);
  if (!firstIsWsScoped) return false;
  return args.some(
    (a) =>
      (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "automations",
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
  const src = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isWorkspaceScopedAutomationsJoin(node)) {
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
    console.error(`✗ Found ${violations.length} workspace-scoped automations path(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Phase C: automations are identity-owned at `{workDir}/users/{userId}/automations/`.",
    );
    console.error(
      'Resolve the store via `runtime.getIdentityContext(userId).getDataPath("automations")`.',
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above.`,
    );
    process.exit(1);
  }

  console.log(`✓ No workspace-scoped automations paths in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
