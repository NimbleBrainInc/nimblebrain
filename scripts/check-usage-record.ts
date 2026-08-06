#!/usr/bin/env bun
/**
 * Lint: LLM spend is recorded through exactly one seam.
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
 * What this flags, in two rules:
 *
 *   `recordLlmUsage(...)` — allowed only in `src/usage/record.ts`.
 *   `llmCallsTotal.inc(...)` / `llmTokensTotal.inc(...)` — allowed only in
 *   `src/api/metrics.ts`, which defines them.
 *
 * The second rule is what makes the first mean anything. Both counters are
 * `export const`, so pinning the function alone would leave the seam bypassable
 * by incrementing them directly — a path that skips derivation entirely and
 * mints a series with no `origin` at all.
 *
 * Import statements are not calls and are not flagged; the check is on the call
 * expression, so re-exporting, type-importing, or *reading* a counter
 * (`.get()`, as tests do) is fine.
 *
 * Escape hatch: a `// lint-ok:usage-record` marker on a comment line within the
 * five lines above the call. Use it only for a call that genuinely must bypass
 * the seam; adding a second recording path is a design change, not a lint
 * exemption.
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

/**
 * Each guarded call, and the single file allowed to make it.
 *
 * The two owners are different on purpose: `api/metrics.ts` owns the Prometheus
 * counters and is the only place that may increment them, while
 * `usage/record.ts` owns "what a priced call is and who it was for" and is the
 * only place that may reach `recordLlmUsage`. Neither is allowed to do the
 * other's job.
 */
const RULES: ReadonlyArray<{ call: string; owner: string }> = [
  { call: "recordLlmUsage", owner: "src/usage/record.ts" },
  { call: "llmCallsTotal.inc", owner: "src/api/metrics.ts" },
  { call: "llmTokensTotal.inc", owner: "src/api/metrics.ts" },
];

/** `owner` paths as platform-native, for comparison against `relative()` output. */
const OWNERS = new Map(RULES.map((r) => [r.call, r.owner.split("/").join(sep)]));

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  call: string;
  owner: string;
}

/**
 * The guarded call `node` makes, else `null`.
 *
 * `f(...)` matches by identifier; `x.f(...)` matches on the dotted `x.f` so the
 * counter rules can name a method on a specific object rather than every `.inc`
 * in the tree.
 */
function guardedCall(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return OWNERS.has(callee.text) ? callee.text : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const dotted = `${callee.expression.text}.${callee.name.text}`;
    return OWNERS.has(dotted) ? dotted : null;
  }
  return null;
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
  const src = readFileSync(absPath, "utf-8");
  if (!RULES.some((r) => src.includes(r.call.split(".")[0] ?? r.call))) return;

  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const call = guardedCall(node);
      const owner = call === null ? undefined : OWNERS.get(call);
      if (call !== null && owner !== relPath && !hasAllowMarker(node, sourceFile, src)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push({
          file: relPath,
          line: line + 1,
          column: character + 1,
          snippet: (src.split("\n")[line] ?? "").trim(),
          call,
          owner: owner ?? "?",
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
    console.error(`✗ Found ${violations.length} guarded usage call(s) outside their owner:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.call}() belongs to ${v.owner}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Spend is recorded at one seam so attribution is derived from the request context,",
    );
    console.error("not asserted by the caller. Call `recordLlmCall()` from src/usage/record.ts.");
    console.error(
      `A genuine exception requires a // ${ALLOW_MARKER} comment within the five lines above the call.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ ${RULES.length} guarded usage call(s) each have one caller in ${scanned} src/ files`,
  );
}

// Gate the scan on direct invocation, matching the sibling check scripts, so
// importing this module never runs it or calls process.exit.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
