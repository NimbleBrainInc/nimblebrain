/**
 * A token that clears its contrast bar at rest can be faded under it by an
 * animation, and no palette guard can see that happen.
 *
 * This is not hypothetical. A status dot correctly painted from
 * `--color-text-accent` was left on a keyframe shared with a loading skeleton,
 * which runs 0.3 -> 0.6 and never reaches full opacity. The dot rendered at
 * 2.78:1 light / 2.92:1 dark against the 3:1 that WCAG 1.4.11 asks of a
 * non-text state indicator — under the bar at every frame of the cycle, with
 * the whole suite green, because every other guard measures tokens at rest.
 *
 * So these assertions read what the stylesheet actually does: the animation a
 * rule names, that keyframe's lowest opacity, and the token the rule paints,
 * composited at exactly that opacity over every ground the element renders on.
 * Pinning any of those numbers here would reproduce the original bug — the
 * value in the test would stay put while the stylesheet moved.
 *
 * What this deliberately does NOT do is assert the palette values themselves.
 * Every way of lightening `primary` far enough to break these pairs already
 * breaks an earlier assertion in `web/src/theme/__tests__/contrast.test.ts` —
 * verified by ramping the token: the faded pair fails at t=0.080 light and
 * t=0.116 dark, while `primary-foreground` on `primary/90` fails at 0.046 and
 * `text-primary` on `primary/20` at 0.034. A palette-side copy would be
 * dominated in both modes and could never fail alone. The coupling this file
 * owns is the one nothing else reaches: stylesheet -> token.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { AA_NON_TEXT, contrastRatio, over } from "../../../web/src/theme/contrast.ts";
import { paletteToExtAppsTokens } from "../../../web/src/theme/projections.ts";
import { REPO, sourceFiles, themedTrees } from "./themed-trees.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A rule that loops an animation while painting a host token.
 *
 * `infinite` is the discriminator, not merely `animation:`. A one-shot entrance
 * (`fadeIn`) ends at full opacity, so it cannot leave anything persistently
 * faded; only a looping animation can. That distinction is what keeps
 * `.confirm-panel` and `.detail-panel` out of this set, rather than a judgement
 * call about them.
 */
const LOOPING_TOKEN_RULE =
  /([.#][\w-]+(?:\s*,\s*[.#][\w-]+)*)\s*\{([^}]*animation:[^;]*\binfinite\b[^}]*)\}/g;

/** Every looping token-painted rule in every themed tree, derived. */
function derivedCandidates(): { file: string; selector: string }[] {
  const found: { file: string; selector: string }[] = [];
  for (const { dir } of themedTrees) {
    for (const file of sourceFiles(dir)) {
      const css = readFileSync(file, "utf8");
      for (const m of css.matchAll(LOOPING_TOKEN_RULE)) {
        if (!/background:\s*var\(--/.test(m[2] as string)) continue;
        for (const sel of (m[1] as string).split(",").map((s) => s.trim())) {
          found.push({ file, selector: sel });
        }
      }
    }
  }
  return found;
}

/**
 * The looping indicators whose faded frame is asserted below.
 *
 * This list is checked AGAINST the derived set, not trusted in place of it.
 * The first version of this guard was a hand-maintained constant and drifted
 * immediately: it covered `.dot-running` while `.conv-streaming-dot` sat one
 * bundle over at 1.93:1, already measured and written into a comment. A guard
 * whose scope is narrower than its rule is the shape {@link ./themed-trees.ts}
 * argues against, so a new looping indicator now fails CI until it is either
 * asserted here or exempted with a reason.
 */
const GUARDED = [
  {
    what: "automations running dot",
    file: join(REPO, "src", "bundles", "automations", "ui", "src", "styles.ts"),
    selector: ".dot-running",
  },
  {
    what: "conversations live dot",
    file: join(REPO, "src", "bundles", "conversations", "ui", "src", "index.css"),
    selector: ".conv-streaming-dot",
  },
];

/**
 * Looping token-painted rules that carry no state, with the reason each is
 * decorative. 1.4.11 applies to what conveys information, so a shimmer that
 * only says "still loading" — a fact the surrounding layout already makes
 * obvious — is out of scope in a way a run's outcome is not.
 */
const EXEMPT: Record<string, string> = {
  ".skel": "loading skeleton — conveys 'not yet loaded', which the layout already shows",
  ".file-thumb-shimmer": "thumbnail placeholder — decorative, replaced by the image",
  ".detail-shimmer": "detail-pane placeholder — decorative, replaced by content",
};

/**
 * Read a stylesheet the way the app does.
 *
 * A `.ts` entry is EVALUATED rather than slurped as text, because
 * `automations/ui/src/styles.ts` is one big template literal and a stray
 * backtick in a comment terminates it. That is not theoretical: it happened,
 * and nothing caught it — `vite build` bundles without evaluating, the root
 * tsconfig excludes `src/bundles/*&#47;ui`, and a `readFileSync` guard is
 * perfectly happy to parse a file the runtime cannot load. Importing it means a
 * bundle that would render a blank iframe fails here instead.
 */
async function loadCss(file: string): Promise<string> {
  if (!file.endsWith(".ts")) return readFileSync(file, "utf8");
  const mod = (await import(file)) as Record<string, unknown>;
  const css = Object.values(mod).find((v) => typeof v === "string" && v.includes("{"));
  if (typeof css !== "string") throw new Error(`${file} exports no stylesheet string`);
  return css;
}

/**
 * The body of the brace-delimited block that starts at or after `from`.
 *
 * Brace-counted rather than regex-matched, because a `@keyframes` body nests
 * one level and a non-greedy `{(.*?)}` stops at the first inner brace — which
 * for a keyframe written `0%, 100% { opacity: 1 } 50% { opacity: 0.7 }`
 * captures only the FIRST stop. That is the peak, not the trough, so the guard
 * would assert the one frame never in question. Caught by mutation: lowering
 * the trough changed nothing.
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

/**
 * The animation `selector` declares, or null if the rule sets none.
 *
 * Null rather than throwing, because an unanimated indicator is the SAFE state
 * — it renders at the token's full value, which the palette guards cover.
 * Throwing would turn "we decided this should not pulse" into a CI break. A
 * missing *rule* still throws: that means the selector was renamed and this
 * guard is watching nothing.
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

const LOADED = await Promise.all(GUARDED.map(async (g) => ({ ...g, css: await loadCss(g.file) })));

describe("the parsers read what a stylesheet says", () => {
  // Hoisted out of the per-indicator loop: none of these assert anything
  // indicator-specific, so running them once per entry only inflates the count.
  test.each([
    ["@keyframes k { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }", 70],
    ["@keyframes k { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.6; } }", 30],
    ["@keyframes k {\n  from { opacity: 1; }\n  to { opacity: 0.25; }\n}", 25],
    ["@keyframes k { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; } }", 40],
  ])("trough is the LOWEST stop, not the first: %s -> %p%%", (css, expected) => {
    expect(troughPct(css, "k")).toBeCloseTo(expected, 5);
  });

  test("the animation name comes from the rule, not a guess", () => {
    expect(animationOf(".d { background: red; animation: foo 1s linear; }", ".d")).toBe("foo");
    // A rule with no animation is the safe state, reported rather than thrown.
    expect(animationOf(".d { background: red; }", ".d")).toBeNull();
    // A missing rule is not: it means this guard is watching nothing.
    expect(() => animationOf(".other { color: red; }", ".d")).toThrow();
    // The selector is escaped, so a metacharacter past the first stays literal.
    expect(() => animationOf(".a.b { animation: x 1s; }", ".a.b")).not.toThrow();
  });
});

describe("every looping indicator is classified", () => {
  test("no looping token-painted rule is silently unguarded", () => {
    const guarded = new Set(GUARDED.map((g) => `${g.file}::${g.selector}`));
    const unclassified = derivedCandidates()
      .filter((c) => !guarded.has(`${c.file}::${c.selector}`) && !(c.selector in EXEMPT))
      .map((c) => `${c.selector} — ${relative(REPO, c.file)}`);

    expect(unclassified).toEqual([]);
  });

  test("the derivation finds things, so an empty sweep cannot pass", () => {
    const found = derivedCandidates();
    expect(found.length).toBeGreaterThanOrEqual(GUARDED.length);
    for (const g of GUARDED) {
      expect(found.some((c) => c.file === g.file && c.selector === g.selector)).toBe(true);
    }
  });

  test("every exemption is still used, so the list cannot rot", () => {
    const seen = new Set(derivedCandidates().map((c) => c.selector));
    expect(Object.keys(EXEMPT).filter((s) => !seen.has(s))).toEqual([]);
  });
});

for (const { what, selector, css } of LOADED) {
  describe(`${what} holds 1.4.11 at its faded frame`, () => {
    const keyframe = animationOf(css, selector);
    // No animation means no faded frame: the element sits at the token's full
    // value, which the palette guards already cover.
    const trough = keyframe === null ? 100 : troughPct(css, keyframe);

    test("the stylesheet is parsed, not assumed", () => {
      expect(trough).toBeGreaterThan(0);
      expect(trough).toBeLessThanOrEqual(100);
    });

    // Read the painted token rather than hardcoding it, so repointing the
    // indicator at a dimmer token is caught here too.
    const painted = new RegExp(
      `${escape(selector)}\\s*\\{[^}]*background:\\s*var\\((--[\\w-]+)\\)`,
    ).exec(css)?.[1];

    test("the indicator paints a token the host injects", () => {
      expect(painted).toBeTruthy();
      expect(Object.keys(paletteToExtAppsTokens("light"))).toContain(painted);
    });

    /**
     * Every ground the indicator renders on, derived rather than listed.
     *
     * The page and the card are the obvious two. The third, where a bundle has
     * one, is the row hover fill: `automations` paints a 30% mix of the border
     * token in `.run-row:hover` and `.rail-auto-item:hover`, and every dot in
     * that rail and run list renders inside one of those rows
     * (`ui/src/components/RailItem.tsx:40`, `:72`,
     * `ui/src/components/RunRow.tsx:26`). It is the TIGHTEST of the three, so a
     * guard checking only the first two reports more headroom than the dot has.
     * `conversations` has no such fill — `.conv-item:hover` only transforms —
     * so it correctly yields fewer grounds rather than a fabricated one.
     */
    const HOVER = /:hover\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*(\d+)%/g;

    function groundsFor(mode: "light" | "dark"): [string, string][] {
      const tokens = paletteToExtAppsTokens(mode);
      const bases = ["--color-background-primary", "--color-background-secondary"];
      const out: [string, string][] = [];
      // Deduped by resulting COLOUR, not name. Two things collapse here and
      // both are real: in light mode the page and the card are the same white,
      // and automations declares the identical hover mix twice. The same pair
      // asserted under two names would read as broader coverage than it is.
      const seen = new Set<string>();
      const add = (name: string, colour: string) => {
        if (seen.has(colour)) return;
        seen.add(colour);
        out.push([name, colour]);
      };

      for (const b of bases) add(b, tokens[b] as string);
      // EVERY hover fill, not the first: a single exec() reads one of the two
      // declarations while every rail dot renders inside the other.
      for (const m of css.matchAll(HOVER)) {
        const tint = tokens[m[1] as string] as string;
        const pct = Number.parseInt(m[2] as string, 10);
        for (const b of bases) {
          add(`${m[1]} ${pct}% over ${b}`, over(tint, tokens[b] as string, pct));
        }
      }
      return out;
    }

    test("every ground the indicator renders on is enumerated, and none twice", () => {
      for (const mode of ["light", "dark"] as const) {
        const grounds = groundsFor(mode);
        expect(grounds.length).toBeGreaterThan(0);
        expect(new Set(grounds.map(([, c]) => c)).size).toBe(grounds.length);
        // A declared hover fill MUST have contributed a ground. This catches
        // the guard silently reverting to the base surfaces, which is how the
        // tightest ground went unmeasured the first time.
        if (/:hover\s*\{[^}]*color-mix/.test(css)) {
          const baseColours = new Set(
            ["--color-background-primary", "--color-background-secondary"].map(
              (b) => paletteToExtAppsTokens(mode)[b],
            ),
          );
          expect(grounds.length).toBeGreaterThan(baseColours.size);
        }
      }
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
}

/**
 * A `prefers-reduced-motion` override has to win, and placement is the only
 * thing that decides whether it does.
 *
 * A media query contributes no specificity, so a `.skel { animation: none }`
 * inside one and a `.skel` rule outside it are both (0,1,0) and the later in
 * source order wins. An override written ABOVE the rule it means to override is
 * inert while looking exactly like a working one, which no rendering test would
 * catch either.
 */
describe("reduced-motion overrides are placed where they win", () => {
  const MEDIA = /@media\s*\([^)]*prefers-reduced-motion[^)]*\)\s*\{/g;

  for (const { what, css } of LOADED) {
    test(`${what}: every overridden selector is declared before its override`, () => {
      const dead: string[] = [];

      for (const media of css.matchAll(MEDIA)) {
        const start = media.index as number;
        const body = blockBody(css, start, "reduced-motion block");
        for (const rule of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
          if (!/animation:\s*none/.test(rule[2] as string)) continue;
          for (const sel of (rule[1] as string).split(",").map((s) => s.trim())) {
            if (!sel) continue;
            // `(?!none)` matters: without it this matches the override's own
            // `animation: none` and reports every correct override as dead.
            const decl = new RegExp(
              `${escape(sel)}\\s*\\{[^}]*animation:\\s*(?!none\\b)[a-zA-Z]`,
              "g",
            );
            for (const d of css.matchAll(decl)) {
              if ((d.index as number) > start) dead.push(`${sel} (declared after its override)`);
            }
          }
        }
      }

      expect(dead).toEqual([]);
    });
  }
});
