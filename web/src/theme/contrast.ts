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

export function relativeLuminance(hex: string): number {
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
