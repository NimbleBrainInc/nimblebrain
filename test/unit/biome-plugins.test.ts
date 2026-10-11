/**
 * Each Grit plugin in `biome-plugins/` against code it must flag and code it
 * must pass. A plugin whose pattern stops matching (a Biome upgrade renames a
 * syntax node) still compiles and reports nothing, so the rule it enforces
 * would go quiet with every check green; this is what fails instead.
 *
 * Each case runs one plugin alone over its snippet, in a temp directory with
 * its own `biome.json`. A line ending in `// flagged` must get a diagnostic;
 * every other line must not.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PLUGINS = join(ROOT, "biome-plugins");
const BIOME = join(ROOT, "node_modules", ".bin", "biome");

const CASES: Record<string, string> = {
  "double-cast.grit": `
const a = 1 as unknown as string; // flagged
const b = (1 as unknown) as string; // flagged
const c = 1 as unknown;
const d = "x" as string;
export { a, b, c, d };
`,
  "router-use.grit": `
import { Hono } from "hono";
const router = new Hono();
router.use("*", async (_c, next) => next()); // flagged
router.get("/a", (c) => c.text("a")).use(async (_c, next) => next()); // flagged
router.get("/b", (c) => c.text("b"));
const use = (x: unknown) => x;
use(router);
`,
  "platform-object-return.grit": `
export function a(): object { return {}; } // flagged
export async function b(): Promise<object> { return {}; } // flagged
export const c = (): Promise<object> | object => ({}); // flagged
export const d = function (): (object) { return {}; }; // flagged
export const e = { m(): object { return {}; } }; // flagged
export class F { m(): Promise<object | null> { return Promise.resolve(null); } } // flagged
export function g(): Record<string, object> { return {}; }
export function h(): { inner: object } { return { inner: {} }; }
export type Handler = (input: unknown) => Promise<object>;
export interface Shape { m(): object }
export function register(fn: (input: unknown) => Promise<object>): void { void fn; }
`,
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Lines of `source` that `plugin`, run alone, reports. */
function flaggedLines(plugin: string, source: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), "nb-biome-plugin-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "biome.json"),
    JSON.stringify({
      linter: { rules: { recommended: false } },
      plugins: [join(PLUGINS, plugin)],
    }),
  );
  writeFileSync(join(dir, "case.ts"), source);
  const run = Bun.spawnSync([BIOME, "lint", "--reporter=json", "case.ts"], { cwd: dir });
  const report = JSON.parse(run.stdout.toString()) as {
    diagnostics: { category: string; location: { start: { line: number } } }[];
  };
  const errors = report.diagnostics.filter((d) => d.category !== "plugin");
  expect(errors).toEqual([]);
  return report.diagnostics.map((d) => d.location.start.line).sort((x, y) => x - y);
}

describe("biome-plugins", () => {
  test("every plugin has a case", () => {
    const plugins = readdirSync(PLUGINS).filter((f) => f.endsWith(".grit"));
    expect(Object.keys(CASES).sort()).toEqual(plugins.sort());
  });

  for (const [plugin, source] of Object.entries(CASES)) {
    test(`${plugin} flags exactly the marked lines`, () => {
      const expected = source
        .split("\n")
        .flatMap((line, i) => (line.endsWith("// flagged") ? [i + 1] : []));
      expect(expected.length).toBeGreaterThan(0);
      expect(flaggedLines(plugin, source)).toEqual(expected);
    });
  }
});
