#!/usr/bin/env bun
/**
 * Lint: credentials live with their owner — the workspace for shared
 * connectors, the identity for personal ones.
 *
 * Stage 2 moved workspace-shared credentials onto the workspace at
 * `{workDir}/workspaces/<wsId>/credentials/...`, reached only through
 * `WorkspaceContext` or the primitives in `src/config/workspace-credentials.ts`.
 * A hand-built `join(..., "users", X, "credentials", ...)` is a regression: a
 * shared-connector credential would land off the workspace.
 *
 * The exceptions are the identity plane's personal-connector credential homes. A
 * **personal connector** (a user's own remote MCP connection, reachable across
 * their workspaces) owns its credentials outside any workspace, so leaving one
 * never orphans them:
 *   - `users/<userId>/credentials/mcp-oauth/<serverName>/` — the `{type:"user"}`
 *     WorkspaceOAuthProvider arm (OAuth tokens for a DCR/static connector).
 *   - `users/<userId>/credentials/composio/<connector>/` — the personal Composio
 *     connection home (opaque `connectedAccountId`; the `{type:"user"}` arm of
 *     `composioConnectorDir`).
 * Those exact shapes are allowed; every other `users/<id>/credentials/...` stays
 * banned.
 *
 * What this script flags (all EXCEPT the carve-outs above):
 *   - `join(...)` with the adjacency `"users", <id>, "credentials"`.
 *   - Template / string literals containing `users/<...>/credentials/`.
 *
 * What it allows:
 *   - `users/<id>/credentials/{mcp-oauth,composio}/...` — the identity-connector
 *     credential homes.
 *   - A `// lint-ok:credential-path` marker on the line immediately above the
 *     construction, for the rare case the typed helper genuinely doesn't apply.
 *
 * Blind spot, by design: `WorkspaceOAuthProvider` builds BOTH owners' paths
 * through one `join(workDir, ownerSegment, ownerId, "credentials", ...)` where
 * `ownerSegment` is a *variable* (`"workspaces"` | `"users"`). The AST matchers
 * can't flag the "users" case there without false-positiving the workspace
 * case, so that single audited constructor is intentionally invisible to this
 * lint; the lint guards against NEW literal reintroductions elsewhere.
 *
 * Scope: `src/**\/*.ts`. Scripts and tests are out of scope.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:credential-path";

/**
 * Matches a banned `users/<id>/credentials/…` path, EXCEPT the sanctioned
 * identity-connector homes, where a personal connector's credentials live
 * (owned by the user, outside any workspace):
 *   - `users/<id>/credentials/mcp-oauth/…` — the `{type:"user"}`
 *     WorkspaceOAuthProvider arm (OAuth tokens for a DCR/static connector).
 *   - `users/<id>/credentials/composio/…` — the personal Composio connection
 *     home (the opaque `connectedAccountId`; the `{type:"user"}` owner arm of
 *     `composioConnectorDir`).
 * The negative lookahead is the whole carve-out: a bare `credentials` dir or any
 * child outside that set is still a regression.
 */
const USER_CREDENTIAL_PATH_RE =
  /users\/[^/]+\/credentials(?:$|\/(?!(?:mcp-oauth|composio)(?:\/|$)))/;

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
/** A `join` arg that is the string (or no-substitution template) literal `text`. */
function isLiteralSegment(node: ts.Node | undefined, text: string): boolean {
  return (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text === text
  );
}

export function isUserCredentialJoin(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (calleeName !== "join") return false;

  const args = node.arguments;
  // Need the adjacency `"users", <userId>, "credentials"`.
  for (let i = 0; i < args.length - 2; i++) {
    if (!isLiteralSegment(args[i], "users") || !isLiteralSegment(args[i + 2], "credentials")) {
      continue;
    }
    // Carve-out: the sanctioned identity-owned personal-connector credential
    // homes — `mcp-oauth` (OAuth tokens, the `{type:"user"}`
    // WorkspaceOAuthProvider arm) and `composio` (the opaque
    // `connectedAccountId`). Everything else under `users/<id>/credentials/`
    // stays banned. Keep this set in sync with `USER_CREDENTIAL_PATH_RE`.
    if (isLiteralSegment(args[i + 3], "mcp-oauth") || isLiteralSegment(args[i + 3], "composio")) {
      continue;
    }
    return true;
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
  return USER_CREDENTIAL_PATH_RE.test(assembled);
}

/**
 * Returns true for a string literal whose text contains the substring
 * `users/<...>/credentials/`. Catches hard-coded path fragments.
 */
export function isUserCredentialStringLiteral(node: ts.StringLiteral): boolean {
  return USER_CREDENTIAL_PATH_RE.test(node.text);
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
      "Workspace-shared credentials live at `workspaces/<wsId>/credentials/...` — route",
    );
    console.error("through `WorkspaceContext` (`runtime.getWorkspaceContext(wsId)`) or the");
    console.error("primitives in `src/config/workspace-credentials.ts`.");
    console.error("The ONLY user-scoped exception is a personal connector's OAuth tokens at");
    console.error('`users/<userId>/credentials/mcp-oauth/<serverName>/` (the {type:"user"} arm).');
    console.error(
      `Other legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above.`,
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
