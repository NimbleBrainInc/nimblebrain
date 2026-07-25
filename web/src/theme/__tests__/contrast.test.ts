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
 * Thresholds: 4.5:1 for text, because the shell's type tops out at 16px and
 * most of it is 10–14px (the 3:1 large-text allowance needs 18.66px bold or
 * 24px regular, which only marketing display sizes reach); 3:1 for
 * information-bearing non-text per WCAG 1.4.11.
 */

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

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
  ["processing", "processing-light", "badge text on tint"],
  ["success", "card", "status labels"],
  ["warning", "card", "warning text"],
  ["destructive", "card", "error text"],
];

/**
 * Information-bearing non-text at the 3:1 bar.
 *
 * Deliberately short. A pair whose tokens are also asserted at 4.5:1 in
 * TEXT_PAIRS cannot fail here on its own — `ring` is `primary`, and `success`
 * and `destructive` are already tested on `card` — so those are omitted. The
 * scope tiers earn their place: they have values of their own and appear
 * nowhere in the text list.
 */
const NON_TEXT_PAIRS: [fg: TokenName, bg: TokenName, where: string][] = [
  ["scope-org", "card", "org scope rail"],
  ["scope-workspace", "card", "workspace scope rail"],
  ["scope-user", "card", "user scope rail"],
  ["scope-bundle", "card", "bundle scope rail"],
];

describe("palette contrast — WCAG 2.2", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const [fg, bg, where] of TEXT_PAIRS) {
      test(`${mode}: ${fg} on ${bg} (${where}) clears ${AA_TEXT}:1`, () => {
        const ratio = contrastRatio(token(fg, mode), token(bg, mode));
        expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }

    for (const [fg, bg, where] of NON_TEXT_PAIRS) {
      test(`${mode}: ${fg} on ${bg} (${where}) clears ${AA_NON_TEXT}:1`, () => {
        const ratio = contrastRatio(token(fg, mode), token(bg, mode));
        expect(ratio).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }

  test("the ratio maths is right (black on white is 21:1)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});
