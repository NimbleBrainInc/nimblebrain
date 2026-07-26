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
 * Scope is `web/src/index.css`: the shell is what Lightning processes. Bundle
 * UIs inline their CSS as a template string and are not downlevelled, verified
 * in `automations/ui/dist`. Non-colour properties are left alone — a degraded
 * `border-color` or `box-shadow` shifts an edge; a degraded `background` behind
 * text removes the text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = join(import.meta.dir, "..", "..", "..", "web", "src", "index.css");

/** Properties whose downlevelled `color-mix()` can hide content, not just shift it. */
const COLOUR_PROPERTIES = ["background", "background-color", "color"];

type Offence = { line: number; text: string };

function colourMixes(source: string): Offence[] {
  return source
    .split("\n")
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter(({ text }) => {
      const property = /^([a-z-]+)\s*:/.exec(text)?.[1];
      return !!property && COLOUR_PROPERTIES.includes(property) && text.includes("color-mix(");
    });
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
});
