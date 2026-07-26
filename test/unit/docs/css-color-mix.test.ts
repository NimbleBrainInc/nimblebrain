/**
 * No `color-mix()` in a colour-valued property in the shell's stylesheet.
 *
 * Lightning CSS (via Tailwind v4) downlevels `color-mix()` for browsers that
 * lack it — Chrome/Edge <111, Firefox <113, Safari <16.2 — by emitting an
 * unguarded declaration and gating the real one behind `@supports`. Its
 * unguarded version keeps only the **first operand**, dropping the percentage
 * and the transparency. So
 *
 *     background: color-mix(in srgb, var(--foreground) 10%, transparent);
 *
 * shipped as `background: var(--foreground)` — and the rule sets
 * `color: var(--foreground)` too, giving 1.000:1. Invisible text on every user
 * turn in the transcript, and on every failed tool call.
 *
 * The rule is a ban rather than "declare your own fallback" because the
 * fallback cannot be pre-empted: the downlevelled declaration is emitted
 * *after* an author-written one, so it wins. Verified against the built
 * artifact, not assumed — `background: transparent` immediately above the
 * `color-mix()` still produced `background:0 0;background:var(--foreground)`.
 * Moving the mix into a custom property relocates the problem without fixing
 * it, which was also checked.
 *
 * Use a translucent token from `palette.ts` instead (`--foreground-tint`,
 * `--destructive-tint`). `rgba()` has no downlevel, and being translucent it
 * still composites over whichever surface the element lands on — which is the
 * only reason a mix was reached for.
 *
 * Scope is the **hand-authored** rules in `web/src/index.css`, and that is a
 * real limit rather than the whole problem. Tailwind's own `/N` opacity
 * utilities compile to `color-mix()` too, and the built stylesheet carries 84
 * downlevelled blocks because of them. The affected shape is any token painted
 * as both a text colour and an alpha background — `text-<T>` over `bg-<T>/N` —
 * which degrades to 1.000:1 by exactly the same mechanism; `sidebar-foreground`
 * on the sidebar's active rows is as much an instance as `destructive` on an
 * error notice. No count is quoted, because a count invites the next reader to
 * re-check the hues someone once listed rather than the rule. That is a
 * pre-existing condition of the utility layer, not of this file: it cannot be
 * fixed by authoring differently, only by moving those sites onto tokens or by
 * narrowing the build's browser targets so Lightning stops downlevelling at
 * all. Tracked with the inventory in #781. This guard covers what an author
 * here controls, and no more.
 *
 * Bundle UIs are exempt because no bundle runs Tailwind, so Lightning never
 * processes their CSS — verified in `conversations/ui/dist`, which keeps its
 * five `color-mix()` declarations verbatim with no `@supports` block. Note this
 * is a property of the build, not of how the CSS is authored: four of the five
 * bundles ship a real `index.css`, and only `automations` is a template string.
 * Non-colour properties are left alone — a degraded `border-color` or
 * `box-shadow` shifts an edge; a degraded `background` behind text removes the
 * text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = join(import.meta.dir, "..", "..", "..", "web", "src", "index.css");

/** Properties whose downlevelled `color-mix()` can hide content, not just shift it. */
const COLOUR_PROPERTIES = ["background", "background-color", "color"];

type Offence = { line: number; text: string };

/**
 * Declarations are matched anywhere in a line, not just at its start. This file
 * writes plenty of single-line rules (`.x:hover { color: var(--y); }`), and
 * anchoring to the start of the line would let a `color-mix()` written in the
 * file's own prevailing style walk straight past the ban.
 */
const DECLARATION = /(?:^|[{;])\s*([a-z-]+)\s*:\s*([^;}]*)/g;

function colourMixes(source: string): Offence[] {
  return source
    .split("\n")
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter(({ text }) =>
      [...text.matchAll(DECLARATION)].some(
        ([, property, value]) =>
          COLOUR_PROPERTIES.includes(property as string) &&
          (value as string).includes("color-mix("),
      ),
    );
}

describe("shell CSS avoids color-mix() in colour properties", () => {
  test("web/src/index.css", () => {
    const found = colourMixes(readFileSync(CSS, "utf8"));
    const report = found.map((f) => `index.css:${f.line} — ${f.text}`).join("\n");
    expect(report).toBe("");
  });

  test("the file is actually being read", () => {
    expect(readFileSync(CSS, "utf8").length).toBeGreaterThan(1000);
  });
});

describe("colourMixes", () => {
  test("flags a background built from color-mix", () => {
    const css = ".x {\n  background: color-mix(in srgb, var(--a) 10%, transparent);\n}";
    expect(colourMixes(css).map((f) => f.line)).toEqual([2]);
  });

  test("an author-written fallback does not excuse it — the minifier's own wins", () => {
    const css = ".x {\n  background: transparent;\n  background: color-mix(in srgb, var(--a) 10%, transparent);\n}";
    expect(colourMixes(css).map((f) => f.line)).toEqual([3]);
  });

  test("leaves non-colour properties alone", () => {
    const css = ".x {\n  border-color: color-mix(in oklch, var(--a) 20%, transparent);\n}";
    expect(colourMixes(css)).toEqual([]);
  });

  test("a plain colour declaration is not an offence", () => {
    expect(colourMixes(".x {\n  background: var(--foreground-tint);\n}")).toEqual([]);
  });

  test("sees a declaration inside a single-line rule", () => {
    const css = ".x:hover { color: var(--a); background: color-mix(in srgb, var(--b) 10%, transparent); }";
    expect(colourMixes(css).map((f) => f.line)).toEqual([1]);
  });

  test("a single-line rule with no color-mix is not an offence", () => {
    expect(colourMixes(".x:hover { color: var(--a); background: var(--b); }")).toEqual([]);
  });

  test("a non-colour property on a single line is still left alone", () => {
    expect(colourMixes(".x { border-color: color-mix(in oklch, var(--a) 20%, transparent); }")).toEqual([]);
  });
});
