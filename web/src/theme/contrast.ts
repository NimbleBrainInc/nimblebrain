/**
 * WCAG 2.2 contrast maths, and alpha compositing to go with it.
 *
 * Lives beside the palette rather than inside a test because two guards need
 * it: `__tests__/contrast.test.ts` asserts the palette's own pairs, and
 * `test/unit/bundles/animated-dot-contrast.test.ts` asserts what a bundle's
 * animation does to one of them. Formulas copied into a second file are the
 * shape this theme system has already been bitten by; there is one copy.
 */

/** WCAG 1.4.3 minimum for body text. */
export const AA_TEXT = 4.5;

/** WCAG 1.4.11 minimum for a non-text element that carries information. */
export const AA_NON_TEXT = 3;

function srgbToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The smallest OKLab distance at which two colours read as different colours.
 *
 * Roughly one just-noticeable difference. Below it, two tokens are the same
 * colour wearing different hexes — which is what a byte comparison cannot see.
 *
 * Scaled from CIELAB rather than taken from a study of OKLab directly, because
 * no equivalent threshold is published for it: the long-standing CIE figure is
 * ΔE*ab ≈ 2.3, and OKLab's axes are the same perceptual quantities on an L
 * range of 0–1 where CIELAB's is 0–100, so 2.3/100 ≈ 0.023. Rounded down to
 * 0.02, which is the stricter direction — it fails a pair sooner, and a guard
 * that trips early is the safe error here.
 *
 * This is a floor for *distinguishability*, not a target. A pair sitting just
 * above it is legible as two colours and is still probably too close to carry
 * different meanings; the palette should clear it by a wide margin, and this
 * catches the collapse, not the crowding.
 */
export const JND_OK = 0.02;

/**
 * Perceptual distance between two colours, as Euclidean distance in OKLab.
 *
 * WCAG contrast answers "can this be read against that ground" and says
 * nothing about "can these two be told apart", which is the question a palette
 * asks of any two tokens that must not be confused for each other. Lightness
 * alone cannot answer it either: two hues can share a luminance exactly and
 * still be plainly different colours.
 */
export function deltaEOk(a: string, b: string): number {
  const [al, aa, ab] = oklab(a);
  const [bl, ba, bb] = oklab(b);
  return Math.hypot(al - bl, aa - ba, ab - bb);
}

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Composite `fg` over `bg` at `pct` percent opacity.
 *
 * Covers both things that produce a translucent fill here: Tailwind's `/N`,
 * which compiles to `color-mix(… N%, transparent)` and therefore resolves to
 * `pct` of the token over whatever is behind it, and a CSS `opacity` on an
 * element, which composites the same way.
 */
export function over(fg: string, bg: string, pct: number): string {
  const [ar, ag, ab] = channels(fg);
  const [br, bg_, bb] = channels(bg);
  const mix = (x: number, y: number) => Math.round((x * pct + y * (100 - pct)) / 100);
  return `#${[mix(ar, br), mix(ag, bg_), mix(ab, bb)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}
