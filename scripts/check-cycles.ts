#!/usr/bin/env bun
/**
 * Layering rule enforcement — prevents circular dependencies between
 * runtime/ and tools/ by ensuring no file in src/runtime/ (except the
 * composition root runtime.ts and workspace-runtime.ts) imports from src/tools/.
 *
 * Also verifies that no file in src/config/ imports from src/runtime/ or src/tools/.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname ?? __dirname, "../src");

interface Violation {
  file: string;
  line: number;
  importPath: string;
}

const violations: Violation[] = [];

/** Recursively list .ts files under a directory, or an empty list if it can't be read. */
function listTsFiles(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { recursive: true }) as unknown as string[];
    return entries.filter((file) => file.endsWith(".ts"));
  } catch {
    return [];
  }
}

/** Record every forbidden import found in a file's source lines. */
function scanForViolations(
  relPath: string,
  content: string,
  forbiddenPatterns: Array<{ pattern: RegExp; description: string }>,
) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("from ")) continue;

    for (const { pattern } of forbiddenPatterns) {
      if (pattern.test(line)) {
        violations.push({ file: relPath, line: i + 1, importPath: line.trim() });
      }
    }
  }
}

/** Flag forbidden imports in every non-exempt .ts file under a directory tree. */
function checkDir(
  dir: string,
  forbiddenPatterns: Array<{ pattern: RegExp; description: string }>,
  allowedFiles: Set<string>,
) {
  for (const file of listTsFiles(dir)) {
    const fullPath = join(dir, file);
    const relPath = relative(SRC, fullPath);
    if (allowedFiles.has(relPath)) continue;

    scanForViolations(relPath, readFileSync(fullPath, "utf-8"), forbiddenPatterns);
  }
}

// Rule 1: src/runtime/*.ts must not import from src/tools/
// Exceptions: runtime.ts (composition root) and workspace-runtime.ts
checkDir(
  join(SRC, "runtime"),
  [{ pattern: /from\s+["']\.\.\/tools\//, description: "runtime/ must not import from tools/" }],
  new Set(["runtime/runtime.ts", "runtime/workspace-runtime.ts"]),
);

// Rule 2: src/config/*.ts must not import from src/runtime/ or src/tools/
checkDir(
  join(SRC, "config"),
  [
    { pattern: /from\s+["']\.\.\/runtime\//, description: "config/ must not import from runtime/" },
    { pattern: /from\s+["']\.\.\/tools\//, description: "config/ must not import from tools/" },
  ],
  new Set(),
);

if (violations.length > 0) {
  console.error("❌ Layering violations detected:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.importPath}\n`);
  }
  process.exit(1);
} else {
  console.log("✓ No layering violations detected");
}
