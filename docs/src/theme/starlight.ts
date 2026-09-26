/**
 * Projects the runtime's canonical palette onto Starlight's theme variables.
 *
 * This is the one place the docs' colours and fonts meet `web/src/theme/palette.ts`.
 * Nothing here restates a value: every colour and font stack is read from the palette at
 * build time, so a change there repaints the docs on the next build.
 *
 * Starlight's gray scale inverts between themes. `white` is always the strongest text and
 * `black` the page ground; `gray-1` is the strongest step and `gray-6` the quietest
 * surface. Body copy uses `gray-2`, secondary text `gray-3`, hairlines `gray-5`, and the
 * sidebar and nav sit on `gray-6`.
 */

import { colors, extOnlyColors, fonts, type Mode, pick } from "../../../web/src/theme/palette";

type Key = keyof typeof colors | keyof typeof extOnlyColors;

function value(key: Key, mode: Mode): string {
  const pair = key in colors ? colors[key as keyof typeof colors] : extOnlyColors[key as keyof typeof extOnlyColors];
  return pick(pair, mode);
}

/** Starlight variable → palette key, per mode. */
const map: Record<string, Key> = {
  "--sl-color-accent": "primary",
  "--sl-color-accent-high": "primary",
  "--sl-color-accent-low": "info-light",
  "--sl-color-white": "foreground",
  "--sl-color-black": "background",
  "--sl-color-gray-1": "foreground",
  "--sl-color-gray-2": "foreground",
  "--sl-color-gray-3": "muted-foreground",
  "--sl-color-gray-4": "text-tertiary",
  "--sl-color-gray-5": "border",
  "--sl-color-gray-6": "secondary",
  "--sl-color-gray-7": "sidebar",
  "--sl-color-bg-sidebar": "sidebar",
};

/**
 * Starlight's aside and badge hues → the palette's one accent and its status colours.
 * `tint` names the palette's own tint where it has one; otherwise the tint is mixed from
 * the hue over the page ground.
 */
const hues: Record<string, { hue: Key; tint?: Key }> = {
  blue: { hue: "primary", tint: "info-light" },
  purple: { hue: "processing", tint: "processing-light" },
  green: { hue: "success" },
  orange: { hue: "warning" },
  red: { hue: "destructive" },
};

function block(selector: string, mode: Mode): string {
  const lines = Object.entries(map).map(([name, key]) => `  ${name}: ${value(key, mode)};`);
  for (const [name, { hue, tint }] of Object.entries(hues)) {
    const color = value(hue, mode);
    const low = tint
      ? value(tint, mode)
      : `color-mix(in srgb, ${color} 14%, ${value("background", mode)})`;
    lines.push(`  --sl-color-${name}-low: ${low};`);
    lines.push(`  --sl-color-${name}: ${color};`);
    lines.push(`  --sl-color-${name}-high: ${color};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/** The stylesheet the docs inline into every page's head. */
export function starlightThemeCss(): string {
  return [
    // Starlight's default theme is dark; `data-theme='light'` switches to light.
    block(":root", "dark"),
    block(":root[data-theme='light']", "light"),
    `:root {\n  --sl-font: ${fonts.sans};\n  --sl-font-mono: ${fonts.mono};\n}`,
  ].join("\n\n");
}
