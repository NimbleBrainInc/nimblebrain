/**
 * sRGB hex ↔ OKLCH, for deriving a brand's neutrals and surfaces.
 *
 * OKLCH separates lightness from hue and chroma, so a derivation can keep a
 * canonical token's lightness (and with it, near enough, its contrast) while
 * moving its hue to the brand's, and can step surfaces by equal perceived
 * lightness. Conversions follow Björn Ottosson's OKLab definition.
 *
 * Leaf module: no DOM, no React. The runtime imports it without `web/`
 * dependencies installed.
 */

export interface Oklch {
  /** Perceived lightness, 0–1. */
  l: number;
  /** Chroma, 0 to about 0.37 inside sRGB. */
  c: number;
  /** Hue angle in degrees. */
  h: number;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l: L, c: Math.hypot(a, bb), h: h < 0 ? h + 360 : h };
}

/** Linear sRGB for an OKLCH color, possibly outside [0, 1]. */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/**
 * The `#rrggbb` for an OKLCH color. A color outside sRGB keeps its lightness
 * and hue and gives up chroma until it fits, so a derived surface never shifts
 * lightness, which is what its contrast rests on.
 */
export function oklchToHex(color: Oklch): string {
  let { c } = color;
  let rgb = oklchToLinear({ ...color, c });
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      c = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c }))) lo = c;
      else hi = c;
    }
    rgb = oklchToLinear({ ...color, c: lo });
  }
  const byte = (v: number) =>
    Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${rgb.map(byte).join("")}`;
}
