#!/usr/bin/env bun
/**
 * Lint: the server runtime kernel (`src/`) must not import a branded
 * observability SDK.
 *
 * The kernel's observability is vendor-neutral OpenTelemetry — it depends only
 * on the open OTLP + W3C tracecontext wire formats so an operator can point it
 * at any collector and so the kernel never couples to a vendor's SDK ("the wire
 * is the interface"). Sentry's React SDK is the client SPA's tool and lives only
 * in `web/`; it must never leak into `src/`.
 *
 * What this flags: any `@sentry/...` import in `src/`. Comment lines are ignored.
 *
 * Scope: `src/**\/*.ts`. The web client (`web/`), scripts, and tests are out of
 * scope — `@sentry/react` belongs in `web/`.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");

const SENTRY_IMPORT = /(?:import|require)\s*[^;\n]*["']@sentry\//;

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
  const lines = readFileSync(absPath, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) continue;
    if (!SENTRY_IMPORT.test(line)) continue;
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
    console.error(`✗ Found ${violations.length} @sentry/* import(s) in the kernel (src/):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error("The kernel exports observability over the neutral OTLP/W3C wire — it must not");
    console.error("import a branded SDK. Sentry belongs to the web client (`web/`) only.");
    process.exit(1);
  }

  console.log(`✓ No @sentry/* imports in ${scanned} kernel src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
