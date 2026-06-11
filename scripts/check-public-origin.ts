#!/usr/bin/env bun
/**
 * Lint: `publicOrigin()` is the single source of the tenant's public origin.
 *
 * "What is this tenant's public origin?" used to be smeared across `NB_API_URL`,
 * `NB_WEB_URL`, `WORKOS_REDIRECT_URI`, and `ALLOWED_ORIGINS[0]` — values that had
 * to agree by hand and didn't (custom-domain tenants 401'd their OAuth return
 * leg). `src/oauth/public-origin.ts` now owns the derivation. To keep it the
 * floor, the legacy origin env vars may be read in exactly one place.
 *
 * What this flags: any `process.env.NB_API_URL` or `process.env.NB_WEB_URL` read
 * in `src/` outside `src/oauth/public-origin.ts`. Use `publicOrigin()` (for
 * vendor/OAuth callback URLs) or `webOrigin()` (for user-facing SPA returns)
 * instead.
 *
 * Allowed: `src/oauth/public-origin.ts` (the sanctioned reader), and a
 * `// lint-ok:public-origin` marker on the line above a genuinely exceptional
 * read.
 *
 * Scope: `src/**\/*.ts`. Scripts and tests are out of scope.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:public-origin";

/** The one sanctioned reader of the legacy origin env vars. */
const ALLOWED_FILES: ReadonlySet<string> = new Set<string>(
  ["oauth/public-origin.ts"].map((f) => f.split("/").join(sep)),
);

/** Forbidden env reads — the raw origin vars `publicOrigin()` centralizes. */
const FORBIDDEN = /process\.env\.(NB_API_URL|NB_WEB_URL)\b/;

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(absPath: string, violations: Violation[]): void {
  const relPath = relative(SRC_ROOT, absPath);
  if (ALLOWED_FILES.has(relPath)) return;
  const lines = readFileSync(absPath, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!FORBIDDEN.test(line)) continue;
    const prev = (lines[i - 1] ?? "").trim();
    if (prev.includes(ALLOW_MARKER)) continue;
    violations.push({ file: relative(ROOT, absPath), line: i + 1, snippet: line.trim() });
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
    console.error(`✗ Found ${violations.length} raw public-origin env read(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "The public origin is derived in `src/oauth/public-origin.ts`. Use `publicOrigin()`",
    );
    console.error(
      "for vendor/OAuth callback URLs or `webOrigin()` for user-facing SPA returns — not raw",
    );
    console.error(`NB_API_URL / NB_WEB_URL. Rare exceptions need a // ${ALLOW_MARKER} comment above.`);
    process.exit(1);
  }

  console.log(`✓ No raw public-origin env reads in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
