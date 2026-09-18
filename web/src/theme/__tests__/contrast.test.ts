import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, deltaEOk, JND_OK } from "../contrast.ts";
import {
  ALPHA_TEXT,
  type ColorPalette,
  contrastChecks,
  derivedPairs,
  type TokenName,
  TRANSLUCENT_TINTS,
  tokenValue,
} from "../contrast-pairs.ts";
import { colors, extOnlyColors, type Mode, pick } from "../palette.ts";

/**
 * WCAG 2.2 contrast, computed from the palette rather than compared against a
 * copy of it. This is the one theme guard that cannot be made circular: it
 * derives ratios from the actual values, so it fails on a bad colour even if
 * every fixture in the repo was regenerated from that same bad colour.
 *
 * It earns its place. This palette's predecessor was full of pairs below AA
 * and nothing caught them: `warning` sat at 2.148:1 on card, `text-tertiary`
 * below 4.5:1 on every surface in both modes (worst 2.397:1), `success` and
 * `scope-workspace` at 3.768:1, `muted-foreground` at 4.429:1 on both `muted`
 * and `sidebar`. No total is quoted here on purpose — it moves whenever the
 * pair set widens, and a count in a docblock has no way to notice.
 *
 * The pairs themselves live in `contrast-pairs.ts`, because the runtime runs
 * the same list against a tenant brand merged over this palette and rejects a
 * brand that fails any of them. This file asserts that list against the
 * canonical palette, plus the guards that are about the palette's own values
 * rather than about readability.
 */

const palette = { colors, extOnlyColors } as ColorPalette;

function token(name: TokenName, mode: Mode): string {
  return tokenValue(palette, name, mode);
}

const DERIVED_PAIRS = derivedPairs(Object.keys(colors));

describe("palette contrast — derived <x>-foreground on <x>", () => {
  test("every -foreground token has a base, so the rule is total", () => {
    const orphans = DERIVED_PAIRS.filter(([, base]) => !(base in colors)).map(([fg]) => fg);
    expect(orphans).toEqual([]);
    expect(DERIVED_PAIRS.length).toBeGreaterThan(0);
  });
});

describe("palette contrast — WCAG 2.2", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const check of contrastChecks(palette, mode)) {
      test(`${mode}: ${check.name} clears ${check.min}:1`, () => {
        expect(contrastRatio(check.fg, check.bg)).toBeGreaterThanOrEqual(check.min);
      });
    }
  }

  // `palette.ts` states the scope tiers are "deliberately distinct from
  // `primary` and from every status hue". Round 2 found that violated —
  // `scope-org` was byte-identical to `primary`, `scope-connector` to the warning
  // amber — and the fix changed the values and wrote the rule as prose.
  // Contrast still passes when they collapse, so only this catches a repeat.
  //
  // Distinctness is measured perceptually, not by byte inequality: the failure
  // being guarded against is a tier badge that *looks* like a primary action,
  // and two hexes a fraction of a just-noticeable difference apart do that
  // while comparing unequal. `JND_OK` is the floor — one JND, the point below
  // which the two are the same colour in different clothes.
  const SCOPES: TokenName[] = ["scope-org", "scope-workspace", "scope-user", "scope-connector"];
  const RESERVED: TokenName[] = ["primary", "success", "warning", "destructive", "processing"];
  for (const mode of ["light", "dark"] as const) {
    for (const scope of SCOPES) {
      test(`${mode}: ${scope} is distinct from every brand and status hue`, () => {
        for (const reserved of RESERVED) {
          const d = deltaEOk(token(scope, mode), token(reserved, mode));
          expect(d, `${scope} vs ${reserved}: ΔE-OK ${d.toFixed(4)}`).toBeGreaterThan(JND_OK);
        }
      });
    }
    test(`${mode}: the four scope tiers are distinct from each other`, () => {
      for (const [i, scope] of SCOPES.entries()) {
        for (const other of SCOPES.slice(i + 1)) {
          const d = deltaEOk(token(scope, mode), token(other, mode));
          expect(d, `${scope} vs ${other}: ΔE-OK ${d.toFixed(4)}`).toBeGreaterThan(JND_OK);
        }
      }
    });
  }

  test("the ratio maths is right (black on white is 21:1)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});
/**
 * The two translucent tints in the palette are 10% alpha over their source
 * token. Because `rgba()` spells the channels out, they can drift from the hex
 * they were derived from — silently, since a wrong-but-plausible grey still
 * looks like a tint. This asserts the derivation instead of trusting it; the
 * composited result is asserted with every other pair in `contrastChecks`.
 */
describe("translucent tints track their source token", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const [tint, source] of TRANSLUCENT_TINTS) {
      test(`${mode}: ${tint} is 10% of ${source}`, () => {
        const value = pick(colors[tint], mode);
        const hex = token(source, mode).replace("#", "");
        const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        expect(value.replace(/\s+/g, "")).toBe(`rgba(${r},${g},${b},0.1)`);
      });
    }
  }
});

/**
 * Foreground alpha — `text-<token>/N` — computed rather than assumed.
 *
 * Tailwind resolves `/N` on a text colour the same way it does on a background:
 * the token is composited toward whatever is behind it. So the rendered ratio is
 * not the token's, and no assertion over token values can see it. This is the
 * third alpha family, after the tinted backgrounds and `primary/90`, and it was
 * the largest: 35 sites across seven combinations, of which every one but
 * `text-foreground/N` sat below AA — the worst a 10px uppercase section label at
 * `sidebar-foreground/40`, **1.833:1**, in the resting state, in both modes.
 *
 * They are gone now, not exempted. The sidebar's hierarchy came entirely from
 * this ramp, because `sidebar-foreground` and `muted-foreground` are the same
 * value — one text colour, four opacities. Rebuilding four levels in colour
 * needs room below `sidebar-foreground` (6.331) and there is none: the step
 * that still clears 4.5:1 is about one increment wide, a rounding error rather
 * than a hierarchy. So the ramp is retired and size, weight and case carry the
 * levels, which is what `palette.ts` already requires of the scope tiers —
 * colour never encodes a distinction alone.
 *
 * Upward, room does exist, and selection takes it. `foreground` on `sidebar` is
 * 19.061 light / 19.172 dark, against 6.331 / 7.259 for the inactive rows —
 * which is what `SettingsShell` already does for the same interaction, a
 * vertical nav list with one selected item (`bg-accent text-accent-foreground`
 * against `text-muted-foreground`, and those two tokens are byte-identical to
 * these). Selection is the highest-value thing a nav says, so it gets the
 * strongest channel rather than the weakest.
 *
 * The weight step stays alongside it. 1.4.1 wants a channel that is not colour,
 * and the background tint is 1.152:1 — below any bar — so weight is what
 * carries the state when colour cannot. Hierarchy (size, case, `font-bold` on
 * the section labels) is a separate axis from selection, and only selection
 * gets the colour.
 *
 * The guard is a scanner plus a table rather than a table alone, because a
 * hand-listed set of things to check is a denylist by omission — the failure
 * this file has been bitten by more than once. The scanner makes the set total:
 * a new `text-<token>/N` anywhere in `web/src` fails until someone records the
 * ground it renders on in `ALPHA_TEXT` (`contrast-pairs.ts`), and recording it
 * puts the ratio into `contrastChecks`.
 */
describe("foreground alpha — text-<token>/N", () => {
  const declared = new Set(ALPHA_TEXT.map(([t, p]) => `text-${t}/${p}`));

  /**
   * Matches an alpha modifier on a *palette colour*, in either of the two forms
   * Tailwind accepts.
   *
   * Anchored on the palette's own key names rather than `[a-z][\w-]*`, longest
   * first, so `text-sm/6` — the font-size/line-height shorthand, which is not a
   * colour at all — cannot be reported as a contrast violation.
   *
   * The arbitrary form (`text-foreground/[0.4]`) is matched too, and can never
   * be declared, because a bracketed fraction is not a percentage this file can
   * composite. That is the intended outcome: the guard says don't write them.
   * It is not hypothetical syntax here — `bg-foreground/[0.02]` is already in
   * use at three sites, and a text alpha reached for the same way would
   * otherwise walk straight past a guard whose whole claim is totality.
   */
  const ALPHA_CLASS = new RegExp(
    `text-(?:${[...Object.keys(colors), ...Object.keys(extOnlyColors)]
      .sort((a, b) => b.length - a.length)
      .join("|")})/(?:\\d{1,3}|\\[[^\\]]+\\])`,
    "g",
  );

  test("every text-<token>/N the compiler can see is declared in ALPHA_TEXT", () => {
    // The root is `web/`, not `web/src`. `index.css` has no `@source` pin, so
    // Tailwind v4 auto-detects across the whole app directory — a class in
    // `index.html` compiles to a live rule. A guard whose entire claim is
    // totality has to walk what the compiler walks, so it walks from there and
    // subtracts only what the compiler already ignores.
    const root = join(import.meta.dir, "..", "..", "..");
    const UNSCANNED = new Set(["node_modules", "dist", "coverage", "test", "__tests__"]);
    // Files the compiler cannot read a class out of. Everything else is
    // scanned, including `.js` and `.html`: `public/config.js` ships, and a
    // class string is a class string whatever holds it. Listing what to scan
    // instead would make a new file type default to invisible — the same
    // denylist-by-omission this guard exists to end.
    const NOT_SOURCE =
      /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|webm|pdf|zip|map)$/i;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        // Tests are skipped — including this one, which names the arbitrary
        // form in prose — because nothing in them renders.
        if (statSync(p).isDirectory()) return UNSCANNED.has(e) ? [] : walk(p);
        return NOT_SOURCE.test(e) || /\.test\.tsx?$/.test(e) ? [] : [p];
      });

    const undeclared = new Set<string>();
    for (const file of walk(root)) {
      for (const [cls] of readFileSync(file, "utf8").matchAll(ALPHA_CLASS)) {
        if (!declared.has(cls)) undeclared.add(`${cls} — ${file.slice(root.length + 1)}`);
      }
    }
    expect([...undeclared].sort().join("\n")).toBe("");
  });
});
