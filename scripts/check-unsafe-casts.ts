#!/usr/bin/env bun
/**
 * Lint: every `as unknown as T` carries a comment naming the mismatch it
 * works around.
 *
 * A double cast through `unknown` tells the compiler to stop checking. Where a
 * typed path exists (a type guard, a schema parse, a typed test helper, the
 * SDK's own input or output type) the cast should not be there at all. Where
 * none does, the comment is the only record of why: it names what the value
 * really is and what the code claims it is, so a reader can tell when the cast
 * has become unnecessary. Rule and examples: CODE_STYLE.md, "A double cast
 * names its mismatch".
 *
 * What this flags: an assertion (`x as T` or `<T>x`) whose operand, with
 * parentheses stripped, is an assertion to `unknown`, when no qualifying
 * comment sits on the cast's line or on the line directly above it. A cast
 * that spans lines has two: the line holding `unknown`, and the line where the
 * asserted expression starts, so a comment may sit above a multi-line literal
 * as well as beside its closing `} as unknown as T`. A comment above may span
 * several lines (a block comment, or a run of `//` lines); the whole of it is
 * read.
 *
 * What qualifies: after the comment markers and any lint directive
 * (`biome-ignore …:`, `eslint-disable…`, `deno-lint-ignore…`,
 * `@ts-expect-error`) are stripped, the text holds at
 * least `MIN_SPECIFIC_WORDS` words outside `GENERIC_WORDS`. "cast", "type
 * hack", "TODO fix types", and "SDK type gap" fail; "partial stub: only
 * `get` is called" passes. The floor is mechanical, so it rejects the empty
 * and the placeholder comment and leaves whether a passing comment is true to
 * review.
 *
 * Scope: `.ts`/`.tsx` files under each root in `SCOPE` (vendored
 * `node_modules` and build output skipped). The scope is the only lever:
 * there is no per-line marker and no file exemption.
 *
 * Exports `findUnsafeCasts`, `namesMismatch`, and `scan` for the self-test
 * under `test/unit/scripts/`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");

/**
 * The trees this check covers, relative to the repo root. A root covers its
 * whole subtree. A `test/` directory joins when every cast in it carries a
 * qualifying comment or has been retyped away; `test` itself replaces the
 * `test/` entries once all of them have.
 */
export const SCOPE: readonly string[] = [
  "src",
  "web/src",
  "test/conformance",
  "test/eval",
  "test/fixtures",
  "test/helpers",
  "test/integration/api",
  "test/integration/identity",
  "test/integration/security",
  "test/scripts",
  "test/unit/__golden__",
  "test/unit/brand",
  "test/unit/bridge",
  "test/unit/docs",
  "test/unit/engine",
  "test/unit/fixtures",
  "test/unit/lifecycle",
  "test/unit/middleware",
  "test/unit/oauth",
  "test/unit/orchestrator",
  "test/unit/platform/compose",
  "test/unit/scripts",
  "test/unit/services",
  "test/unit/usage",
  "test/unit/util",
];

/**
 * Words that say a cast exists without saying what it works around. A comment
 * made only of these (plus fewer than `MIN_SPECIFIC_WORDS` others) is a
 * placeholder.
 */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "any",
  "as",
  "because",
  "but",
  "cast",
  "casting",
  "casts",
  "compiler",
  "escape",
  "fine",
  "fix",
  "fixme",
  "for",
  "hack",
  "hatch",
  "here",
  "ignore",
  "intentional",
  "intentionally",
  "is",
  "issue",
  "it",
  "just",
  "lib",
  "library",
  "limitation",
  "mismatch",
  "necessary",
  "need",
  "needed",
  "needs",
  "of",
  "ok",
  "safe",
  "sdk",
  "temp",
  "temporary",
  "test",
  "tests",
  "the",
  "this",
  "to",
  "todo",
  "ts",
  "type",
  "types",
  "typescript",
  "typing",
  "unknown",
  "unsafe",
  "workaround",
  "xxx",
]);

/** How many non-generic words a comment needs to count as naming the mismatch. */
export const MIN_SPECIFIC_WORDS = 3;

export interface UnsafeCast {
  file: string;
  /** 1-based line holding the `unknown` of the double cast. */
  line: number;
  snippet: string;
  /** The comment text read for this cast (on or above each of its lines), or null. */
  comment: string | null;
  /** True when `comment` names the mismatch. */
  ok: boolean;
}

/** The comment's words, with markers and lint directives stripped. */
function commentWords(text: string): string[] {
  const body = text
    .replace(/^\/\*+|\*+\/$/g, " ")
    .replace(/^\s*\/\/+/gm, " ")
    .replace(/^\s*\*+/gm, " ")
    .replace(/biome-ignore\S*\s+\S+(?::)?/g, " ")
    .replace(/(?:eslint-disable|deno-lint-ignore)\S*(?:\s+[\w/@-]+(?:,\s*[\w/@-]+)*)?/g, " ")
    .replace(/@ts-(?:expect-error|ignore|nocheck)/g, " ");
  return body.toLowerCase().match(/[a-z0-9_$]+/g) ?? [];
}

/** True when `text` (a raw comment, markers included) names the mismatch. */
export function namesMismatch(text: string): boolean {
  const specific = commentWords(text).filter((w) => !GENERIC_WORDS.has(w));
  return specific.length >= MIN_SPECIFIC_WORDS;
}

interface CommentSpan {
  startLine: number;
  endLine: number;
  text: string;
  /** True for a `//` comment, which can join a run of `//` lines. */
  single: boolean;
}

/** Every comment in the file, in source order. */
function collectComments(source: ts.SourceFile): CommentSpan[] {
  const text = source.getFullText();
  const seen = new Set<number>();
  const spans: CommentSpan[] = [];
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      spans.push({
        startLine: source.getLineAndCharacterOfPosition(r.pos).line,
        endLine: source.getLineAndCharacterOfPosition(r.end).line,
        text: text.slice(r.pos, r.end),
        single: r.kind === ts.SyntaxKind.SingleLineCommentTrivia,
      });
    }
  };
  // Every token's leading trivia, plus each node's trailing trivia, covers
  // every comment, including ones inside JSX expression containers.
  const visit = (node: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return spans.sort((a, b) => a.startLine - b.startLine);
}

/** The comment text on `line` (0-based), then the comment ending directly above it. */
function commentFor(line: number, comments: readonly CommentSpan[]): string | null {
  const parts: string[] = [];
  for (const c of comments) {
    if (c.startLine <= line && c.endLine >= line) parts.push(c.text);
  }
  const above = comments.filter((c) => c.endLine === line - 1);
  if (above.length > 0) {
    // A run of `//` lines reads as one comment.
    const run: string[] = [];
    let next = line - 1;
    for (;;) {
      const onLine = comments.filter((c) => c.endLine === next);
      if (onLine.length === 0) break;
      run.unshift(...onLine.map((c) => c.text));
      const first = onLine[0]!;
      if (!first.single || !onLine.every((c) => c.single)) break;
      next = first.startLine - 1;
    }
    parts.push(...run);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function isAssertion(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function stripParens(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? stripParens(node.expression) : node;
}

/** Every `as unknown as T` (or `<T><unknown>x`) in one file. */
export function findUnsafeCasts(file: string, text: string): UnsafeCast[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split("\n");
  let comments: CommentSpan[] | null = null;
  const casts: UnsafeCast[] = [];
  const visit = (node: ts.Node): void => {
    if (isAssertion(node)) {
      const inner = stripParens(node.expression);
      if (isAssertion(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) {
        comments ??= collectComments(source);
        const { line } = source.getLineAndCharacterOfPosition(inner.type.getStart(source));
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const read = [...new Set([line, start])]
          .map((l) => commentFor(l, comments ?? []))
          .filter((c): c is string => c !== null);
        const comment = read.length > 0 ? read.join("\n") : null;
        casts.push({
          file,
          line: line + 1,
          snippet: (lines[line] ?? "").trim(),
          comment,
          ok: comment !== null && namesMismatch(comment),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return casts;
}

/** Every double cast under `scope` in `root`. Paths in the result are relative to `root`. */
export function scan(root: string, scope: readonly string[] = SCOPE): UnsafeCast[] {
  const casts: UnsafeCast[] = [];
  for (const dir of scope) {
    if (!existsSync(join(root, dir))) continue;
    for (const rel of new Glob("**/*.{ts,tsx}").scanSync({ cwd: join(root, dir) })) {
      const segments = rel.split(/[\\/]/);
      if (segments.includes("node_modules") || segments.includes("dist")) continue;
      const file = `${dir}/${segments.join("/")}`;
      casts.push(...findUnsafeCasts(file, readFileSync(join(root, file), "utf-8")));
    }
  }
  return casts;
}

if (import.meta.main) {
  const casts = scan(process.argv[2] ?? ROOT);
  const violations = casts.filter((c) => !c.ok);
  if (violations.length > 0) {
    console.error(
      `✗ Found ${violations.length} \`as unknown as\` cast(s) without a comment naming the mismatch:\n`,
    );
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    console.error(
      "\nRetype the value (a type guard, a schema parse, a typed helper, the SDK's own type), or put a comment on the cast's line or the line above naming what the value is and what the code claims. See CODE_STYLE.md, \"A double cast names its mismatch\".",
    );
    process.exit(1);
  }
  console.log(`✓ All ${casts.length} \`as unknown as\` cast(s) in scope name their mismatch`);
}
