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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The animation `selector` declares, e.g. `.dot-running` -> `dot-pulse`, or
 * null if the rule exists but sets no animation.
 *
 * Null rather than throwing, because a dot that does not pulse is the SAFE
 * state — it renders at the token's full value, which the palette guards
 * already cover. Throwing would turn "we decided this should not animate" into
 * a CI break, which teaches the wrong lesson about a rule that only exists to
 * catch fading. A missing *rule* still throws: that means the selector was
 * renamed and this guard is now watching nothing.
 */
function animationOf(css: string, selector: string): string | null {
  const at = css.search(new RegExp(`${escape(selector)}\\s*\\{`));
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return /animation:\s*([a-zA-Z][\w-]*)/.exec(blockBody(css, at, selector))?.[1] ?? null;
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
  // No animation means no faded frame: the dot sits at the token's full value,
  // which the palette guards already cover.
  const trough = keyframe === null ? 100 : troughPct(css, keyframe);

  test("the stylesheet is parsed, not assumed", () => {
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
    const rule = ".dot-running { background: red; animation: foo 1s linear; }";
    expect(animationOf(rule, ".dot-running")).toBe("foo");
    // A rule with no animation is the safe state, reported rather than thrown.
    expect(animationOf(".dot-running { background: red; }", ".dot-running")).toBeNull();
    // A missing rule is not: it means this guard is watching nothing.
    expect(() => animationOf(".other { color: red; }", ".dot-running")).toThrow();
    // The selector is escaped, so a metacharacter past the first is literal.
    expect(() => animationOf(".a.b { animation: x 1s; }", ".a.b")).not.toThrow();
  });

  // `.dot-running` paints this token; read it rather than hardcoding, so
  // repointing the dot at a dimmer token is caught here too.
  const painted = /\.dot-running\s*\{[^}]*background:\s*var\((--[\w-]+)\)/.exec(css)?.[1];

  test("the dot paints a token the host injects", () => {
    expect(painted).toBeTruthy();
    expect(Object.keys(paletteToExtAppsTokens("light"))).toContain(painted);
  });

  /**
   * Every ground a dot renders on, derived rather than listed.
   *
   * The page and the card are the obvious two. The third is the row hover fill
   * — `.rail-auto-item:hover`, `.rail-run-item:hover` and `.run-row:hover` all
   * paint a 30% mix of the border token over whichever of those they sit on,
   * and every dot in the rail and the run list renders inside one of those rows
   * (`RailItem.tsx:40`, `:72`, `RunRow.tsx:26`). It is the TIGHTEST of the
   * three, so a guard that checks only the first two reports more headroom than
   * the dot actually has, and darkening the border token or raising that 30%
   * would drop the real worst case under the bar with the guard still green.
   *
   * The mix percentage is read from the stylesheet for the same reason the
   * trough is: a copy of it here would drift the moment someone tunes the hover.
   */
  const HOVER = /:hover\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*(\d+)%/;

  function groundsFor(mode: "light" | "dark"): [string, string][] {
    const tokens = paletteToExtAppsTokens(mode);
    const bases = ["--color-background-primary", "--color-background-secondary"];
    const out: [string, string][] = bases.map((b) => [b, tokens[b] as string]);
    const hover = HOVER.exec(css);
    if (hover) {
      const tint = tokens[hover[1] as string] as string;
      const pct = Number.parseInt(hover[2] as string, 10);
      for (const b of bases) {
        out.push([`${hover[1]} ${pct}% over ${b}`, over(tint, tokens[b] as string, pct)]);
      }
    }
    return out;
  }

  test("the hover fill is found, so the tightest ground is actually covered", () => {
    expect(HOVER.test(css)).toBe(true);
    expect(groundsFor("light")).toHaveLength(4);
  });

  for (const mode of ["light", "dark"] as const) {
    for (const [name, bg] of groundsFor(mode)) {
      test.skipIf(keyframe === null)(
        `${mode}: ${painted} at ${trough}% over ${name} clears ${AA_NON_TEXT}:1`,
        () => {
          const dot = paletteToExtAppsTokens(mode)[painted as string] as string;
          expect(contrastRatio(over(dot, bg, trough), bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
        },
      );
    }
  }
});
