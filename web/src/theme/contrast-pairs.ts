/**
 * Every contrast pair the palette must clear, as a function of a palette.
 *
 * Two readers need the same list: `__tests__/contrast.test.ts` asserts it
 * against the canonical palette, and the runtime's brand loader asserts it
 * against a tenant's palette merged over the canonical one, rejecting a brand
 * that fails any pair. One list, so a pair added for the canonical palette is
 * enforced on every brand from that moment.
 *
 * Threshold is 4.5:1 throughout, including for type that would qualify for the
 * 3:1 large-text allowance (18.66px bold / 24px regular — the shell has page
 * titles at 24–36px and sets assistant prose at 18px). That allowance is a
 * relaxation, and declining it costs nothing: the canonical palette clears the
 * stricter bar everywhere, so there is no reason to carve out a looser one and
 * then have to track which surfaces may use it.
 *
 * Coverage comes from two places, and the split matters. The `<x>-foreground`
 * on `<x>` pairs are **derived** — every foreground token is paired with its
 * base automatically, and a foreground with no base is a failure rather than a
 * silent skip. That half needs no maintenance: adding a token to the palette
 * adds its assertion. The pairs in {@link TEXT_PAIRS} are the ones no convention
 * can reach — a foreground rendered over a ground that is not its own base — and
 * those are hand-listed by necessity. Prefer widening the derived rule over
 * appending to the list; a hand-maintained list of what to check is a denylist
 * by omission.
 *
 * Leaf module: no DOM, no React. The runtime imports it without `web/`
 * dependencies installed.
 */

import { AA_TEXT, over } from "./contrast.ts";
import { type colors, type extOnlyColors, type Mode, type Pair, pick } from "./palette.ts";

export type ColorToken = keyof typeof colors;
export type ExtColorToken = keyof typeof extOnlyColors;
export type TokenName = ColorToken | ExtColorToken;

/** The colour half of a palette: the shape `palette.ts` exports and a merged brand returns. */
export interface ColorPalette {
  colors: Record<ColorToken, Pair>;
  extOnlyColors: Record<ExtColorToken, Pair>;
}

/** Read one token for a mode from either colour map. */
export function tokenValue(palette: ColorPalette, name: TokenName, mode: Mode): string {
  const pair =
    (palette.colors as Record<string, Pair>)[name] ??
    (palette.extOnlyColors as Record<string, Pair>)[name];
  if (!pair) throw new Error(`unknown token: ${name}`);
  return pick(pair, mode);
}

/**
 * `<x>-foreground` on `<x>`, derived from token names rather than listed.
 *
 * The naming convention *is* the pairing: `text-card-foreground` is only ever
 * painted on `bg-card`, `text-sidebar-foreground` on `bg-sidebar`, and so on
 * through every shadcn surface. Deriving it means a token added to the palette
 * arrives already asserted.
 */
export function derivedPairs(names: readonly string[]): [fg: TokenName, base: TokenName][] {
  return names
    .filter((name) => name.endsWith("-foreground"))
    .map((fg) => [fg as TokenName, fg.replace(/-foreground$/, "") as TokenName]);
}

/**
 * Text pairs no naming convention can reach: a foreground rendered over a
 * ground that is not its own base. Hand-listed by necessity — add here only
 * when the derived rule genuinely cannot express the pairing.
 */
export const TEXT_PAIRS: readonly [fg: TokenName, bg: TokenName, where: string][] = [
  ["foreground", "background", "body copy"],
  ["foreground", "card", "card content"],
  ["foreground", "muted", "segmented controls, active nav"],
  ["muted-foreground", "background", "lead paragraphs"],
  ["muted-foreground", "card", "row sub-lines"],
  ["muted-foreground", "sidebar", "sidebar nav rows"],
  ["foreground", "sidebar", "the active sidebar nav row"],
  // `text-tertiary` and `background-tertiary` are ext-apps-only: the shell's
  // `:root` never emits them, so the only surface they meet is an embedded
  // iframe, where both are injected together.
  ["text-tertiary", "background-tertiary", "iframe metadata on a tertiary surface"],
  ["text-tertiary", "background", "iframe metadata on the base surface"],
  ["text-tertiary", "card", "iframe metadata on a raised surface"],
  ["primary", "background", "links, accent text"],
  ["primary", "card", "links inside cards"],
  // `.turn-pill__copy:hover` (index.css): `--primary` at 10px on `--info-light`.
  // The tightest pair in the shell, so it is listed rather than left to the
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
  // strictly stricter than the 3:1 a non-text element would need.
  ["scope-org", "card", "org scope label"],
  ["scope-workspace", "card", "workspace scope label"],
  ["scope-user", "card", "user scope label"],
  ["scope-connector", "card", "connector scope label"],
];

/**
 * The tinted family: `<hue>` text on a 10% (light) or 20% (dark) tint of
 * itself, over the page ground and over a card.
 *
 * Two of the five hues render today: `.turn-pill__pre--error` (`index.css`)
 * paints `--destructive` on a 10% mix of itself on every failed tool call, and
 * `primary` does the same in `RecentConversationsPopover.tsx` and
 * `LinkSafetyModal.tsx`. The `cva` variants that declare the same pattern —
 * `Badge` and `Button`'s `destructive`/`success`/`warning`/`processing` — have
 * no call sites yet, so for those hues the assertion is what stands between a
 * first `<Badge variant="success">` and shipping below AA.
 *
 * That holds for the *supported* path only. Tailwind compiles `bg-<hue>/N` to
 * `color-mix()`, and browsers failing its `@supports` test get the unguarded
 * fallback — the first operand, opaque — so the fill becomes the text colour:
 * 1.000:1, whatever is asserted here. Tracked in #781.
 *
 * Resting states only, and the dark figure is deliberately stricter than what
 * renders: only `destructive` declares a `dark:bg-destructive/20`, so the other
 * four stay at /10 in dark. Deepening a tint toward its own text colour always
 * lowers contrast, so asserting /20 for all five demands more than any of them
 * renders. Hover states (/20 light, /30 dark) are not asserted: deepening a tint
 * of the text's own hue moves the fill toward the text by construction, and
 * neither live consumer has a hover state (#759).
 */
export const TINTED_HUES: readonly TokenName[] = [
  "destructive",
  "success",
  "warning",
  "processing",
  "primary",
];

/**
 * The two translucent tints in the palette, each 10% alpha over its source
 * token. The pairing is real on both: `.presence-user-message` paints
 * `--foreground` on `--foreground-tint`, and `.turn-pill__pre--error` paints
 * `--destructive` on `--destructive-tint` for every failed tool call.
 */
export const TRANSLUCENT_TINTS: readonly [tint: ColorToken, source: ColorToken][] = [
  ["foreground-tint", "foreground"],
  ["destructive-tint", "destructive"],
];

/**
 * Every `text-<token>/N` combination in the shell, with the ground(s) it is
 * painted on. Tailwind composites a text colour's `/N` toward whatever is
 * behind it, so the rendered ratio is not the token's. `contrast.test.ts` scans
 * the web source for these classes, so a new one fails until it is recorded
 * here, and recording it computes the ratio.
 */
export const ALPHA_TEXT: readonly [token: TokenName, pct: number, grounds: TokenName[]][] = [
  // `BriefingView` list items and the `SkillsTab` description, both on the
  // page ground.
  ["foreground", 80, ["background", "card"]],
];

/** One contrast assertion, resolved to concrete colours for a mode. */
export interface ContrastCheck {
  /** Human-readable: which tokens, composited how, and where it renders. */
  name: string;
  fg: string;
  bg: string;
  min: number;
}

/**
 * Every contrast assertion the palette makes, for one mode, resolved against
 * `palette`. Composited fills are computed here with {@link over}, so the
 * caller only compares `contrastRatio(fg, bg)` against `min`.
 */
export function contrastChecks(palette: ColorPalette, mode: Mode): ContrastCheck[] {
  const t = (name: TokenName) => tokenValue(palette, name, mode);
  const checks: ContrastCheck[] = [];
  const add = (name: string, fg: string, bg: string) => checks.push({ name, fg, bg, min: AA_TEXT });

  for (const [fg, base] of derivedPairs(Object.keys(palette.colors))) {
    add(`${fg} on ${base}`, t(fg), t(base));
  }

  for (const [fg, bg, where] of TEXT_PAIRS) add(`${fg} on ${bg} (${where})`, t(fg), t(bg));

  const tintPct = mode === "light" ? 10 : 20;
  for (const hue of TINTED_HUES) {
    for (const ground of ["background", "card"] as const) {
      add(`${hue} on ${hue}/${tintPct} over ${ground}`, t(hue), over(t(hue), t(ground), tintPct));
    }
  }

  // The sidebar's own tint family. `bg-sidebar-foreground/N` over `bg-sidebar`
  // carries hover and the active row throughout the shell, and is a tint of the
  // text colour itself. The `kbd` in SidebarSearch is the floor: a /10 chip
  // inside the trigger's own /5 fill, two tints deep.
  const sidebar = t("sidebar");
  const sidebarText = t("sidebar-foreground");
  const sidebarHover = over(sidebarText, sidebar, 5);
  add("sidebar-foreground on sidebar-foreground/5 (hover)", sidebarText, sidebarHover);
  add(
    "sidebar-foreground on sidebar-foreground/10 (active)",
    sidebarText,
    over(sidebarText, sidebar, 10),
  );
  add(
    "sidebar-foreground on the search kbd (/10 over the trigger's /5)",
    sidebarText,
    over(sidebarText, sidebarHover, 10),
  );

  // `hover:bg-primary/90` composited over the page ground, under its label.
  add(
    "primary-foreground on primary/90 over background (primary hover)",
    t("primary-foreground"),
    over(t("primary"), t("background"), 90),
  );

  for (const [tint, source] of TRANSLUCENT_TINTS) {
    for (const ground of ["background", "card"] as const) {
      add(`${source} on ${tint} over ${ground}`, t(source), over(t(source), t(ground), 10));
    }
  }

  for (const [name, pct, grounds] of ALPHA_TEXT) {
    for (const ground of grounds) {
      add(`${name}/${pct} on ${ground}`, over(t(name), t(ground), pct), t(ground));
    }
  }

  return checks;
}
