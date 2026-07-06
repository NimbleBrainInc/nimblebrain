#!/usr/bin/env bun
/**
 * Lint: cross-workspace tool names go through `namespacedToolName` /
 * `parseNamespacedToolName` in `src/tools/namespace.ts`.
 *
 * Stage 2 (cross-workspace refactor) makes `ws_<id>-<toolName>` the
 * canonical cross-workspace tool-name shape. The primitive in
 * `src/tools/namespace.ts` is the **single construction site** for that
 * form. This lint enforces the constraint structurally so a future
 * change to the format (separator, prefix, escape semantics) propagates
 * via one helper rather than scattered string concat.
 *
 * What this script flags (both are regressions):
 *
 *  (a) **Construction-by-hand** of the `ws_<id>-<toolName>` form:
 *      - String literal containing the substring `ws_<id>-` where the
 *        id slot is non-empty.
 *      - Template literal whose head text matches `^ws_…-` OR whose
 *        head is exactly `"ws_"` and the literal after the first span
 *        begins with `-` (the `` `ws_${wsId}-${toolName}` `` shape).
 *      - String concat with the `ws_` prefix immediately followed by
 *        a `-` literal further down the chain.
 *
 *  (b) **Parse-by-hand**: `.split("-")` called on an identifier whose
 *      name strongly suggests a namespaced tool name (matches a small
 *      heuristic regex — `namespaced`, `qualifiedToolName`,
 *      `fullToolName`, etc.). The intent is to nudge callers to use
 *      `parseNamespacedToolName` instead, which validates the shape
 *      and throws on malformed input.
 *
 * What it allows:
 *   - `src/tools/namespace.ts` and its web mirror
 *     `web/src/lib/namespaced-tool.ts` — the primitives define the
 *     format and are the only legal construction/parse sites.
 *   - A `// lint-ok:tool-namespace` marker on the line immediately
 *     above the construction, for the rare future case where the
 *     helper genuinely can't be used (e.g. a wire-format adapter that
 *     must accept the legacy shape unchanged).
 *
 * Scope: `src/**\/*.ts` and `web/src/**\/*.{ts,tsx}`. The web client
 * mirrors the same contract (it can't import from `src/`), so the same
 * discipline applies there — a web-side hand-parse is exactly what
 * slipped through when this lint scanned `src/` only. Tests are out of
 * scope (fixtures construct the shape deliberately).
 *
 * Known gap: this catches `ws_<id>-` *construction* and `.split("-")`
 * *parsing*. It does NOT catch slicing the bare source out of a wire
 * name via `indexOf("__")` / `slice(0, …)` — the canonical fix for
 * that is the `appNameFromToolName` / `parseNamespacedToolName` helper,
 * not a linter predicate (a `__`-slice predicate false-positives on
 * legitimate display-only suffix extraction like `stripServerPrefix`).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const WEB_SRC_ROOT = join(ROOT, "web", "src");
// Both the platform `src/` and the web client `web/src/` are scanned. The
// web tier mirrors the namespaced-tool contract in
// `web/src/lib/namespaced-tool.ts` (it can't import from `src/`), so the same
// construction/parse discipline applies — and a web-side hand-parse is exactly
// the regression that slipped through when this lint scanned `src/` only.
const SCAN_ROOTS = [SRC_ROOT, WEB_SRC_ROOT];
const ALLOW_MARKER = "lint-ok:tool-namespace";

// Relative to their respective scan root: the platform primitive and the web
// mirror are the only legal construction/parse sites.
const ALLOWED_FILES = new Set(
  ["tools/namespace.ts", "lib/namespaced-tool.ts"].map((f) => f.split("/").join(sep)),
);

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
const NAMESPACED_BINDING_RE = /^(?:namespaced|qualified)[A-Za-z_]*name$|^fullToolName$|^toolName$/i;

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

// ── Construction predicates (a) ─────────────────────────────────────

/**
 * True for a string literal whose text contains `ws_<id>-` where the
 * `<id>` slot is non-empty. Catches hard-coded `"ws_helix-crm__search"`
 * and similar.
 *
 * Workspace ids match `[a-z0-9_]` (no hyphens) per
 * `WORKSPACE_ID_PATTERN`, so the regex char class excludes `-`. The
 * first `-` after `ws_<id>` is unambiguously the workspace/tool
 * separator. Empty workspace slot (`"ws_-foo"`) is intentionally NOT
 * flagged here — that's a degenerate shape the primitive rejects,
 * and we don't want to false-positive on unrelated strings.
 */
export function isNamespacedToolStringLiteral(node: ts.StringLiteral): boolean {
  return /ws_[a-zA-Z0-9_]+-/.test(node.text);
}

/**
 * True for a template literal that assembles a `ws_<id>-<rest>` shape.
 * Handles two common forms:
 *   - Head begins with `ws_<X>-` (literal id, dynamic rest).
 *   - Head is exactly `"ws_"` (i.e. the template starts with the
 *     workspace prefix) AND the literal after the first span starts
 *     with `-` (`` `ws_${wsId}-${toolName}` ``).
 *
 * The exact-`"ws_"` requirement (instead of `endsWith("ws_")`) avoids
 * false positives on unrelated templates whose head merely contains
 * `ws_` mid-string, e.g. `` `prefix-ws_${id}-...` ``. The latter is
 * not a Stage-2 namespaced tool name and shouldn't be flagged.
 *
 * No-substitution templates (no `${}`) are routed through
 * `isNamespacedToolStringLiteral` by the visitor — keeping the two
 * predicates strictly disjoint at the AST level.
 */
export function isNamespacedToolTemplate(node: ts.TemplateExpression): boolean {
  // Form 1: literal id in head.
  if (/ws_[a-zA-Z0-9_]+-/.test(node.head.text)) return true;
  // Form 2: head is exactly `"ws_"`, first span's trailing literal
  // begins with `-`.
  if (node.head.text === "ws_") {
    const firstSpan = node.templateSpans[0];
    if (firstSpan?.literal.text.startsWith("-")) return true;
  }
  return false;
}

/** Text of a string or no-substitution-template literal, else null. */
function literalText(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** Flattens a `+` chain into its operand nodes, in source order. */
function flattenPlusChain(node: ts.BinaryExpression): ts.Node[] {
  const operands: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collect(n.left);
      collect(n.right);
    } else {
      operands.push(n);
    }
  };
  collect(node);
  return operands;
}

/** True for the `ws_` prefix literal: bare `"ws_"` or a partial id with no separator yet. */
function isWsPrefixLiteral(text: string): boolean {
  return text === "ws_" || (text.startsWith("ws_") && !text.includes("-"));
}

/**
 * Walks a `+` chain and returns true iff some operand is a literal
 * `"ws_"` AND a later operand (anywhere in the chain) is the literal
 * `"-"` (or starts with `-`). Catches `"ws_" + wsId + "-" + name`.
 *
 * The dual condition keeps the predicate from flagging unrelated
 * concat patterns like `"ws_" + something` that don't continue into a
 * tool-name component. We deliberately require the separator literal
 * to START with `-` (rather than just contain `-`), because `-` is a
 * common char in lots of unrelated strings — broader matching would
 * generate noise on URL/slug/date concat patterns.
 */
export function isNamespacedToolBinaryConcat(node: ts.BinaryExpression): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const operands = flattenPlusChain(node);

  let sawWsPrefix = -1;
  for (let i = 0; i < operands.length; i++) {
    const op = operands[i];
    const text = op ? literalText(op) : null;
    if (text === null) continue;
    if (sawWsPrefix < 0) {
      // Either exactly "ws_" or a literal beginning with "ws_" and
      // ending mid-id (no separator yet).
      if (isWsPrefixLiteral(text)) sawWsPrefix = i;
    } else if (i > sawWsPrefix && text.startsWith("-")) {
      return true;
    }
  }
  return false;
}

// ── Parse predicate (b) ─────────────────────────────────────────────

/**
 * True for `<id>.split("-")` where `<id>` is an identifier whose name
 * matches `NAMESPACED_BINDING_RE`. The pattern is the canonical
 * by-hand-parse the primitive is meant to replace.
 *
 * Conservative on receiver shape: only flags direct identifier
 * receivers (not arbitrary expressions). A property access like
 * `obj.toolName.split("-")` is NOT flagged — the lint should not be a
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
  return literalText(arg) === "-";
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

function scanFile(absPath: string, scanRoot: string, violations: Violation[]): void {
  const relPath = relative(scanRoot, absPath);
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
    if (ts.isStringLiteral(node) && isNamespacedToolStringLiteral(node)) {
      record(node, "string literal builds `ws_<id>-<toolName>` shape");
    } else if (ts.isTemplateExpression(node) && isNamespacedToolTemplate(node)) {
      record(node, "template literal builds `ws_<id>-<toolName>` shape");
    } else if (ts.isBinaryExpression(node) && isNamespacedToolBinaryConcat(node)) {
      record(node, "string concat builds `ws_<id>-<toolName>` shape");
    } else if (ts.isCallExpression(node) && isNamespacedSplit(node)) {
      record(node, '`.split("/")` on a presumed namespaced tool name');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/** True for paths outside scope: deps, build output, type decls, tests, generated mirrors. */
function isExcludedPath(abs: string): boolean {
  if (abs.includes("/node_modules/") || abs.includes("/dist/")) return true;
  if (abs.endsWith(".d.ts")) return true;
  // Tests construct/parse the shape deliberately (fixtures) — out of scope,
  // matching the platform-side `test/` exclusion.
  if (abs.includes("/__tests__/") || abs.endsWith(".test.ts") || abs.endsWith(".test.tsx")) {
    return true;
  }
  // Generated mirrors of the workspace-id pattern are not hand-written.
  return abs.includes("/_generated/");
}

/** Prints every violation with guidance to stderr and exits non-zero. */
function reportViolations(violations: Violation[]): never {
  console.error(
    `✗ Found ${violations.length} hand-built namespaced tool name(s) in src/ + web/src/:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
    console.error(`    ${v.snippet}\n`);
  }
  console.error("Cross-workspace tool names must flow through `namespacedToolName(wsId, name)` /");
  console.error("`parseNamespacedToolName(s)` — `src/tools/namespace.ts` (platform) or");
  console.error("`web/src/lib/namespaced-tool.ts` (web mirror).");
  console.error(
    `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  // `.tsx` included so the web client's React components are covered, not just
  // its plain `.ts` modules.
  const glob = new Glob("**/*.{ts,tsx}");
  let scanned = 0;

  for (const scanRoot of SCAN_ROOTS) {
    for await (const rel of glob.scan({ cwd: scanRoot })) {
      const abs = join(scanRoot, rel);
      if (isExcludedPath(abs)) continue;
      scanned++;
      scanFile(abs, scanRoot, violations);
    }
  }

  if (violations.length > 0) reportViolations(violations);

  console.log(`✓ No hand-built namespaced tool names in ${scanned} src/ + web/src/ files`);
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
