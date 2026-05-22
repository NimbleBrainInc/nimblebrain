#!/usr/bin/env bun
/**
 * Lint: cross-workspace tool names go through `namespacedToolName` /
 * `parseNamespacedToolName` in `src/tools/namespace.ts`.
 *
 * Stage 2 (delegation-model refactor) makes `ws_<id>/<toolName>` the
 * canonical cross-workspace tool-name shape. The primitive in
 * `src/tools/namespace.ts` is the **single construction site** for that
 * form. This lint enforces the constraint structurally so a future
 * change to the format (separator, prefix, escape semantics) propagates
 * via one helper rather than scattered string concat.
 *
 * What this script flags (both are regressions):
 *
 *  (a) **Construction-by-hand** of the `ws_<id>/<toolName>` form:
 *      - String literal containing the substring `ws_<id>/` where the
 *        id slot is non-empty.
 *      - Template literal whose head text matches `^ws_…/` OR whose
 *        head ends with `ws_` and the first span is followed by a
 *        literal beginning with `/` (the
 *        `` `ws_${wsId}/${toolName}` `` shape).
 *      - String concat with the `ws_` prefix immediately followed by
 *        a `/` literal further down the chain.
 *
 *  (b) **Parse-by-hand**: `.split("/")` called on an identifier whose
 *      name strongly suggests a namespaced tool name (matches a small
 *      heuristic regex — `namespaced`, `qualifiedToolName`,
 *      `fullToolName`, etc.). The intent is to nudge callers to use
 *      `parseNamespacedToolName` instead, which validates the shape
 *      and throws on malformed input.
 *
 * What it allows:
 *   - `src/tools/namespace.ts` itself — the primitive defines the
 *     format and is the only legal construction/parse site.
 *   - A `// lint-ok:tool-namespace` marker on the line immediately
 *     above the construction, for the rare future case where the
 *     helper genuinely can't be used (e.g. a wire-format adapter that
 *     must accept the legacy shape unchanged).
 *
 * Scope: `src/**\/*.ts`. Tests are out of scope (fixtures construct
 * the shape deliberately).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:tool-namespace";

const ALLOWED_FILES = new Set(["tools/namespace.ts"].map((f) => f.split("/").join(sep)));

/**
 * Identifiers whose name suggests "this is a namespaced tool name."
 * Conservative on purpose — flagging any `.split("/")` would generate
 * noise on URL parsing, server-name normalization, and other unrelated
 * code paths. The bindings we mean to catch in this codebase have
 * `namespaced`, `qualified`, or `fullTool` in their name, OR are
 * literally `toolName`. We deliberately do NOT match the bare
 * identifier `name` — too many call sites use `name` for unrelated
 * things (e.g. reverse-DNS server names in `src/bundles/paths.ts`).
 * If a future call site genuinely binds a namespaced tool name to
 * `name`, the lint surfaces it via the construction predicates first;
 * splitting it back open is then trivially obvious in review.
 */
const NAMESPACED_BINDING_RE =
  /^(?:namespaced|qualified)[A-Za-z_]*name$|^fullToolName$|^toolName$/i;

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

// ── Construction predicates (a) ─────────────────────────────────────

/**
 * True for a string literal whose text contains `ws_<id>/` where the
 * `<id>` slot is non-empty. Catches hard-coded `"ws_helix/crm.search"`
 * and similar.
 *
 * Empty workspace slot (`"ws_/foo"`) is intentionally NOT flagged here
 * — that's a degenerate shape the primitive rejects, and we don't want
 * to false-positive on unrelated strings that happen to contain `ws_/`.
 */
export function isNamespacedToolStringLiteral(node: ts.StringLiteral): boolean {
  return /ws_[a-zA-Z0-9_-]+\//.test(node.text);
}

/**
 * True for a template literal that assembles a `ws_<id>/<rest>` shape.
 * Handles two common forms:
 *   - Head begins with `ws_X/` (literal id, dynamic rest).
 *   - Head is exactly `"ws_"` (i.e. the template starts with the
 *     workspace prefix) AND the literal after the first span starts
 *     with `/` (`` `ws_${wsId}/${toolName}` ``).
 *
 * The exact-`"ws_"` requirement (instead of `endsWith("ws_")`) avoids
 * false positives on unrelated templates whose head merely contains
 * `ws_` mid-string, e.g. `` `prefix-ws_${id}/...` ``. The latter is
 * not a Stage-2 namespaced tool name and shouldn't be flagged.
 *
 * No-substitution templates (no `${}`) are routed through
 * `isNamespacedToolStringLiteral` by the visitor — keeping the two
 * predicates strictly disjoint at the AST level.
 */
export function isNamespacedToolTemplate(node: ts.TemplateExpression): boolean {
  // Form 1: literal id in head.
  if (/ws_[a-zA-Z0-9_-]+\//.test(node.head.text)) return true;
  // Form 2: head is exactly `"ws_"`, first span's trailing literal
  // begins with `/`.
  if (node.head.text === "ws_") {
    const firstSpan = node.templateSpans[0];
    if (firstSpan && firstSpan.literal.text.startsWith("/")) return true;
  }
  return false;
}

/**
 * Walks a `+` chain and returns true iff some operand is a literal
 * `"ws_"` AND a later operand (anywhere in the chain) is a literal
 * beginning with `"/"`. Catches `"ws_" + wsId + "/" + name`.
 *
 * The dual condition keeps the predicate from flagging unrelated
 * concat patterns like `"ws_" + something` that don't continue into a
 * tool-name component.
 */
export function isNamespacedToolBinaryConcat(node: ts.BinaryExpression): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const operands: ts.Node[] = [];
  function collect(n: ts.Node): void {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collect(n.left);
      collect(n.right);
    } else {
      operands.push(n);
    }
  }
  collect(node);

  let sawWsPrefix = -1;
  let sawSlashAfter = false;
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i];
    if (!op) continue;
    const text =
      ts.isStringLiteral(op) || ts.isNoSubstitutionTemplateLiteral(op) ? op.text : null;
    if (text === null) continue;
    if (sawWsPrefix < 0) {
      // Either exactly "ws_" or a literal beginning with "ws_" and
      // ending mid-id (no slash yet).
      if (text === "ws_" || (text.startsWith("ws_") && !text.includes("/"))) {
        sawWsPrefix = i;
      }
    } else if (i > sawWsPrefix) {
      if (text.startsWith("/") || text.includes("/")) {
        sawSlashAfter = true;
        break;
      }
    }
  }
  return sawWsPrefix >= 0 && sawSlashAfter;
}

// ── Parse predicate (b) ─────────────────────────────────────────────

/**
 * True for `<id>.split("/")` where `<id>` is an identifier whose name
 * matches `NAMESPACED_BINDING_RE`. The pattern is the canonical
 * by-hand-parse the primitive is meant to replace.
 *
 * Conservative on receiver shape: only flags direct identifier
 * receivers (not arbitrary expressions). A property access like
 * `obj.toolName.split("/")` is NOT flagged — the lint should not be a
 * data-flow analyzer. Real misuse tends to be direct.
 */
export function isNamespacedSplit(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "split") return false;
  const receiver = node.expression.expression;
  if (!ts.isIdentifier(receiver)) return false;
  if (!NAMESPACED_BINDING_RE.test(receiver.text)) return false;
  const [arg] = node.arguments;
  if (!arg) return false;
  const argText =
    ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
  return argText === "/";
}

// ── Walker scaffolding (same shape as check-conversation-paths.ts) ──

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

  function record(node: ts.Node, reason: string): void {
    if (hasAllowMarker(node, sourceFile, src)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    violations.push({
      file: relative(ROOT, absPath),
      line: line + 1,
      column: character + 1,
      snippet: (src.split("\n")[line] ?? "").trim(),
      reason,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && isNamespacedToolStringLiteral(node)) {
      record(node, "string literal builds `ws_<id>/<toolName>` shape");
    } else if (ts.isTemplateExpression(node) && isNamespacedToolTemplate(node)) {
      record(node, "template literal builds `ws_<id>/<toolName>` shape");
    } else if (ts.isBinaryExpression(node) && isNamespacedToolBinaryConcat(node)) {
      record(node, "string concat builds `ws_<id>/<toolName>` shape");
    } else if (ts.isCallExpression(node) && isNamespacedSplit(node)) {
      record(node, '`.split("/")` on a presumed namespaced tool name');
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
    console.error(`✗ Found ${violations.length} hand-built namespaced tool name(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Cross-workspace tool names must flow through `namespacedToolName(wsId, name)` /",
    );
    console.error("`parseNamespacedToolName(s)` from `src/tools/namespace.ts`.");
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
    );
    process.exit(1);
  }

  console.log(`✓ No hand-built namespaced tool names in ${scanned} src/ files`);
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
