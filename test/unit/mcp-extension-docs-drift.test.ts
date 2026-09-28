import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Drift guard: every `ai.nimblebrain/*` key the runtime declares is documented
 * in the MCP section of the docs (`docs/src/content/docs/mcp/`).
 *
 * A key on the wire is a contract whether or not it is written down: a server
 * author sees it in a trace, and a key nobody documented is one they guess at.
 * The MCP section is where each key says who may send it and why it exists, so
 * a key declared here and missing there fails the build in the PR that adds it.
 *
 * A key is "declared" when a source file assigns the literal to a const — the
 * pattern every extension, marker, and method name follows. Tests and
 * generated declarations are skipped: they restate keys, they do not own them.
 */

const ROOT = resolve(import.meta.dir, "../..");
const SOURCE_DIRS = ["src", "web/src"];
const DOCS_DIR = join(ROOT, "docs/src/content/docs/mcp");
const DECLARATION = /const\s+[A-Z0-9_]+\s*(?::[^=]+)?=\s*"(ai\.nimblebrain\/[^"]+)"/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "_generated") {
        continue;
      }
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function declaredKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      for (const match of readFileSync(file, "utf8").matchAll(DECLARATION)) {
        const key = match[1];
        if (key && !keys.has(key)) keys.set(key, file.slice(ROOT.length + 1));
      }
    }
  }
  return keys;
}

const docs = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith(".mdx"))
  .map((name) => readFileSync(join(DOCS_DIR, name), "utf8"))
  .join("\n");

describe("MCP extension docs", () => {
  const keys = declaredKeys();

  test("the scan finds the runtime's declared keys", () => {
    // Guards the guard: a regex that stops matching would pass vacuously.
    expect(keys.has("ai.nimblebrain/host-resources")).toBe(true);
    expect(keys.has("ai.nimblebrain/action")).toBe(true);
  });

  test("every declared ai.nimblebrain/* key is documented in docs/…/mcp/", () => {
    const undocumented = [...keys]
      .filter(([key]) => !docs.includes(`\`${key}\``))
      .map(([key, file]) => `${key} (declared in ${file})`);
    expect(undocumented).toEqual([]);
  });
});
