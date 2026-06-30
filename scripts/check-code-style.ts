#!/usr/bin/env bun
/**
 * Lint: project-specific code-style rules.
 *
 * The rules themselves are documented in `CODE_STYLE.md` at the repo
 * root. This script enforces them — one detection pass per rule,
 * aggregated into a single pass/fail so all violations surface in one
 * run instead of one-at-a-time across re-runs.
 *
 * Adding a new rule:
 *   1. Document the rule in `CODE_STYLE.md` (anti-example, good example,
 *      rationale).
 *   2. Add a new check function below following the existing pattern —
 *      walk source files, collect violations, return a string array of
 *      formatted findings.
 *   3. Add the new check to `checks` in `main()`.
 *
 * Scope: `src/**\/*.ts` only. Tests and bundles are out of scope
 * (tests deliberately exercise edge cases; bundles run in subprocesses
 * with their own conventions).
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");

interface CheckResult {
  rule: string;
  violations: string[];
}

/**
 * Rule: No inline type imports.
 *
 * Pattern: `import("path").TypeName` in a type position. Equivalent to
 * top-level `import type { TypeName } from "path"` at compile time,
 * but reads as a runtime dynamic import and trips readers.
 *
 * Detection: TypeScript AST walk for `ImportTypeNode`. The AST kind
 * `ts.SyntaxKind.ImportType` is precisely the inline-type-import shape
 * — runtime dynamic imports (`await import("...")`) parse as
 * `CallExpression` and are not caught. AST-level matching avoids
 * regex false-positives.
 */
function checkNoInlineTypeImports(): CheckResult {
  const violations: string[] = [];
  const glob = new Glob("**/*.ts");

  for (const file of glob.scanSync({ cwd: SRC_ROOT, absolute: true })) {
    // Never lint vendored dependencies. Some bundle UIs install their own
    // node_modules under src/bundles/<name>/ui/ (gitignored, local-only);
    // those third-party .d.ts files are full of inline type imports we
    // don't own, and they don't exist in CI's fresh checkout — so without
    // this skip the check passes in CI but fails on a developer's machine.
    if (file.split(/[\\/]/).includes("node_modules")) continue;
    const rel = relative(ROOT, file);
    // Skip bundle subtrees (their UIs have their own conventions, per the
    // doc comment) and vendored deps. `bun run build:bundles` installs
    // node_modules under each bundle's UI, so an unfiltered walk picks
    // up thousands of vendored `.d.ts` violations that have nothing to
    // do with our source.
    if (rel.includes("/node_modules/")) continue;
    if (rel.startsWith("src/bundles/")) continue;
    const content = readFileSync(file, "utf-8");
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node): void {
      if (ts.isImportTypeNode(node)) {
        const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart());
        // Walk up to find the enclosing statement so the formatted
        // finding includes useful context.
        const lineText = content.split("\n")[line]?.trim() ?? "";
        violations.push(`  ${rel}:${line + 1}  ${lineText}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  return { rule: "no-inline-type-imports", violations };
}

/**
 * Rule: Containment tags may only be opened through `wrapContained`.
 *
 * `src/prompt/compose.ts` wraps untrusted body content (bundle authors,
 * tenant skills, workspace overlays) in XML containment tags before it
 * crosses into the trusted system prompt. The open tag, the escaped close
 * form, and the trailing close must all derive from the single `tag`
 * argument of `wrapContained` so they cannot diverge — that is the
 * structural guarantee that closes the prompt-injection breakout class.
 *
 * This pass makes the guarantee enforceable: no `ContainmentTag` literal may
 * appear as an XML open (`<tag>`), a close (`</tag>`), or in a hand-rolled
 * escape (`.replaceAll("</tag>", …)` / `.replace(/<\/tag/, …)`) anywhere in
 * `compose.ts` EXCEPT inside the body of `wrapContained` itself. Any other
 * occurrence means someone opened a containment fence by hand — the exact
 * mistake that shipped two live breakouts before this primitive existed.
 *
 * The tag allow-list is derived from the `ContainmentTag` union in the same
 * file, so adding a tag to the union automatically extends the check — the
 * rule and the type stay in lockstep with zero manual upkeep.
 */
const COMPOSE_REL = "src/prompt/compose.ts";

/**
 * Extract the string-literal members of the `ContainmentTag` union from the
 * AST so the lint's allow-list is the union (single source of truth).
 */
function extractContainmentTags(source: ts.SourceFile): string[] {
  const tags: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "ContainmentTag" &&
      ts.isUnionTypeNode(node.type)
    ) {
      for (const member of node.type.types) {
        if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
          tags.push(member.literal.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return tags;
}

function checkContainmentTagOpens(): CheckResult {
  const rule = "containment-tags-via-wrapContained";

  // The `ContainmentTag` union and `wrapContained` live in compose.ts; derive
  // the allow-list from the union there so the rule and the type stay in
  // lockstep. The check itself scans EVERY source file — a hand-rolled open in
  // any other module (e.g. the `effective_context` tool's historical branch)
  // is the same breakout class, so the guarantee is only structural if the
  // scan is project-wide rather than one hardcoded file.
  const composeFile = join(SRC_ROOT, "prompt", "compose.ts");
  const composeContent = readFileSync(composeFile, "utf-8");
  const composeSource = ts.createSourceFile(
    composeFile,
    composeContent,
    ts.ScriptTarget.Latest,
    true,
  );
  const tags = extractContainmentTags(composeSource);
  if (tags.length === 0) {
    return {
      rule,
      violations: [`  ${COMPOSE_REL}  could not find ContainmentTag union to derive allow-list`],
    };
  }

  // Matches an open `<tag>`, a close `</tag>`, or a regex-escaped close
  // `<\/tag` — case-insensitive and whitespace-tolerant, the same surface the
  // escape itself normalises. `<\\?` tolerates the backslash a regex literal
  // (`/<\/app-state>/`) carries in its source text.
  const tagAlt = tags.map((t) => t.replace(/[-]/g, "\\-")).join("|");
  const detector = new RegExp(`<\\\\?\\s*/?\\s*(?:${tagAlt})\\b`, "i");

  const violations: string[] = [];
  const glob = new Glob("**/*.ts");
  for (const file of glob.scanSync({ cwd: SRC_ROOT, absolute: true })) {
    const rel = relative(ROOT, file);
    // Skip vendored deps and bundle subtrees, matching the other passes.
    if (rel.includes("/node_modules/") || rel.startsWith("src/bundles/")) continue;
    const content = file === composeFile ? composeContent : readFileSync(file, "utf-8");
    const source =
      file === composeFile
        ? composeSource
        : ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

    // The literal tags are allowed in exactly one place: the body of
    // `wrapContained` (the open, the escaped close, and the close all live
    // there). That exclusion exists only in the file that defines the
    // primitive; everywhere else any containment-tag literal is a violation.
    let allowedStart = -1;
    let allowedEnd = -1;
    function findWrap(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "wrapContained" && node.body) {
        allowedStart = node.body.getStart(source);
        allowedEnd = node.body.getEnd();
      }
      ts.forEachChild(node, findWrap);
    }
    findWrap(source);

    function visit(node: ts.Node): void {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        ts.isRegularExpressionLiteral(node)
      ) {
        const start = node.getStart(source);
        const inWrap = allowedStart >= 0 && start >= allowedStart && node.getEnd() <= allowedEnd;
        if (!inWrap && detector.test(node.getText(source))) {
          const { line } = ts.getLineAndCharacterOfPosition(source, start);
          const lineText = content.split("\n")[line]?.trim() ?? "";
          violations.push(`  ${rel}:${line + 1}  ${lineText}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  return { rule, violations };
}

function main(): void {
  const checks: CheckResult[] = [checkNoInlineTypeImports(), checkContainmentTagOpens()];

  let totalViolations = 0;
  for (const { rule, violations } of checks) {
    if (violations.length === 0) {
      console.log(`  ✓ ${rule}: clean`);
      continue;
    }
    totalViolations += violations.length;
    console.error(`  × ${rule}: ${violations.length} violation(s)`);
    console.error("    See CODE_STYLE.md for the rule and refactor guidance.");
    for (const v of violations) console.error(v);
  }

  if (totalViolations > 0) {
    console.error(`\n${totalViolations} code-style violation(s) total.`);
    process.exit(1);
  }
}

main();
