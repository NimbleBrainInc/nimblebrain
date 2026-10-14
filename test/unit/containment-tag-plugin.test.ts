import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The containment-tag Biome plugin carries its own copy of the tag list,
 * because a Grit pattern cannot read another file. A tag added to
 * `ContainmentTag` without the plugin would be unguarded with nothing failing,
 * so this pins the two lists together.
 */
const ROOT = join(import.meta.dir, "..", "..");

test("the containment-tag plugin guards every ContainmentTag", () => {
  const compose = readFileSync(join(ROOT, "src/prompt/compose.ts"), "utf-8");
  const union = /export type ContainmentTag =([^;]+);/.exec(compose)?.[1] ?? "";
  const declared = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

  const plugin = readFileSync(join(ROOT, "biome-plugins/containment-tag.grit"), "utf-8");
  const alternation = /\(\?:([^)]+)\)\\b/.exec(plugin)?.[1] ?? "";
  const guarded = alternation.split("|").sort();

  expect(declared.length).toBeGreaterThan(0);
  expect(guarded).toEqual(declared);
});
