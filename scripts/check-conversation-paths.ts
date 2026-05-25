#!/usr/bin/env bun
/**
 * Lint: conversation files live at the top-level user path post-Stage-1.
 *
 * The cross-workspace refactor (Stage 1 Task 005) collapsed every
 * conversation onto a single user-scoped store at
 * `{workDir}/conversations/{convId}.jsonl`. The pre-Stage-1 workspace-
 * scoped layout (`{workDir}/workspaces/{wsId}/conversations/...`) is
 * fully deleted. Any new occurrence of `join(..., "workspaces", X,
 * "conversations", ...)` is a regression.
 *
 * What this script flags: any `join(...)` call whose argument list
 * contains the literal sequence `"workspaces", <wsId>, "conversations"`
 * — building a per-workspace conversations directory by hand.
 *
 * What it allows:
 *   - `scripts/migrate-conversations-to-top-level.ts` — explicitly
 *     reads the old layout to move files to the new one.
 *   - `src/conversation/event-sourced-store.ts` — the store doesn't
 *     know whether its `dir` is workspace-scoped or top-level; the
 *     directory is injected. Whoever passes the dir owns the layout
 *     decision (the runtime always passes the top-level path).
 *   - A `// lint-ok:conversation-path` marker on the line immediately
 *     above the call, for the rare future case where the typed helper
 *     genuinely doesn't apply.
 *
 * Scope: `src/**\/*.ts`. Tests are out of scope (legacy migration tests
 * deliberately construct the old paths to assert the migration moves
 * them away).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:conversation-path";

// Files that legitimately reference the legacy workspace-scoped path,
// either to migrate away from it or because the store layer is
// dir-agnostic by design.
const ALLOWED_FILES = new Set(
  [
    // Store implementation gets its dir injected — caller picks the
    // layout. The runtime always passes top-level; the lint would
    // false-positive against the `join(this.dir, ...)` calls inside.
    "conversation/event-sourced-store.ts",
  ].map((f) => f.split("/").join(sep)),
);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

/**
 * Returns true iff `node` is `join(...)` whose args contain the
 * adjacency `"workspaces", <wsId>, "conversations"`. The `<wsId>` slot
 * accepts any non-literal (identifier, property access, etc.) — the
 * lint is about the workspace-scoped-conversation pattern, not the
 * specific wsId expression.
 *
 * Exported for the self-test under `test/unit/scripts/`.
 */
export function isWorkspaceConversationJoin(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (calleeName !== "join") return false;

  const args = node.arguments;
  // Need three adjacent positions: "workspaces", <wsId>, "conversations".
  for (let i = 0; i < args.length - 2; i++) {
    const a = args[i];
    const b = args[i + 1];
    const c = args[i + 2];
    if (!a || !b || !c) continue;
    const aIsWorkspaces =
      (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "workspaces";
    const cIsConversations =
      (ts.isStringLiteral(c) || ts.isNoSubstitutionTemplateLiteral(c)) &&
      c.text === "conversations";
    if (aIsWorkspaces && cIsConversations) return true;
  }
  return false;
}

/**
 * Returns true iff `node` is a template literal whose text contains
 * the substring `workspaces/<...>/conversations/`. Catches the
 * `` `${workDir}/workspaces/${wsId}/conversations/${id}.jsonl` ``
 * shape that `join` would otherwise express piecewise.
 */
export function isWorkspaceConversationTemplate(node: ts.TemplateExpression): boolean {
  let assembled = node.head.text;
  for (const span of node.templateSpans) {
    // Use a placeholder so adjacency-matching works on the literal text
    // between substitutions.
    assembled += "<expr>";
    assembled += span.literal.text;
  }
  return /workspaces\/[^/]+\/conversations(\/|$)/.test(assembled);
}

export function isWorkspaceConversationStringLiteral(node: ts.StringLiteral): boolean {
  return /workspaces\/[^/]+\/conversations(\/|$)/.test(node.text);
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

  function record(node: ts.Node): void {
    if (hasAllowMarker(node, sourceFile, src)) return;
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

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isWorkspaceConversationJoin(node)) {
      record(node);
    } else if (ts.isTemplateExpression(node) && isWorkspaceConversationTemplate(node)) {
      record(node);
    } else if (ts.isStringLiteral(node) && isWorkspaceConversationStringLiteral(node)) {
      record(node);
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
      `✗ Found ${violations.length} workspace-scoped conversation path(s) in src/:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Stage 1: conversations live at `{workDir}/conversations/{convId}.jsonl` — top-level, user-scoped.",
    );
    console.error(
      "Use `runtime.findConversationStore()` / `runtime.findConversation(convId)` instead of building per-workspace paths.",
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
    );
    process.exit(1);
  }

  console.log(`✓ No workspace-scoped conversation paths in ${scanned} src/ files`);
}

// Gate the side effect on direct invocation. Unit tests `import` this
// module to exercise the AST predicates above without triggering the
// full src/ scan + process.exit.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
