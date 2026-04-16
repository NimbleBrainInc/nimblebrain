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

function checkDir(dir: string, forbiddenPatterns: Array<{ pattern: RegExp; description: string }>, allowedFiles: Set<string>) {
  let files: string[];
  try {
    files = readdirSync(dir, { recursive: true }) as unknown as string[];
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const fullPath = join(dir, file);
    const relPath = relative(SRC, fullPath);

    if (allowedFiles.has(relPath)) continue;

    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes("from ")) continue;

      for (const { pattern, description } of forbiddenPatterns) {
        if (pattern.test(line)) {
          violations.push({
            file: relPath,
            line: i + 1,
            importPath: line.trim(),
          });
        }
      }
    }
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
