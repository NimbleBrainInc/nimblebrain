import { describe, expect, test } from "bun:test";
import { colors, extOnlyColors, type Mode, type Pair, pick } from "../palette.ts";

/**
 * WCAG 2.2 contrast, computed from the palette rather than compared against a
 * copy of it. This is the one theme guard that cannot be made circular: it
 * derives ratios from the actual values, so it fails on a bad colour even if
 * every fixture in the repo was regenerated from that same bad colour.
 *
 * It earns its place: ten pairs in this palette's predecessor were below AA and
 * nothing caught them. `warning` sat at 2.148:1 on card, `text-tertiary` below
 * 4.5:1 on every surface in both modes (worst 2.397:1), `success` at 3.768:1,
 * and `muted-foreground` at 4.429:1 on both `muted` and `sidebar`.
 *
 * Threshold is 4.5:1 throughout: the shell's type tops out at 16px and most of
 * it is 10–14px, so the 3:1 large-text allowance (18.66px bold / 24px regular)
 * never applies. Everything the palette colours here is text.
 */

const AA_TEXT = 4.5;

/**
 * Composite an alpha-over-ground colour the way `hover:bg-primary/N` resolves.
 *
 * Tailwind's `/N` becomes `color-mix(… N%, transparent)`, so the rendered fill
 * is the token blended with whatever is behind it. Every pair below is opaque
 * token-on-token, which means alpha states are invisible to this guard unless
 * they are composited here first — and that is where the product's most-clicked
 * control lives.
 */
function over(fg: string, bg: string, pct: number): string {
  const ch = (h: string, i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  const [a, b] = [fg.replace("#", ""), bg.replace("#", "")];
  const mix = (i: number) => Math.round((ch(a, i) * pct + ch(b, i) * (100 - pct)) / 100);
  return `#${[0, 2, 4].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}

function srgbToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

type TokenName = keyof typeof colors | keyof typeof extOnlyColors;

function token(name: TokenName, mode: Mode): string {
  const pair =
    (colors as Record<string, Pair>)[name] ?? (extOnlyColors as Record<string, Pair>)[name];
  if (!pair) throw new Error(`unknown token: ${name}`);
  return pick(pair, mode);
}

/** Text pairs the shell actually renders, and where each appears. */
const TEXT_PAIRS: [fg: TokenName, bg: TokenName, where: string][] = [
  ["foreground", "background", "body copy"],
  ["foreground", "card", "card content"],
  ["foreground", "muted", "segmented controls, active nav"],
  ["muted-foreground", "background", "lead paragraphs"],
  ["muted-foreground", "card", "row sub-lines"],
  ["muted-foreground", "muted", "group headers"],
  ["muted-foreground", "sidebar", "sidebar nav rows"],
  // `text-tertiary` and `background-tertiary` are ext-apps-only: the shell's
  // `:root` never emits them, so the only surface they meet is an embedded
  // iframe, where both are injected together.
  ["text-tertiary", "background-tertiary", "iframe metadata on a tertiary surface"],
  ["text-tertiary", "background", "iframe metadata on the base surface"],
  ["text-tertiary", "card", "iframe metadata on a raised surface"],
  ["primary", "background", "links, accent text"],
  ["primary", "card", "links inside cards"],
  ["primary-foreground", "primary", "primary button label"],
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
   * The tinted-badge family: `bg-<hue>/10` (light) or `/20` (dark) behind
   * `text-<hue>`, declared once in `ui/badge.tsx` and `ui/button.tsx`. Nothing
   * consumes these variants today, so a failure here is latent — which is
   * exactly why it needs asserting: the first `<Badge variant="success">` would
   * otherwise ship below AA against a green suite.
   */
  const TINTED: TokenName[] = ["destructive", "success", "warning", "processing", "primary"];
  // Resting state only: /10 in light, /20 in dark.
  //
  // The hover states (/20 light, /30 dark) are NOT asserted, and that is a
  // scoping decision rather than an oversight. Deepening a tint that shares the
  // text's own hue always moves the fill toward the text, so hover reduces
  // contrast by construction: the safe ceiling is /12 for `success` in light,
  // which is indistinguishable from the /10 resting state. The mechanism is
  // wrong, not the value, and no component consumes these variants today —
  // fixing it belongs with the decision about whether they should exist at all.
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
