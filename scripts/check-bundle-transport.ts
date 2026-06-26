#!/usr/bin/env bun
/**
 * Lint: bundles must use @nimblebrain/synapse for postMessage envelopes.
 *
 * Bundle UIs (`src/bundles/<name>/ui/src/`) talk to the host iframe bridge
 * via the SDK. The bridge validates every inbound envelope against
 * `web/src/bridge/schemas.ts`; an envelope built by hand can drift from
 * the schema and silently break (this is exactly the bug that motivated
 * the SDK migration). Forcing all transport through the SDK structurally
 * rules out that class of bug.
 *
 * What this script flags: any `CallExpression` whose callee is
 * `<receiver>.postMessage(...)` where the receiver chain contains
 * `parent` or `top`. That covers `window.parent.postMessage(...)`,
 * `parent.postMessage(...)`, `globalThis.parent.postMessage(...)`, etc.
 *
 * What it allows:
 *   - `synapse.callTool / synapse.action / useCallTool` — typed SDK paths
 *   - `window.postMessage(...)` — to-self, not to host
 *   - A `// lint-ok:bundle-transport` marker on the line immediately
 *     above a violating call. The only legitimate use today is
 *     home's `callServerTool` for cross-server internal-app calls; the
 *     SDK doesn't expose `params.server` because it isn't part of the
 *     ext-apps spec.
 *
 * Scope: only `src/bundles/* /ui/**` is scanned. Server code under
 * `src/bundles/* /src/` doesn't postMessage to anyone.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const BUNDLES_ROOT = join(ROOT, "src/bundles");
const ALLOW_MARKER = "lint-ok:bundle-transport";

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

/**
 * Returns true iff `node` is a call to `<receiver>.postMessage(...)` where
 * the receiver chain reaches `parent` or `top`. Examples that match:
 *   parent.postMessage(...)
 *   window.parent.postMessage(...)
 *   globalThis.parent.postMessage(...)
 *   window.top.postMessage(...)
 *
 * Examples that do NOT match:
 *   window.postMessage(...)        // to-self
 *   channel.port1.postMessage(...) // MessageChannel, not host
 *   socket.postMessage(...)        // arbitrary other API
 */
function isHostPostMessage(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "postMessage") return false;

  let receiver: ts.Expression = node.expression.expression;
  while (true) {
    if (ts.isPropertyAccessExpression(receiver)) {
      if (receiver.name.text === "parent" || receiver.name.text === "top") return true;
      receiver = receiver.expression;
    } else if (ts.isIdentifier(receiver)) {
      return receiver.text === "parent" || receiver.text === "top";
    } else {
      return false;
    }
  }
}

/**
 * Allow an explicit escape comment on the line immediately above the call.
 * Multiple lines of allow are tolerated (consecutive comment lines), but
 * any non-comment line breaks the chain.
 */
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
      continue; // keep walking up through comments / blank lines
    }
    return false; // hit a code line without seeing the marker
  }
  return false;
}

async function scanFile(absPath: string, violations: Violation[]): Promise<void> {
  const src = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isHostPostMessage(node)) {
      if (!hasAllowMarker(node, sourceFile, src)) {
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
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const glob = new Glob("*/ui/src/**/*.{ts,tsx}");
  let scanned = 0;

  for await (const rel of glob.scan({ cwd: BUNDLES_ROOT })) {
    const abs = join(BUNDLES_ROOT, rel);
    if (abs.includes("/node_modules/") || abs.includes("/dist/")) continue;
    scanned++;
    await scanFile(abs, violations);
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} raw postMessage call(s) in bundle UIs:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error("Bundle UIs must construct postMessage envelopes via @nimblebrain/synapse.");
    console.error("Legitimate exceptions (e.g. internal-app cross-server calls) require a");
    console.error(`  // ${ALLOW_MARKER}\n  comment on the line above the call.`);
    process.exit(1);
  }

  console.log(`✓ No raw postMessage in ${scanned} bundle UI files`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
