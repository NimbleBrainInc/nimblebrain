#!/usr/bin/env bun
/**
 * Lint: workspace-scoped **write** gates go through
 * `useCanWriteActiveWorkspace` / `canWriteWorkspace`, never through the
 * `ScopedRole` ordering.
 *
 * `resolveScopedRole` (`web/src/hooks/useScopedRole.ts`) deliberately
 * escalates an org admin to `org_admin` *before* it reads the workspace
 * membership role, so `roleAtLeast(role, "ws_admin")` is true for an org
 * admin in every workspace. That is correct for **reach** — navigation,
 * route guards, read gates — where an org admin legitimately gets to any
 * workspace's settings.
 *
 * It is wrong for **writes**. The server's `canWriteWorkspaceScoped`
 * (`src/workspace/authz.ts`) requires membership with `role === "admin"`
 * and states outright that "`orgRole` is deliberately never consulted —
 * there is no org-admin bypass for workspace-scoped writes." A UI that
 * gates a mutation on the escalated role therefore offers controls the
 * server refuses, and the user discovers it on Save as a 403.
 *
 * That divergence shipped in four places before it was caught (the skills
 * vantage, the two connector pages, and workspace general settings), which
 * is why it is enforced structurally rather than by review.
 *
 * What this flags:
 *   Any `roleAtLeast(<expr>, "ws_admin")` call outside the hook module.
 *   The ordering itself is fine; asking it *this* question is not.
 *
 * What it allows:
 *   - `web/src/hooks/useScopedRole.ts` — defines the ordering, and its own
 *     tests exercise the `ws_admin` threshold directly.
 *   - A `// lint-ok:workspace-write-gate` marker on the line immediately
 *     above, for a genuine reach gate that happens to need the ws_admin
 *     threshold (e.g. showing a nav entry only to workspace admins, where
 *     an org admin *should* also see it).
 *
 * Scope: `web/src/**\/*.{ts,tsx}`, excluding tests — they deliberately
 * exercise the ordering, and the contrast test in `useScopedRole.test.ts`
 * has to call `roleAtLeast(…, "ws_admin")` to pin that reach and write
 * disagree. Matches the scope convention of the other repo lints. The
 * server enforces its own rule in `canWriteWorkspaceScoped`; this is about
 * the client agreeing with it.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const WEB_SRC = join(ROOT, "web", "src");

/** The module that owns the ordering — exempt by construction. */
const ALLOWED = new Set(["web/src/hooks/useScopedRole.ts"]);

/** Tests exercise the ordering on purpose; they are not gates. */
function isTest(relPath: string): boolean {
  return relPath.includes("__tests__/") || /\.test\.tsx?$/.test(relPath);
}

const MARKER = "lint-ok:workspace-write-gate";

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * True when the line above `pos` carries the opt-out marker. Matches the
 * escape-hatch convention the other repo lints use.
 */
function hasMarker(source: ts.SourceFile, pos: number): boolean {
  const { line } = source.getLineAndCharacterOfPosition(pos);
  if (line === 0) return false;
  const lines = source.getFullText().split("\n");
  return (lines[line - 1] ?? "").includes(MARKER);
}

/**
 * Flag `roleAtLeast(<anything>, "ws_admin")`.
 *
 * Matched on the AST rather than by regex so a string mentioning the call
 * in prose, or a differently-formatted call spanning lines, behaves the
 * way a reader would expect.
 */
function scanFile(absPath: string, relPath: string): Violation[] {
  const text = readFileSync(absPath, "utf-8");
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "roleAtLeast" &&
      node.arguments.length === 2
    ) {
      const required = node.arguments[1];
      if (
        required !== undefined &&
        ts.isStringLiteral(required) &&
        required.text === "ws_admin" &&
        !hasMarker(source, node.getStart(source))
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
          file: relPath,
          line: line + 1,
          text: node.getText(source).replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

function main(): void {
  const violations: Violation[] = [];
  let scanned = 0;

  for (const rel of new Glob("**/*.{ts,tsx}").scanSync(WEB_SRC)) {
    const abs = join(WEB_SRC, rel);
    const repoRel = relative(ROOT, abs);
    if (ALLOWED.has(repoRel) || isTest(repoRel)) continue;
    scanned += 1;
    violations.push(...scanFile(abs, repoRel));
  }

  if (violations.length > 0) {
    console.error("✗ Workspace-scoped write gates must not use the ScopedRole ordering.\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.text}`);
    }
    console.error(
      '\n  `roleAtLeast(role, "ws_admin")` is true for any org admin, but the server\'s',
    );
    console.error("  `canWriteWorkspaceScoped` grants them no bypass — so this offers controls");
    console.error("  the server refuses, surfacing as a 403 on save.\n");
    console.error("  Use `useCanWriteActiveWorkspace()` for write gates.");
    console.error(`  For a genuine reach gate, add \`// ${MARKER}\` on the line above.`);
    process.exit(1);
  }

  console.log(`✓ No ScopedRole-based workspace write gates in ${scanned} web/src/ files`);
}

main();
