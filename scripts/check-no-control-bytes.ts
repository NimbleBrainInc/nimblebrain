#!/usr/bin/env bun
/**
 * Lint: source files contain no raw C0 control bytes — use an escape instead.
 *
 * A raw control byte in a `.ts` source (e.g. a NUL used as a string-join
 * delimiter) passes tsc, biome, AND the test suite, but silently breaks tooling:
 * ripgrep / git grep classify the whole file as *binary* and skip it, and git's
 * diff renders it as text only by luck (its binary heuristic scans just the first
 * ~8 KB), so the diff misrepresents what actually ships. Write the source escape
 * (`\u0000`, `\t`, …) — the runtime string is byte-identical and the file stays
 * greppable text.
 *
 * Flags any byte in 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, or 0x7F. Tab (0x09),
 * newline (0x0A), and carriage return (0x0D) are allowed.
 *
 * Scope: `src/` *.ts and *.tsx. (web/ has its own toolchain; scripts/ and tests are out of scope.)
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");

/** Disallowed C0 controls + DEL. Tab (9), newline (10), carriage return (13) are fine. */
function isDisallowed(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code <= 0x1f || code === 0x7f;
}

interface Violation {
  file: string;
  line: number;
  col: number;
  code: number;
}

function scanFile(absPath: string, violations: Violation[]): void {
  const text = readFileSync(absPath, "utf-8");
  let line = 1;
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      line++;
      col = 0;
      continue;
    }
    col++;
    if (isDisallowed(code)) {
      violations.push({ file: relative(ROOT, absPath), line, col, code });
    }
  }
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  let scanned = 0;

  for await (const rel of glob.scan({ cwd: SRC_ROOT })) {
    const abs = join(SRC_ROOT, rel);
    if (abs.includes("/node_modules/") || abs.includes("/dist/")) continue;
    scanned++;
    scanFile(abs, violations);
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} raw control byte(s) in src/:\n`);
    for (const v of violations) {
      const hex = v.code.toString(16).padStart(4, "0").toUpperCase();
      console.error(`  ${v.file}:${v.line}:${v.col}  U+${hex}`);
    }
    console.error(
      "\nA raw control byte makes the file read as binary to rg/git grep (they skip it)",
    );
    console.error(
      "and lets the diff misrepresent what ships. Use the source escape (e.g. \\u0000):",
    );
    console.error("the runtime string is identical and the file stays greppable text.");
    process.exit(1);
  }

  console.log(`✓ No raw control bytes in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
