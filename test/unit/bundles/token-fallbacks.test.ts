/**
 * A theme token's fallback lives in the token's value. A `var()` call site
 * never repeats it.
 *
 * `var(--color-text-secondary, #5c5c66)` looks defensive and is not. In a
 * host-themed tree the token always has a value: `buildThemeStyleBlock` injects
 * all of `paletteToExtAppsTokens` into the iframe's `<style>` before the app
 * renders, and a `srcdoc` iframe inherits nothing else, so there is no state in
 * which the host is present and the token is absent. The fallback is therefore
 * dead in every case except one — a token name that does not exist — and that
 * is exactly the case where a second value does harm rather than good: instead
 * of failing loudly it renders a plausible colour, usually the light-palette
 * one, so the defect only surfaces in dark mode. That is not hypothetical; it
 * is how an input came to sit at 1.044:1 against its own label.
 *
 * One other state has no host and so did read the fallbacks: a bundle UI run
 * standalone under its own `vite dev`, which every bundle has. That is a real
 * cost and it was taken deliberately — the app has no parent bridge there, so
 * it renders no data whatever its colours are, and unstyled is the honest
 * signal that you are looking at it outside the platform rather than a
 * light-mode approximation of it. If a bundle ever needs to be developed
 * standalone in earnest, the answer is one dev-only stylesheet declaring the
 * token set, not a fallback re-typed at each of several hundred call sites.
 *
 * The rule generalises past colour. A font token's value *is* a stack
 * (`'Hanken Grotesk', system-ui, sans-serif`) whose tail is the fallback — and
 * that tail matters, because a `srcdoc` iframe inherits no `@font-face`, so it
 * is usually what renders. Writing `var(--font-sans, system-ui, sans-serif)`
 * duplicates a fallback that already exists one level down, and the copy is
 * what goes stale. Radii and spacing are the same shape.
 *
 * So: one rule for every family, and no per-family carve-out to remember.
 * Either the token is injected (the host guarantees a value) or it is declared
 * locally in the same tree (you guarantee it). {@link ./theme-token-names.test.ts}
 * asserts that every name resolves to one of those two; this file asserts that
 * no call site carries a second opinion about what it means.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { REPO, sourceFiles, themedTrees } from "./themed-trees.ts";

/**
 * A `var()` whose argument list has a comma at depth 1 — i.e. a fallback.
 *
 * Written to match the forms that actually occur rather than one tidy spelling:
 * the trees carry `var(--x,#hex)`, `var(--x, #hex)`, and `var(--x, a, b)` (a
 * font stack, whose commas are all part of one fallback). Whitespace after
 * `var(` and around the name is permitted because CSS permits it, and a matcher
 * that describes a stricter grammar than the language would pass a violation
 * written in the file's own prevailing style. The name class is `[\w-]` for the
 * same reason — an underscore is legal in a custom-property ident, so a
 * narrower class would read `var(--my_token, #fff)` as a bare `var(--my)` and
 * wave the fallback through.
 *
 * Not closed: a comment between the name and the comma (`var(--x /* c *\/, red)`).
 * Matching that needs a tokenizer rather than a regex, no such spelling exists
 * in these trees, and the sibling name guard fails on it anyway.
 */
const FALLBACK = /var\(\s*--[\w-]+\s*,/g;

/** A bare `var(--x)`, used to prove the matcher discriminates rather than matching everything. */
const BARE = /var\(\s*--[\w-]+\s*\)/g;

function violations(): string[] {
  const found: string[] = [];
  for (const { dir } of themedTrees) {
    for (const file of sourceFiles(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(FALLBACK)) {
          found.push(`${relative(REPO, file)}:${i + 1}  ${m[0]}…)`);
        }
      });
    }
  }
  return found;
}

describe("theme tokens are used without fallbacks", () => {
  test("no var(--token, fallback) in any host-themed tree", () => {
    expect(violations()).toEqual([]);
  });

  // Canary. Without this the suite stays green if the walk silently stops
  // finding files (a renamed directory, a tightened extension filter) — the
  // failure mode where a guard reports "clean" because it read nothing.
  test("the walk actually reaches the themed trees", () => {
    expect(themedTrees.length).toBeGreaterThan(0);
    const total = themedTrees.reduce((n, { dir }) => n + sourceFiles(dir).length, 0);
    expect(total).toBeGreaterThan(0);
    const bare = themedTrees
      .flatMap(({ dir }) => sourceFiles(dir))
      .reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(BARE)].length, 0);
    expect(bare).toBeGreaterThan(0);
  });

  test.each([
    ["var(--color-text-primary, #09090b)", true],
    ["var(--color-text-primary,#09090b)", true],
    ["var( --color-text-primary , #09090b )", true],
    ["var(--font-sans, system-ui, sans-serif)", true],
    ["var(--my_token, #fff)", true],
    ["color: var(--x, #fff); background: var(--y, #000)", true],
    ["var(--color-text-primary)", false],
    ["var( --color-text-primary )", false],
    ["color: var(--x); background: var(--y)", false],
  ])("matcher: %s → violation=%p", (source, expected) => {
    expect(new RegExp(FALLBACK.source).test(source)).toBe(expected);
  });

  test("the matcher counts every occurrence on a line, not just the first", () => {
    const line = "border: 1px solid var(--a, #111); background: var(--b, #222);";
    expect([...line.matchAll(FALLBACK)]).toHaveLength(2);
  });
});
