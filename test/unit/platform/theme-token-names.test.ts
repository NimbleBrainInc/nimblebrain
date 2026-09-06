/**
 * Every theme token a bundle UI reads, and every one the docs publish, must be
 * a name the host actually injects.
 *
 * A misspelled token is the quietest failure in the theming system. `var(--x,
 * fallback)` is valid CSS whatever `--x` is, so a wrong name does not warn, does
 * not fail a build, and renders *correctly in light mode* — because the
 * fallbacks were written from the light palette. It only shows up in dark, where
 * the fallback that was never meant to be used becomes the only value. The
 * observed shape: an input whose `background` fell back to `#fff` beside a
 * `color` that resolved to the injected `#fafafa`, giving 1.044:1 — invisible
 * text, in a bundle whose stylesheet spells the same token correctly 22 times.
 *
 * The docs half is the same failure aimed at app authors. `theming.mdx`
 * publishes the token *names* by hand (round 4 removed the values, which drift
 * fastest, but names drift too — a token deleted from the palette stays
 * published). An author who copies a name that is no longer emitted writes CSS
 * that silently uses its fallback forever.
 *
 * Both directions are asserted for the docs: no undocumented key, no documented
 * ghost. Note the scope — this checks *names*, not values or ratios. That the
 * name resolves says nothing about whether the colour it resolves to is legible;
 * `web/src/theme/__tests__/contrast.test.ts` owns that.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paletteToExtAppsTokens } from "../../../web/src/theme/projections.ts";
import { REPO, sourceFiles, THEMING_DOC, themedTrees } from "./themed-trees.ts";

/** The names `buildThemeStyleBlock` writes into every iframe's style block. */
const INJECTED = new Set(Object.keys(paletteToExtAppsTokens("light")));

describe("themed trees only read tokens the host injects", () => {
  test("the themed trees are actually being scanned", () => {
    expect(themedTrees.length).toBeGreaterThan(0);
  });

  for (const { name, dir } of themedTrees) {
    test(`${name}: every var(--token) resolves`, () => {
      const declared = new Set<string>();
      const read = new Map<string, string>();

      for (const file of sourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        // Anything the bundle defines for itself is fair game to read.
        for (const m of source.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1] as string);
        for (const m of source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
          if (!read.has(m[1] as string)) read.set(m[1] as string, file);
        }
      }

      const unresolved = [...read]
        .filter(([token]) => !INJECTED.has(token) && !declared.has(token))
        .map(([token, file]) => `${token} — ${file.slice(REPO.length + 1)}`);

      expect(unresolved.join("\n")).toBe("");
    });
  }
});

/**
 * Token names published by the page's token tables — the ones headed `| Token |
 * Use for |`.
 *
 * Scoped that way deliberately. Those tables exist to enumerate what the host
 * injects, so a name in one is a claim about the map. Names elsewhere are not:
 * the page also discusses the `--nb-` prefix itself and walks through a naming
 * example whose table has a different header and legitimately names `--my-bg`,
 * an author's own variable. Matching every backtick on the page would need a
 * denylist of those, which is the kind of hand-maintained exception list this
 * file exists to make unnecessary.
 *
 * Compound type-scale rows read `` `--font-text-xs-size` / `-line-height` `` —
 * one row covering two tokens — so the suffix is joined back onto its stem.
 */
function documentedTokens(doc: string): Set<string> {
  const names = new Set<string>();
  let inTokenTable = false;
  let stem = "";

  for (const line of doc.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|")) {
      inTokenTable = false;
      continue;
    }
    if (/^\|\s*Token\s*\|/.test(row)) {
      inTokenTable = true;
      // A `-line-height` suffix binds to the `-size` row above it, so the stem
      // must not survive into the next table — otherwise a suffix row with no
      // `-size` row before it would silently attach to a stem from an earlier
      // table and invent a name that was never published.
      stem = "";
      continue;
    }
    if (!inTokenTable) continue;

    for (const [, token] of row.matchAll(/`(--[a-z0-9-]+|-line-height)`/g)) {
      if (token === "-line-height") {
        if (stem.endsWith("-size")) names.add(`${stem.slice(0, -"-size".length)}-line-height`);
        continue;
      }
      names.add(token as string);
      stem = token as string;
    }
  }
  return names;
}

describe("theming.mdx publishes exactly the injected token set", () => {
  const documented = documentedTokens(readFileSync(THEMING_DOC, "utf8"));

  test("no injected token goes undocumented", () => {
    expect([...INJECTED].filter((t) => !documented.has(t)).sort()).toEqual([]);
  });

  test("no documented token is a ghost", () => {
    expect([...documented].filter((t) => !INJECTED.has(t)).sort()).toEqual([]);
  });

  test("the reference tables are actually being read", () => {
    // A canary, so a parser that silently matches nothing cannot pass the two
    // set assertions above vacuously. Comparing the sizes instead would be a
    // tautology: mutual inclusion already implies equal size.
    expect(documented.size).toBeGreaterThan(0);
  });
});
