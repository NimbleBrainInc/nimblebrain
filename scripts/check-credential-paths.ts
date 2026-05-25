#!/usr/bin/env bun
/**
 * Lint: credentials live in the workspace, not the user.
 *
 * Stage 2 of the cross-workspace refactor moved user-scoped credentials
 * from `{workDir}/users/<userId>/credentials/...` onto the user's
 * personal workspace at `{workDir}/workspaces/ws_user_<userId>/credentials/...`.
 * Every credential read/write in `src/` now resolves through
 * `WorkspaceContext` (which routes through `WORKSPACE_ID_RE`) or its
 * primitive consumers in `src/config/workspace-credentials.ts`. Any new
 * occurrence of `join(..., "users", X, "credentials", ...)` is a
 * regression — credentials would end up off the workspace and out of
 * reach of the personal-workspace migration.
 *
 * What this script flags:
 *   - `join(...)` calls whose argument list contains the adjacency
 *     `"users", <userId>, "credentials"`.
 *   - Template literals whose assembled text contains
 *     `users/<...>/credentials/`.
 *   - String literals containing the substring `users/<...>/credentials/`.
 *
 * What it allows:
 *   - `scripts/migrate-user-creds-to-personal-workspace.ts` — the
 *     migration script that reads the legacy layout to move credentials
 *     to the workspace layout. Allowlisted in `ALLOWED_SCRIPTS`, but
 *     `src/`-only scope already excludes it.
 *   - A `// lint-ok:credential-path` marker on the line immediately
 *     above the construction, for the rare future case where the typed
 *     helper genuinely doesn't apply.
 *
 * Scope: `src/**\/*.ts`. Scripts are explicitly out of scope (the
 * migration script is the only legitimate consumer). Tests are also out
 * of scope (legacy migration tests construct the old shape deliberately).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:credential-path";

// Files within `src/` that legitimately reference the legacy
// `users/<userId>/credentials/...` shape. Stage-2 deletion of
// `UserConnectorStore` left zero such files; the set is empty by design.
// The matching scripts/ allowlist (the migration script) is enforced
// implicitly by `src/`-only scope — we never scan scripts/.
const ALLOWED_FILES: ReadonlySet<string> = new Set<string>(
  ([] as string[]).map((f) => f.split("/").join(sep)),
);

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

// ── Construction predicates ────────────────────────────────────────

/**
 * Returns true iff `node` is `join(...)` whose args contain the
 * adjacency `"users", <userId>, "credentials"`. The `<userId>` slot
 * accepts any non-literal (identifier, property access, etc.) — the
 * lint is about the user-scoped-credential pattern, not the specific
 * userId expression.
 *
 * Mirrors `isWorkspaceConversationJoin` in shape so the codebase
 * has one convention for path-adjacency lints.
 *
 * Exported for the self-test under `test/unit/scripts/`.
 */
export function isUserCredentialJoin(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (calleeName !== "join") return false;

  const args = node.arguments;
  // Need three adjacent positions: "users", <userId>, "credentials".
  for (let i = 0; i < args.length - 2; i++) {
    const a = args[i];
    const b = args[i + 1];
    const c = args[i + 2];
    if (!a || !b || !c) continue;
    const aIsUsers =
      (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "users";
    const cIsCredentials =
      (ts.isStringLiteral(c) || ts.isNoSubstitutionTemplateLiteral(c)) && c.text === "credentials";
    if (aIsUsers && cIsCredentials) return true;
  }
  return false;
}

/**
 * Returns true iff `node` is a template literal whose assembled text
 * contains the substring `users/<...>/credentials/`. Catches the
 * `` `${workDir}/users/${userId}/credentials/${bundleName}` `` shape
 * that `join` would otherwise express piecewise.
 */
export function isUserCredentialTemplate(node: ts.TemplateExpression): boolean {
  let assembled = node.head.text;
  for (const span of node.templateSpans) {
    // Placeholder so adjacency-matching works on the literal text
    // between substitutions. Same convention as
    // `check-conversation-paths.ts`.
    assembled += "<expr>";
    assembled += span.literal.text;
  }
  return /users\/[^/]+\/credentials(\/|$)/.test(assembled);
}

/**
 * Returns true for a string literal whose text contains the substring
 * `users/<...>/credentials/`. Catches hard-coded path fragments.
 */
export function isUserCredentialStringLiteral(node: ts.StringLiteral): boolean {
  return /users\/[^/]+\/credentials(\/|$)/.test(node.text);
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
    if (ts.isCallExpression(node) && isUserCredentialJoin(node)) {
      record(node, '`join(..., "users", X, "credentials", ...)` shape');
    } else if (ts.isTemplateExpression(node) && isUserCredentialTemplate(node)) {
      record(node, "template literal builds `users/<id>/credentials/...` shape");
    } else if (ts.isStringLiteral(node) && isUserCredentialStringLiteral(node)) {
      record(node, "string literal contains `users/<id>/credentials/...` substring");
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
    console.error(`✗ Found ${violations.length} user-scoped credential path(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Stage 2: credentials live in the workspace at `workspaces/<wsId>/credentials/...` —",
    );
    console.error("not on the user. Route through `WorkspaceContext` (constructed via");
    console.error(
      "`runtime.getWorkspaceContext(wsId)`) or the primitives in `src/config/workspace-credentials.ts`.",
    );
    console.error(
      "Personal-workspace credentials live at `workspaces/ws_user_<userId>/credentials/...`,",
    );
    console.error("constructed via `personalWorkspaceIdFor(userId)`.");
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
    );
    process.exit(1);
  }

  console.log(`✓ No user-scoped credential paths in ${scanned} src/ files`);
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
