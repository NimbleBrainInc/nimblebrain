/**
 * A theme token's fallback lives in the token's value. A `var()` call site
 * never repeats it.
 *
 * `var(--color-text-secondary, #5c5c66)` looks defensive and is not. In a
 * host-themed tree the token always has a value: `buildThemeStyleBlock` injects
 * all of `paletteToExtAppsTokens` into the iframe's `<style>` before the app
 * renders, and a `srcdoc` iframe inherits nothing else, so there is no state in
 * which the host is present and the token is absent. The fallback is therefore
 * dead in every case except one — a token name that does not exist — and that
 * is exactly the case where a second value does harm rather than good: instead
 * of failing loudly it renders a plausible colour, usually the light-palette
 * one, so the defect only surfaces in dark mode. That is not hypothetical; it
 * is how an input came to sit at 1.044:1 against its own label.
 *
 * One other state has no host and so did read the fallbacks: a bundle UI run
 * standalone under its own `vite dev`, which every bundle has. That is a real
 * cost and it was taken deliberately — the app has no parent bridge there, so
 * it renders no data whatever its colours are, and unstyled is the honest
 * signal that you are looking at it outside the platform rather than a
 * light-mode approximation of it. If a bundle ever needs to be developed
 * standalone in earnest, the answer is one dev-only stylesheet declaring the
 * token set, not a fallback re-typed at each of several hundred call sites.
 *
 * The rule generalises past colour. A font token's value *is* a stack
 * (`'Hanken Grotesk', system-ui, sans-serif`) whose tail is the fallback — and
 * that tail matters, because a `srcdoc` iframe inherits no `@font-face`, so it
 * is usually what renders. Writing `var(--font-sans, system-ui, sans-serif)`
 * duplicates a fallback that already exists one level down, and the copy is
 * what goes stale. Radii and spacing are the same shape.
 *
 * So: one rule for every family, and no per-family carve-out to remember.
 * Either the token is injected (the host guarantees a value) or it is declared
 * locally in the same tree (you guarantee it). {@link ./theme-token-names.test.ts}
 * asserts that every name resolves to one of those two; this file asserts that
 * no call site carries a second opinion about what it means.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { paletteToExtAppsTokens } from "../../../web/src/theme/projections.ts";
import { REPO, sourceFiles, THEMING_DOC, themedTrees } from "./themed-trees.ts";

/**
 * A `var()` whose argument list has a comma at depth 1 — i.e. a fallback.
 *
 * Written to match the forms that actually occur rather than one tidy spelling:
 * the trees carry `var(--x,#hex)`, `var(--x, #hex)`, and `var(--x, a, b)` (a
 * font stack, whose commas are all part of one fallback). Whitespace after
 * `var(` and around the name is permitted because CSS permits it, and a matcher
 * that describes a stricter grammar than the language would pass a violation
 * written in the file's own prevailing style. The name class is `[\w-]` for the
 * same reason — an underscore is legal in a custom-property ident, so a
 * narrower class would read `var(--my_token, #fff)` as a bare `var(--my)` and
 * wave the fallback through.
 *
 * Not closed: a comment between the name and the comma (`var(--x /* c *\/, red)`).
 * Matching that needs a tokenizer rather than a regex, and no such spelling
 * exists in these trees. Note the sibling name guard does not cover the gap —
 * it reads the *name*, which is well-formed here, so a commented fallback on a
 * valid token would pass both. That is the whole of the remaining boundary.
 */
const FALLBACK = /var\(\s*--[\w-]+\s*,/g;

/** A bare `var(--x)`, used to prove the matcher discriminates rather than matching everything. */
const BARE = /var\(\s*--[\w-]+\s*\)/g;

/**
 * Scans whole file text, not line by line, so a `var(` broken across lines is
 * seen — `\s*` only spans a newline if a newline is in the input. Line numbers
 * come from the match offset instead. No such spelling exists in these trees
 * today, but a guard that reads one line at a time describes a grammar CSS does
 * not have, and this file's sibling guards have twice shipped a matcher whose
 * reach was narrower than the rule they stated.
 */
function violations(): string[] {
  const found: string[] = [];
  for (const { dir } of themedTrees) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(FALLBACK)) {
        const line = source.slice(0, m.index).split("\n").length;
        found.push(`${relative(REPO, file)}:${line}  ${m[0].replace(/\s+/g, " ")}…)`);
      }
    }
  }
  return found;
}

describe("theme tokens are used without fallbacks", () => {
  test("no var(--token, fallback) in any host-themed tree", () => {
    expect(violations()).toEqual([]);
  });

  // Canary. Without this the suite stays green if the walk silently stops
  // finding files (a renamed directory, a tightened extension filter) — the
  // failure mode where a guard reports "clean" because it read nothing.
  test("the walk actually reaches the themed trees", () => {
    expect(themedTrees.length).toBeGreaterThan(0);
    const total = themedTrees.reduce((n, { dir }) => n + sourceFiles(dir).length, 0);
    expect(total).toBeGreaterThan(0);
    const bare = themedTrees
      .flatMap(({ dir }) => sourceFiles(dir))
      .reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(BARE)].length, 0);
    expect(bare).toBeGreaterThan(0);
  });

  test.each([
    ["var(--color-text-primary, #09090b)", true],
    ["var(--color-text-primary,#09090b)", true],
    ["var( --color-text-primary , #09090b )", true],
    ["var(--font-sans, system-ui, sans-serif)", true],
    ["var(--my_token, #fff)", true],
    ["color: var(--x, #fff); background: var(--y, #000)", true],
    ["var(--color-text-primary)", false],
    ["var( --color-text-primary )", false],
    ["color: var(--x); background: var(--y)", false],
  ])("matcher: %s → violation=%p", (source, expected) => {
    expect(new RegExp(FALLBACK.source).test(source)).toBe(expected);
  });

  test("the matcher counts every occurrence on a line, not just the first", () => {
    const line = "border: 1px solid var(--a, #111); background: var(--b, #222);";
    expect([...line.matchAll(FALLBACK)]).toHaveLength(2);
  });

  test("a var() broken across lines is still seen", () => {
    const source = "color: var(\n  --color-text-primary,\n  #fff\n);";
    expect([...source.matchAll(FALLBACK)]).toHaveLength(1);
  });
});

/**
 * The same rule, applied to the page that teaches it.
 *
 * `docs/apps/theming.mdx` is what an app author reads before writing a line of
 * CSS, so a fallback written there does not stay there — it propagates into
 * apps this repo never sees, and no guard over `src/` can reach them. Guarding
 * the trees while the public page taught the opposite is how seven of that
 * page's nine example fallbacks came to name a palette two brand generations
 * old.
 *
 * The page gets an allowlist rather than the trees' flat zero, because it has
 * to document the one state the trees do not have: an app rendering where no
 * host injects tokens at all (Claude Desktop, another MCP host, its own dev
 * server). A fallback is genuinely load-bearing there. What it may never be is
 * a copy of *our* palette — that is a value the host owns, and a copy of it is
 * wrong the moment the brand moves, silently, in the direction of the light
 * mode it was written from.
 *
 * So the test is on the fallback's *value*, not its presence: a generic default
 * an app can legitimately own passes, and anything else is assumed to be ours.
 * Deriving the rule the other way — "no value equal to a current token value"
 * — was tried and rejected: against the page as it stood, equality caught 3 of
 * the 12 real violations, because the other nine had already drifted past
 * equality. The drifted copy is exactly the one worth catching, so an
 * enumerated set of safe values is the only shape that reaches it.
 *
 * The page's path is {@link THEMING_DOC}, declared beside the tree list so both
 * guards that read the page name it once.
 */

/**
 * Defaults an app can own outright: CSS's own keywords, never a value we pick.
 *
 * Three kinds, and the rule admits exactly these three. Fixed points of the
 * language (`white`, `black`, `transparent`, `none`, `0`) mean the same thing in
 * every document. Cascade keywords (`currentcolor`, `inherit`, `initial`,
 * `unset`, `revert`) defer to whatever the app's own stylesheet already decided.
 * Generic families (`sans-serif`, `serif`, `monospace`, `system-ui`) and the
 * system colours (`canvas`, `canvastext`) resolve against the *user's* platform
 * rather than ours — and that pair of colours follows the OS light/dark
 * preference, which makes them the only entries here that cannot ship the
 * light-mode-only failure this file exists to prevent.
 *
 * The set has to span every token family, not just colour, because the rule
 * does: a page documenting the standalone case for `--font-sans` or
 * `--shadow-md` needs a generic to reach for, and an allowlist that only knows
 * colours would reject the legitimate example and teach nothing in its place.
 *
 * It stays closed against the thing it guards. Every value the host injects is
 * a hex, a font stack, a shadow tuple or a rem length, so no keyword in this set
 * is reachable as a copy of ours — asserted below rather than asserted here.
 * `var(--border-radius-md, 0.5rem)` is still a violation because `0.5rem` is a
 * real injected value, and `var(--font-sans, system-ui, sans-serif)` still is
 * because the whole fallback is matched, not its parts.
 */
const GENERIC_FALLBACKS = new Set([
  "white",
  "black",
  "transparent",
  "none",
  "0",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "canvas",
  "canvastext",
]);

/**
 * Captures the fallback so it can be judged, where {@link FALLBACK} only detects one.
 *
 * Not closed: a fallback containing parentheses — `var(--a, var(--b, white))`,
 * `var(--shadow-md, 0 4px 6px rgba(0,0,0,.1))` — because `[^)]*` stops at the
 * first `)`. Both still fail, and the shadow case fails with the right verdict,
 * so the gap costs a truncated message rather than a miss. No such spelling is
 * on the page; naming the boundary here for the reason {@link FALLBACK} names
 * its own, one paragraph up.
 */
const DOC_FALLBACK = /var\(\s*--[\w-]+\s*,([^)]*)\)/g;

/**
 * Takes the source rather than reading the file, so the cases below can drive
 * the shipped function instead of a second copy of its predicate. A matcher
 * asserted through a re-typed `.trim().toLowerCase()` is a normalization no
 * test covers — and this guard's whole job is to notice what nothing reads.
 */
function docViolations(source: string, label = relative(REPO, THEMING_DOC)): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(DOC_FALLBACK)) {
    if (GENERIC_FALLBACKS.has(m[1].trim().toLowerCase())) continue;
    const line = source.slice(0, m.index).split("\n").length;
    found.push(`${label}:${line}  ${m[0]}`);
  }
  return found;
}

describe("theming.mdx teaches no fallback that copies a platform value", () => {
  test("every documented fallback is a generic the app owns", () => {
    expect(docViolations(readFileSync(THEMING_DOC, "utf8"))).toEqual([]);
  });

  // Canary, for the same reason as the tree walk above: a renamed or moved page
  // would otherwise make this guard pass by reading nothing.
  test("the page is actually being read, and does still teach var()", () => {
    const source = readFileSync(THEMING_DOC, "utf8");
    expect(source.length).toBeGreaterThan(0);
    expect([...source.matchAll(BARE)].length).toBeGreaterThan(0);
  });

  test.each([
    ["var(--color-background-primary, white)", false],
    ["var(--color-text-primary, black)", false],
    ["var(--color-background-primary, transparent)", false],
    ["var(--color-background-primary)", false],
    // Spelling is the author's, not ours — the allowlist is matched case-folded.
    ["var(--color-background-primary, White)", false],
    // Every family the rule covers, not just colour.
    ["var(--font-sans, sans-serif)", false],
    ["var(--font-mono, monospace)", false],
    ["var(--shadow-md, none)", false],
    ["var(--border-radius-md, 0)", false],
    // Follows the OS light/dark preference, so it is the standalone case done right.
    ["var(--color-text-primary, CanvasText)", false],
    ["var(--color-text-accent, #0055FF)", true],
    ["var(--color-text-accent, #2563eb)", true],
    ["var(--border-radius-md, 0.5rem)", true],
    // A generic is safe alone and not as the tail of our stack: the whole
    // fallback is matched, so the stale copy stays caught by the same set that
    // waves `sans-serif` through.
    ["var(--font-sans, system-ui, sans-serif)", true],
    ["var(--token, fallback)", true],
  ])("doc matcher: %s → violation=%p", (source, expected) => {
    expect(docViolations(source).length > 0).toBe(expected);
  });

  // The allowlist's load-bearing claim, derived rather than re-typed: a keyword
  // that is also a value we inject would be a hole you could copy our palette
  // through and pass. Nothing in the set collides today because every injected
  // value is a hex, a font stack, a shadow tuple or a rem length — but that is a
  // property of the palette, which moves, not of the set, which is why it is
  // asserted against the palette rather than asserted in a comment.
  test("no allowlisted generic is also a value the host injects", () => {
    const injected = new Set(
      (["light", "dark"] as const).flatMap((mode) =>
        Object.values(paletteToExtAppsTokens(mode)).map((v) => String(v).trim().toLowerCase()),
      ),
    );
    expect([...GENERIC_FALLBACKS].filter((g) => injected.has(g)).sort()).toEqual([]);
  });

  // The flagging path, which the assertion above can never reach: it runs
  // against a page that is now clean, so on its own it proves only that
  // `docViolations` returns nothing — not that it is able to return anything.
  // A guard whose positive path is never exercised is the same defect as one
  // that reads no files, one level in.
  test("a violation is reported with its line and the offending text", () => {
    const page = "# Theming\n\nbody {\n  color: var(--color-text-primary, #1a1a1a);\n}";
    expect(docViolations(page, "theming.mdx")).toEqual([
      "theming.mdx:4  var(--color-text-primary, #1a1a1a)",
    ]);
  });
});
