import { describe, expect, test } from "bun:test";
import { AA_TEXT, contrastRatio, over } from "../contrast.ts";
import { colors, extOnlyColors, type Mode, type Pair, pick } from "../palette.ts";

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
 * Threshold is 4.5:1 throughout, including for type that would qualify for the
 * 3:1 large-text allowance (18.66px bold / 24px regular — the shell has page
 * titles at 24–36px and sets assistant prose at 18px). That allowance is a
 * relaxation, and declining it costs nothing here: every value in the palette
 * clears the stricter bar, so there is no reason to carve out a looser one and
 * then have to track which surfaces may use it.
 *
 * Coverage comes from two places, and the split matters. The `<x>-foreground`
 * on `<x>` pairs are **derived** — every foreground token in the palette is
 * paired with its base automatically, and a foreground with no base is a
 * failure rather than a silent skip. That half needs no maintenance: adding a
 * token to the palette adds its assertion. The pairs in `TEXT_PAIRS` are the
 * ones no convention can reach — a foreground rendered over a ground that is
 * not its own base — and those are hand-listed by necessity. Prefer widening
 * the derived rule over appending to the list; a hand-maintained list of what
 * to check is a denylist by omission, and this file has been bitten by that
 * twice.
 */

type TokenName = keyof typeof colors | keyof typeof extOnlyColors;

function token(name: TokenName, mode: Mode): string {
  const pair =
    (colors as Record<string, Pair>)[name] ?? (extOnlyColors as Record<string, Pair>)[name];
  if (!pair) throw new Error(`unknown token: ${name}`);
  return pick(pair, mode);
}

/**
 * `<x>-foreground` on `<x>`, derived from the palette rather than listed.
 *
 * The naming convention *is* the pairing: `text-card-foreground` is only ever
 * painted on `bg-card`, `text-sidebar-foreground` on `bg-sidebar`, and so on
 * through every shadcn surface. Deriving it means a token added to the palette
 * arrives already asserted, and it closes the hole that made this necessary —
 * five of these were rendered in the shell (`ui/card.tsx`, `ui/badge.tsx`,
 * `InContextPopover.tsx`, `CommandRow.tsx`, and 39 sidebar sites) while sitting
 * outside a hand-written list, passing only because they happened to be
 * byte-identical to a token that was listed.
 */
const DERIVED_PAIRS = Object.keys(colors)
  .filter((name) => name.endsWith("-foreground"))
  .map((fg) => [fg as TokenName, fg.replace(/-foreground$/, "") as TokenName] as const);

/**
 * Text pairs no naming convention can reach: a foreground rendered over a
 * ground that is not its own base. Hand-listed by necessity — add here only
 * when the derived rule genuinely cannot express the pairing.
 */
const TEXT_PAIRS: [fg: TokenName, bg: TokenName, where: string][] = [
  ["foreground", "background", "body copy"],
  ["foreground", "card", "card content"],
  ["foreground", "muted", "segmented controls, active nav"],
  ["muted-foreground", "background", "lead paragraphs"],
  ["muted-foreground", "card", "row sub-lines"],
  ["muted-foreground", "sidebar", "sidebar nav rows"],
  // `text-tertiary` and `background-tertiary` are ext-apps-only: the shell's
  // `:root` never emits them, so the only surface they meet is an embedded
  // iframe, where both are injected together.
  ["text-tertiary", "background-tertiary", "iframe metadata on a tertiary surface"],
  ["text-tertiary", "background", "iframe metadata on the base surface"],
  ["text-tertiary", "card", "iframe metadata on a raised surface"],
  ["primary", "background", "links, accent text"],
  ["primary", "card", "links inside cards"],
  // `.turn-pill__copy:hover` (index.css): `--primary` at 10px on `--info-light`.
  // The tightest pair in the shell — 4.917:1 light, and this palette moved it
  // *toward* the floor from 5.081:1, so it is listed rather than left to the
  // ambient assumption that accent-on-tint is comfortable.
  ["primary", "info-light", "turn-pill copy button, hover"],
  ["processing", "background", "in-progress accent"],
  // No shell component paints this pair; both tokens project into the iframe
  // token map, so it is asserted as an ext-apps contract pairing.
  ["processing", "processing-light", "ext-apps tint pairing"],
  ["success", "card", "status labels"],
  ["warning", "card", "warning text"],
  ["destructive", "card", "error text"],
  // The scope tiers are TEXT: `<span className="ledger-line__scope">{scope}</span>`
  // at 11px, so 4.5:1 is the bar. They are also painted as a non-text tick
  // (`SkillsTab.tsx`), but that one is `aria-hidden` and sits beside a tier
  // divider that names the scope in words — decorative, so 1.4.11 does not
  // apply to it. Asserting the text bar covers both regardless: 4.5:1 is
  // strictly stricter than the 3:1 a non-text element would need. Should that
  // tick ever become load-bearing, it is already covered.
  ["scope-org", "card", "org scope label"],
  ["scope-workspace", "card", "workspace scope label"],
  ["scope-user", "card", "user scope label"],
  ["scope-bundle", "card", "bundle scope label"],
];

describe("palette contrast — derived <x>-foreground on <x>", () => {
  test("every -foreground token has a base, so the rule is total", () => {
    const orphans = DERIVED_PAIRS.filter(([, base]) => !(base in colors)).map(([fg]) => fg);
    expect(orphans).toEqual([]);
    expect(DERIVED_PAIRS.length).toBeGreaterThan(0);
  });

  for (const mode of ["light", "dark"] as const) {
    for (const [fg, base] of DERIVED_PAIRS) {
      test(`${mode}: ${fg} on ${base} clears ${AA_TEXT}:1`, () => {
        expect(contrastRatio(token(fg, mode), token(base, mode))).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});

describe("palette contrast — WCAG 2.2", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const [fg, bg, where] of TEXT_PAIRS) {
      test(`${mode}: ${fg} on ${bg} (${where}) clears ${AA_TEXT}:1`, () => {
        const ratio = contrastRatio(token(fg, mode), token(bg, mode));
        expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }

  /**
   * The tinted family: `<hue>` text on a 10% (light) or 20% (dark) tint of
   * itself.
   *
   * Two of the five hues render today, so do not delete these assertions as
   * hypothetical. `.turn-pill__pre--error` (`index.css`) paints `--destructive`
   * on a 10% mix of itself on every failed tool call in `BlockTimeline.tsx`,
   * and `primary` does the same at `RecentConversationsPopover.tsx:129` and
   * `LinkSafetyModal.tsx:116`.
   *
   * The `cva` variants that declare the same pattern — `Badge` and `Button`'s
   * `destructive`/`success`/`warning`/`processing` — have no call sites yet, so
   * for those hues the assertion is the thing standing between a first
   * `<Badge variant="success">` and shipping below AA against a green suite.
   *
   * That last claim holds for the *supported* path only. Tailwind compiles
   * `bg-<hue>/N` to `color-mix()`, and browsers without it get the minifier's
   * downlevel — the first operand, opaque — so the fill becomes the same value
   * as the text: 1.000:1, whatever is asserted here. Pre-existing and
   * repo-wide; tracked in #781. What this guard buys is the modern path, which
   * is the one the value can actually be chosen for.
   */
  const TINTED: TokenName[] = ["destructive", "success", "warning", "processing", "primary"];
  // Resting states only, and the dark figure is deliberately stricter than what
  // renders: only `destructive` declares a `dark:bg-destructive/20`, so the
  // other four stay at /10 in dark. Asserting /20 for all five is safe because
  // deepening a tint toward its own text colour always lowers contrast — /20 in
  // dark is below /10 for every hue here (e.g. `primary` on the dark card:
  // 4.739 vs 5.545), so the guard demands more than any of them renders.
  //
  // The hover states (/20 light, /30 dark) are NOT asserted, and that is a
  // scoping decision rather than an oversight. Deepening a tint that shares the
  // text's own hue always moves the fill toward the text, so hover reduces
  // contrast by construction: the safe ceiling is /12 for `success` in light,
  // which is indistinguishable from the /10 resting state. The mechanism is
  // wrong, not the value — and neither live consumer has a hover state, so
  // fixing it belongs with the decision about whether those variants (#759)
  // should exist at all.
  for (const mode of ["light", "dark"] as const) {
    const pct = mode === "light" ? 10 : 20;
    for (const hue of TINTED) {
      for (const ground of ["background", "card"] as TokenName[]) {
        test(`${mode}: text-${hue} on ${hue}/${pct} over ${ground} clears ${AA_TEXT}:1`, () => {
          const fill = over(token(hue, mode), token(ground, mode), pct);
          expect(contrastRatio(token(hue, mode), fill)).toBeGreaterThanOrEqual(AA_TEXT);
        });
      }
    }
  }

  for (const mode of ["light", "dark"] as const) {
    test(`${mode}: the primary hover fill keeps its label above ${AA_TEXT}:1`, () => {
      // `hover:bg-primary/90` composited over the page ground.
      const fill = over(token("primary", mode), token("background", mode), 90);
      expect(contrastRatio(token("primary-foreground", mode), fill)).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    });
  }

  // `palette.ts` states the scope tiers are "deliberately distinct from
  // `primary` and from every status hue". Round 2 found that violated —
  // `scope-org` was byte-identical to `primary`, `scope-bundle` to the warning
  // amber — and the fix changed the values and wrote the rule as prose.
  // Contrast still passes when they collapse, so only this catches a repeat.
  const SCOPES: TokenName[] = ["scope-org", "scope-workspace", "scope-user", "scope-bundle"];
  const RESERVED: TokenName[] = ["primary", "success", "warning", "destructive", "processing"];
  for (const mode of ["light", "dark"] as const) {
    for (const scope of SCOPES) {
      test(`${mode}: ${scope} is distinct from every brand and status hue`, () => {
        for (const reserved of RESERVED) {
          expect(token(scope, mode)).not.toBe(token(reserved, mode));
        }
      });
    }
    test(`${mode}: the four scope tiers are distinct from each other`, () => {
      const values = SCOPES.map((s) => token(s, mode));
      expect(new Set(values).size).toBe(SCOPES.length);
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
 * looks like a tint. These assert the derivation instead of trusting it, and
 * then assert the composited result the same way the tinted-badge family is
 * asserted.
 *
 * The pairing is real on both: `.presence-user-message` paints `--foreground`
 * on `--foreground-tint`, and `.turn-pill__pre--error` paints `--destructive`
 * on `--destructive-tint` for every failed tool call.
 */
describe("translucent tints track their source token", () => {
  const TINTS: [tint: string, source: TokenName][] = [
    ["foreground-tint", "foreground"],
    ["destructive-tint", "destructive"],
  ];

  for (const mode of ["light", "dark"] as const) {
    for (const [tint, source] of TINTS) {
      test(`${mode}: ${tint} is 10% of ${source}`, () => {
        const value = pick((colors as Record<string, Pair>)[tint] as Pair, mode);
        const hex = token(source, mode).replace("#", "");
        const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        expect(value.replace(/\s+/g, "")).toBe(`rgba(${r},${g},${b},0.1)`);
      });

      for (const ground of ["background", "card"] as TokenName[]) {
        test(`${mode}: ${source} on ${tint} over ${ground} clears ${AA_TEXT}:1`, () => {
          const fill = over(token(source, mode), token(ground, mode), 10);
          expect(contrastRatio(token(source, mode), fill)).toBeGreaterThanOrEqual(AA_TEXT);
        });
      }
    }
  }
});
