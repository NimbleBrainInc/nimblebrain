import { describe, expect, test } from "bun:test";
import { colors, extOnlyColors, type Mode, type Pair, pick } from "../palette.ts";

/**
 * WCAG 2.2 contrast, computed from the palette rather than compared against a
 * copy of it. This is the one theme guard that cannot be made circular: it
 * derives ratios from the actual values, so it fails on a bad colour even if
 * every fixture in the repo was regenerated from that same bad colour.
 *
 * It earns its place. Run against the palette these values replaced, it failed
 * nine checks — `text-tertiary` was below 4.5:1 on every surface in BOTH modes
 * while carrying tallies, kbd hints, section labels, and row metadata, and the
 * system scope rail sat at 1.73:1 while encoding real information.
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
  ["text-tertiary", "background", "tallies, kbd hints"],
  ["text-tertiary", "card", "row metadata"],
  ["text-tertiary", "sidebar", "section labels"],
  ["primary", "background", "links, accent text"],
  ["primary", "card", "links inside cards"],
  ["primary-foreground", "primary", "primary button label"],
  ["primary", "primary-light", "badge text on tint"],
  ["processing", "background", "in-progress accent"],
  ["processing", "processing-light", "badge text on tint"],
  ["success", "card", "status labels"],
  ["warning", "card", "warning text"],
  ["destructive", "card", "error text"],
  ["sidebar-accent-foreground", "sidebar-accent", "active sidebar row"],
];

/** Information-bearing non-text. A decorative hairline would not belong here. */
const NON_TEXT_PAIRS: [fg: TokenName, bg: TokenName, where: string][] = [
  ["scope-org", "card", "org scope rail"],
  ["scope-workspace", "card", "workspace scope rail"],
  ["scope-user", "card", "user scope rail"],
  ["scope-bundle", "card", "bundle scope rail"],
  ["ring", "background", "focus ring"],
  ["success", "card", "status dot"],
  ["destructive", "card", "error indicator"],
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
