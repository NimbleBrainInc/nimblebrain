import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The reference ACP agent is the seed of a standalone agent, so what it loads
 * must stay extractable: the engine and the model layer, and nothing of the
 * platform (no runtime, no web client, no platform apps). This walks the
 * modules it actually loads (type-only imports load nothing) and holds every
 * one to the list below. An import that pulls in more fails here; widen the
 * list only for a leaf the engine itself needs.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const ENTRY = "src/execution/acp-agent/agent.ts";

/** Whole directories the agent may load. */
const ALLOWED_DIRS = [
  "src/engine/",
  "src/model/",
  "src/observability/",
  "src/util/",
  "src/usage/",
  "src/execution/acp-agent/",
];

/** Single files outside those directories: leaves the engine needs, each named. */
const ALLOWED_FILES = new Set([
  "src/limits.ts",
  "src/execution/acp/nimblebrain-extension.ts",
  "src/prompt/containment.ts",
  "src/tools/coerce-input.ts",
  "src/tools/validate-input.ts",
  "src/tools/tool-pattern.ts",
  "src/skills/select.ts",
  "src/skills/truncate.ts",
]);

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Every local module the entry loads, transitively, by repo-relative path. */
function loadedModules(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    // Data (the model catalog's JSON) imports nothing.
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const { path } of transpiler.scanImports(source)) {
      if (!path.startsWith(".")) continue;
      stack.push(relative(ROOT, resolve(ROOT, dirname(file), path)));
    }
  }
  return [...seen].sort();
}

describe("the reference ACP agent stays extractable", () => {
  const modules = loadedModules(ENTRY);

  test("the walk finds the engine (guards the guard)", () => {
    expect(modules).toContain("src/engine/engine.ts");
  });

  test("loads nothing of the platform beyond the engine and its leaves", () => {
    const outside = modules.filter(
      (m) => !ALLOWED_FILES.has(m) && !ALLOWED_DIRS.some((dir) => m.startsWith(dir)),
    );
    expect(outside).toEqual([]);
  });
});
