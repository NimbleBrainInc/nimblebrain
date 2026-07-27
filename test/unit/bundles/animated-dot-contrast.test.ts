/**
 * A token that clears its contrast bar at rest can be faded under it by an
 * animation, and no palette guard can see that happen.
 *
 * This is not hypothetical. An earlier revision of the automations status dots
 * tokenised `.dot-running` correctly and left it on a keyframe shared with the
 * loading skeleton, which runs 0.3 -> 0.6 and never reaches full opacity. The
 * dot therefore rendered at 2.78:1 light / 2.92:1 dark against the 3:1 that
 * WCAG 1.4.11 asks of a non-text state indicator — under the bar at every frame
 * of the cycle, with the whole suite green, because every guard in the repo
 * measures tokens at rest.
 *
 * So the assertion has to read what the stylesheet actually does. It resolves
 * the animation `.dot-running` names, finds that keyframe's lowest opacity, and
 * composites the token it paints at exactly that opacity over both grounds the
 * dot renders on. Pinning the percentage here instead would reproduce the
 * original bug: the number in the test would stay 70 while the keyframe moved.
 *
 * What this deliberately does NOT do is assert the palette value itself. Every
 * way of lightening `primary` far enough to break this pair already breaks an
 * earlier assertion in `web/src/theme/__tests__/contrast.test.ts` — verified by
 * ramping the token: the faded pair fails at t=0.080 light and t=0.116 dark,
 * while `primary-foreground` on `primary/90` fails at 0.046 and `text-primary`
 * on `primary/20` at 0.034. A palette-side copy of this check would be
 * dominated in both modes and could never fail on its own. The coupling this
 * file owns is the one nothing else can reach: stylesheet -> token.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AA_NON_TEXT, contrastRatio, over } from "../../../web/src/theme/contrast.ts";
import { paletteToExtAppsTokens } from "../../../web/src/theme/projections.ts";
import { REPO } from "./themed-trees.ts";

const STYLES = join(REPO, "src", "bundles", "automations", "ui", "src", "styles.ts");

/**
 * The body of the brace-delimited block that starts at or after `from`.
 *
 * Brace-counted rather than regex-matched, because a `@keyframes` body nests
 * one level and `\{(.*?)\}` stops at the first inner `}` — which for a keyframe
 * written `0%, 100% { opacity: 1 } 50% { opacity: 0.7 }` captures only the
 * FIRST stop. That is the peak, not the trough, so the guard would have
 * asserted the one frame that was never in question. Caught by mutation:
 * lowering the trough changed nothing.
 */
function blockBody(css: string, from: number, what: string): string {
  const open = css.indexOf("{", from);
  if (open === -1) throw new Error(`${what} has no block`);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`${what} block is unterminated`);
}

/** The animation `selector` declares, e.g. `.dot-running` -> `dot-pulse`. */
function animationOf(css: string, selector: string): string {
  const at = css.search(new RegExp(`\\${selector}\\s*\\{`));
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const anim = /animation:\s*([a-zA-Z][\w-]*)/.exec(blockBody(css, at, selector));
  if (!anim) throw new Error(`${selector} declares no animation`);
  return anim[1] as string;
}

/** The lowest opacity a keyframe reaches, as a percentage. */
function troughPct(css: string, keyframe: string): number {
  const at = css.search(new RegExp(`@keyframes\\s+${keyframe}\\b`));
  if (at === -1) throw new Error(`no @keyframes ${keyframe}`);
  const stops = [...blockBody(css, at, `@keyframes ${keyframe}`).matchAll(/opacity:\s*([\d.]+)/g)];
  if (!stops.length) throw new Error(`@keyframes ${keyframe} sets no opacity`);
  return Math.min(...stops.map((m) => Number.parseFloat(m[1] as string))) * 100;
}

describe("the automations running dot holds 1.4.11 at its faded frame", () => {
  const css = readFileSync(STYLES, "utf8");
  const keyframe = animationOf(css, ".dot-running");
  const trough = troughPct(css, keyframe);

  test("the stylesheet is parsed, not assumed", () => {
    expect(keyframe).toBeTruthy();
    expect(trough).toBeGreaterThan(0);
    expect(trough).toBeLessThanOrEqual(100);
  });

  // The parser reads the LOWEST opacity across every stop. Asserted directly,
  // because the first version read only the first stop and so reported the
  // peak — and against this keyframe, whose peak is 1, that is silently the
  // one value guaranteed to pass.
  test.each([
    ["@keyframes k { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }", 70],
    ["@keyframes k { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.6; } }", 30],
    ["@keyframes k {\n  from { opacity: 1; }\n  to { opacity: 0.25; }\n}", 25],
    ["@keyframes k { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; } }", 40],
  ])("trough parser: %s -> %p%%", (css, expected) => {
    expect(troughPct(css, "k")).toBeCloseTo(expected, 5);
  });

  test("the animation name comes from the rule, not a guess", () => {
    expect(animationOf(".dot-running { background: red; animation: foo 1s linear; }", ".dot-running")).toBe("foo");
  });

  // `.dot-running` paints this token; read it rather than hardcoding, so
  // repointing the dot at a dimmer token is caught here too.
  const painted = /\.dot-running\s*\{[^}]*background:\s*var\((--[\w-]+)\)/.exec(css)?.[1];

  test("the dot paints a token the host injects", () => {
    expect(painted).toBeTruthy();
    expect(Object.keys(paletteToExtAppsTokens("light"))).toContain(painted);
  });

  for (const mode of ["light", "dark"] as const) {
    // The dot renders on the page and on the automation card.
    for (const ground of ["--color-background-primary", "--color-background-secondary"]) {
      test(`${mode}: ${painted} at ${trough}% over ${ground} clears ${AA_NON_TEXT}:1`, () => {
        const tokens = paletteToExtAppsTokens(mode);
        const dot = tokens[painted as string] as string;
        const bg = tokens[ground] as string;
        expect(contrastRatio(over(dot, bg, trough), bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }
});
