#!/usr/bin/env bun
/**
 * Lint: `recordLlmUsage` has exactly one caller — `src/usage/record.ts`.
 *
 * Spend is recorded at one seam so that attribution is *derived* from the
 * ambient request context rather than asserted by whoever happens to be making
 * the call. A second caller reintroduces the failure this design exists to
 * close, and reintroduces it silently: a call labeled with the wrong origin
 * still increments a counter, so nothing breaks, no test goes red, and the
 * number is simply wrong until someone reconciles it against an invoice.
 *
 * That is not hypothetical. Usage was previously derived from a storage side
 * effect — a conversation file happening to exist — and four call paths that
 * did not write one (task runs, delegated sub-agents, background briefing
 * refresh, archived workspaces) spent real money that no in-product surface
 * showed. `src/usage/record.ts` is the fix; this lint is what keeps it true.
 *
 * What this flags: any call to `recordLlmUsage(...)` outside the sanctioned
 * module. Import statements are not calls and are not flagged — the check is on
 * the call expression, so re-exporting or type-importing the symbol is fine.
 *
 * Escape hatch: a `// lint-ok:usage-record` marker on a comment line above the
 * call. Use it only for a call that genuinely must bypass the seam; adding a
 * second recording path is a design change, not a lint exemption.
 *
 * Scope: `src/**\/*.ts`. Tests are out of scope — a unit test that drives the
 * counters directly is asserting on the wire format, not spending money.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:usage-record";
const GUARDED_FN = "recordLlmUsage";

/**
 * The one module allowed to call it — and `api/metrics.ts` itself, which
 * *defines* the function. The definition is not a call, but the file also owns
 * the counters, so exempting it keeps the lint from fighting its own subject.
 */
const ALLOWED_FILES = new Set(
  ["src/usage/record.ts", "src/api/metrics.ts"].map((f) => f.split("/").join(sep)),
);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
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

/**
 * True iff `node` is a call to the guarded function.
 *
 * Exported for the self-test under `test/unit/scripts/`.
 */
export function isGuardedUsageCall(node: ts.CallExpression): boolean {
  return calleeName(node) === GUARDED_FN;
}

/** True iff a `lint-ok:usage-record` marker sits in the comment block above `node`. */
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
  if (!src.includes(GUARDED_FN)) return;

  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isGuardedUsageCall(node)) {
      if (!hasAllowMarker(node, sourceFile, src)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
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
    console.error(
      `✗ Found ${violations.length} ${GUARDED_FN}() call(s) outside src/usage/record.ts:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Spend is recorded at one seam so attribution is derived from the request context,",
    );
    console.error("not asserted by the caller. Call `recordLlmCall()` from src/usage/record.ts.");
    console.error(
      `A genuine exception requires a // ${ALLOW_MARKER} comment on the line above the call.`,
    );
    process.exit(1);
  }

  console.log(`✓ ${GUARDED_FN}() has one caller across ${scanned} src/ files`);
}

// Gate the side effect on direct invocation so the unit test can import the
// AST predicate without triggering the full scan + process.exit.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
