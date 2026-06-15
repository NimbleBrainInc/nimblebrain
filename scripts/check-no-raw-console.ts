#!/usr/bin/env bun
/**
 * Lint: operational code logs through the structured logger, not raw `console.*`.
 *
 * `src/cli/log.ts` is the one logger. In a deployed pod (`NB_LOG_FORMAT=json`) it
 * emits structured JSON auto-enriched with `service` / `tenant_id` /
 * `correlation_id` (the active trace id) / identity, so logs pivot to traces and
 * are queryable per tenant in Loki. A raw `console.error` / `console.warn` /
 * `console.log` bypasses all of that — it lands as an unstructured line with no
 * correlation. So operational code must call `log.*`.
 *
 * What this flags: any `console.(error|warn|log|info|debug)(...)` CALL in `src/`
 * outside the allowlist below. Comment lines (mentioning `console.log` in prose)
 * are ignored.
 *
 * Allowed (console is the right tool there): the logger itself, the CLI command
 * surfaces (`cli/commands.ts` + `cli/commands/**` — user-facing terminal
 * output), the console/debug EventSinks (their whole job is to print events),
 * the `sync-models` CLI script, and `briefing-debug`. A genuinely exceptional
 * call elsewhere needs a `// lint-ok:console` marker on the line above.
 *
 * Scope: `src/**\/*.ts`. Scripts and tests are out of scope.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:console";

/** Files where raw `console.*` is the correct, sanctioned output. */
const ALLOWED_FILES: ReadonlySet<string> = new Set<string>(
  [
    "cli/log.ts",
    "cli/commands.ts",
    "adapters/console-events.ts",
    "adapters/debug-events.ts",
    "model/sync-models.ts",
    "services/briefing-debug.ts",
  ].map((f) => f.split("/").join(sep)),
);

/** Directory prefixes where console output is sanctioned (CLI command surfaces). */
const ALLOWED_DIR_PREFIXES: readonly string[] = [`cli${sep}commands${sep}`];

const CONSOLE_CALL = /console\.(error|warn|log|info|debug)\s*\(/;

/** Trimmed line that is purely a comment (so prose mentioning console is ignored). */
function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*/")
  );
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(absPath: string, violations: Violation[]): void {
  const relPath = relative(SRC_ROOT, absPath);
  if (ALLOWED_FILES.has(relPath)) return;
  if (ALLOWED_DIR_PREFIXES.some((p) => relPath.startsWith(p))) return;
  const lines = readFileSync(absPath, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) continue;
    if (!CONSOLE_CALL.test(line)) continue;
    const prev = (lines[i - 1] ?? "").trim();
    if (prev.includes(ALLOW_MARKER)) continue;
    violations.push({ file: relative(ROOT, absPath), line: i + 1, snippet: trimmed });
  }
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
    console.error(`✗ Found ${violations.length} raw console.* call(s) in operational src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error("Operational code must log through `log` from `src/cli/log.ts` so lines are");
    console.error("structured JSON with tenant_id + correlation_id in deployed pods. CLI command");
    console.error(`output is exempt; a rare exception needs a // ${ALLOW_MARKER} comment above.`);
    process.exit(1);
  }

  console.log(`✓ No raw console.* in ${scanned} operational src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
