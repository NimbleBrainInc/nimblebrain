#!/usr/bin/env bun
/**
 * Lint: conversations are workspace-owned — never built at the flat top level.
 *
 * A conversation lives under the workspace (workspace) it runs in, with the owner
 * as a privacy sub-partition:
 *
 *   workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl          private user chats
 *   workspaces/<wsId>/conversations/_runs/<automationId>/<convId>.jsonl  automation runs
 *
 * The flat `{workDir}/conversations/<convId>.jsonl` layout is gone. Any new
 * occurrence of the flat construction — joining `"conversations"` directly onto
 * a workDir-ish root, or spelling `…/conversations/…` outside a
 * `workspaces/<wsId>/` subtree — is a regression: it drops the workspace wall the
 * permission model depends on.
 *
 * What this script flags: a `join(...)` whose `"conversations"` segment is NOT
 * qualified by a workspace root before it (neither a literal `"workspaces",
 * <wsId>` pair nor a workspace-scoped base like `this.workspacesRoot` /
 * `getWorkspaceScopedDir()`), and the equivalent flat template / string-literal
 * path. The workspace-partitioned shape is the required, allowed shape.
 *
 * What it allows:
 *   - `src/conversation/paths.ts` — the single sanctioned construction (and
 *     parse) site for the `workspaces/<wsId>/conversations/...` layout. It *is*
 *     the definition this lint protects.
 *   - `scripts/migrate-conversations-to-workspace.ts` — it must read the legacy flat
 *     `{workDir}/conversations/<id>.jsonl` SOURCE paths in order to move them
 *     into the workspace-owned layout.
 *   - Workspace-scoped joins off a workspace root (`join(this.workspacesRoot, wsId,
 *     "conversations")`) — the `"conversations"` segment is already under a
 *     workspace, so these are the intended shape, not the flat one.
 *   - A `// lint-ok:conversation-path` marker on the line immediately above the
 *     construction, for the rare future case the typed helpers don't cover.
 *
 * Scope: `src/**\/*.ts`. Tests are out of scope (migration tests deliberately
 * construct the flat source paths to assert the migration moves them away).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:conversation-path";

// Files (relative to repo root) that legitimately reference the flat layout —
// either because they DEFINE the workspace-owned layout, or because they migrate
// data off the flat one. The lint would otherwise fight the definitions it
// exists to protect.
const ALLOWED_FILES = new Set(
  [
    // The single sanctioned site that builds + parses the workspace-owned
    // `workspaces/<wsId>/conversations/...` layout.
    "src/conversation/paths.ts",
    // Migrates conversations off the flat layout — reads the old
    // `{workDir}/conversations/<id>.jsonl` source paths to relocate them.
    "scripts/migrate-conversations-to-workspace.ts",
  ].map((f) => f.split("/").join(sep)),
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

/** The static string value of a string / no-substitution-template literal, else `null`. */
function staticText(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

const WORKSPACE_RE = /workspace/i;

/**
 * True iff `node` carries a workspace-root signal — a `"workspaces"`-ish string
 * literal, or an identifier / property / call whose name references a workspace
 * (`this.workspacesRoot`, `getWorkspaceScopedDir()`, …). Used to decide whether
 * a `"conversations"` segment is already workspace-scoped (qualified by a workspace)
 * rather than flat.
 */
function referencesWorkspaces(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const text = staticText(node);
  if (text !== null) return WORKSPACE_RE.test(text);
  if (ts.isIdentifier(node)) return WORKSPACE_RE.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return WORKSPACE_RE.test(node.name.text);
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    return name !== null && WORKSPACE_RE.test(name);
  }
  return false;
}

/** True iff any argument before `idx` qualifies the path with a workspace root. */
function hasWorkspaceQualifierBefore(args: ts.NodeArray<ts.Expression>, idx: number): boolean {
  for (let i = 0; i < idx; i++) {
    if (referencesWorkspaces(args[i])) return true;
  }
  return false;
}

/**
 * Returns true iff `node` is `join(...)` building a FLAT conversations path —
 * a `"conversations"` string-literal argument that is NOT qualified by a
 * workspace root before it. `join(workDir, "conversations", file)` flags;
 * `join(workDir, "workspaces", wsId, "conversations", file)` and
 * `join(this.workspacesRoot, wsId, "conversations")` do not (already
 * workspace-scoped).
 *
 * Exported for the self-test under `test/unit/scripts/`.
 */
export function isFlatConversationJoin(node: ts.CallExpression): boolean {
  if (calleeName(node) !== "join") return false;
  const args = node.arguments;
  for (let j = 0; j < args.length; j++) {
    if (staticText(args[j]) !== "conversations") continue;
    if (!hasWorkspaceQualifierBefore(args, j)) return true;
  }
  return false;
}

/** A `conversations` path segment anywhere in an assembled path. */
const CONV_SEGMENT_RE = /(^|\/)conversations(\/|$)/;
/** The workspace-owned shape: `workspaces/<id>/conversations`. */
const ROOM_CONV_RE = /workspaces\/[^/]+\/conversations(\/|$)/;
/** A flat conversation FILE literal: `…/conversations/<convId>.jsonl`. */
const FLAT_CONV_FILE_RE = /(^|\/)conversations\/[^/]+\.jsonl$/;

/**
 * Returns true iff `node` is a template literal that spells a FLAT
 * `…/conversations/…` path — a `conversations` segment NOT under
 * `workspaces/<id>/`. Catches the
 * `` `${workDir}/conversations/${id}.jsonl` `` shape that `join` would
 * otherwise express piecewise.
 *
 * Exported for the self-test under `test/unit/scripts/`.
 */
export function isFlatConversationTemplate(node: ts.TemplateExpression): boolean {
  let assembled = node.head.text;
  for (const span of node.templateSpans) {
    // Placeholder so adjacency-matching works on the literal text between
    // substitutions.
    assembled += "<expr>";
    assembled += span.literal.text;
  }
  if (!CONV_SEGMENT_RE.test(assembled)) return false;
  return !ROOM_CONV_RE.test(assembled);
}

/**
 * Returns true iff `node` is a string literal hardcoding a FLAT conversation
 * file path (`…/conversations/<id>.jsonl` not under `workspaces/<id>/`).
 * Resource URIs (`ui://conversations/browser`) and package routes
 * (`@scope/conversations`) share the token but aren't on-disk layout, so they
 * don't match.
 *
 * Exported for the self-test under `test/unit/scripts/`.
 */
export function isFlatConversationStringLiteral(node: ts.StringLiteral): boolean {
  const text = node.text;
  if (text.includes("://")) return false;
  if (!FLAT_CONV_FILE_RE.test(text)) return false;
  return !ROOM_CONV_RE.test(text);
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
  const relPath = relative(ROOT, absPath);
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
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: relative(ROOT, absPath),
      line: line + 1,
      column: character + 1,
      snippet: (src.split("\n")[line] ?? "").trim(),
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isFlatConversationJoin(node)) {
      record(node);
    } else if (ts.isTemplateExpression(node) && isFlatConversationTemplate(node)) {
      record(node);
    } else if (ts.isStringLiteral(node) && isFlatConversationStringLiteral(node)) {
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
    console.error(`✗ Found ${violations.length} flat conversation path(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Conversations are workspace-owned: `workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl`.",
    );
    console.error(
      "Build the directory via `workspaceConversationsDir()` (src/conversation/paths.ts) or the runtime's workspace conversation store — never the flat `conversations/` path.",
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
    );
    process.exit(1);
  }

  console.log(`✓ No flat conversation paths in ${scanned} src/ files`);
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
