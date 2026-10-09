/**
 * The host's tokens must survive the SDK applying a theme.
 *
 * The host delivers its token set over THREE channels, because
 * `hostContext.styles.variables` is a closed enum in the ext-apps spec:
 *
 *  1. spec-enum keys cross the protocol on `styles.variables` (`getSpecThemeTokens`),
 *  2. the out-of-spec keys that vary with the mode (`--color-text-accent`, the
 *     processing pair) cross it on the `ai.nimblebrain/styles` extension
 *     (`getModeExtensionTokens`), and
 *  3. the rest, which are mode-independent, reach the app only as a `:root`
 *     rule inside `buildThemeStyleBlock`.
 *
 * Channel 3 is a plain author stylesheet, so anything the SDK writes to
 * `documentElement.style` (the INLINE attribute) outranks it and wins
 * permanently. A key delivered only by channel 3 must therefore never appear in
 * the SDK's inline write. The SDK keeps its neutral defaults in an `@layer`
 * stylesheet for this reason.
 *
 * This asserts the invariant rather than any one key, so it holds for whatever
 * the SDK's default map grows to next, and derives the channels from the host's
 * own source of truth rather than restating a key list.
 *
 * Deliberately reads the inline style attribute, not `getComputedStyle`: the
 * question is what the SDK *wrote*, not how a full cascade resolves it, so the
 * assertion needs no CSS-cascade support from the test DOM.
 *
 * **What this does NOT cover.** Channel 3 is derived from `getThemeTokens`, so
 * it only sees keys the host actually defines. An SDK default for a var the host
 * defines *nowhere* cannot appear in that set, and the app would silently get
 * the SDK's value. Closing it would need the SDK's default map restated here,
 * and a restated copy is the drift this guard exists to catch.
 *
 * The SDK import resolves from the ROOT `node_modules`, not `web/`'s — `web/` has
 * no `@nimblebrain/synapse` pin, and shouldn't get one: the version under test
 * must be the version the connector UIs and root install, and a second manifest is a
 * second thing to keep in sync. CI installs root before `web/` (`ci.yml`), so the
 * hoisted copy is always present.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { applyHostTheme } from "@nimblebrain/synapse/host";
import { getModeExtensionTokens, getSpecThemeTokens, getThemeTokens } from "../bridge/theme";

/** The variables the host sends over the protocol: spec keys and the mode extension. */
function wireTokens(mode: "light" | "dark"): Record<string, string> {
  return { ...getSpecThemeTokens(mode), ...getModeExtensionTokens(mode) };
}

/** Keys the host can only deliver as a `:root` rule — never over the protocol. */
function styleBlockOnlyKeys(mode: "light" | "dark"): string[] {
  const onWire = new Set(Object.keys(wireTokens(mode)));
  return Object.keys(getThemeTokens(mode)).filter((k) => !onWire.has(k));
}

// `web/test/setup.ts` builds ONE happy-dom Window and installs its document as a
// process global, so `bun test` shares it across every file in this suite. Applying
// a theme here writes the SDK's whole default map inline on `documentElement`;
// leaving it behind would hand the next file a pre-styled root. Nothing reads
// `documentElement.style` today, which is exactly why it would be missed.
afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("the SDK must not override host tokens it cannot receive", () => {
  for (const mode of ["light", "dark"] as const) {
    test(`${mode}: no style-block-only token is written inline by the SDK`, () => {
      const offWire = styleBlockOnlyKeys(mode);
      // Guard the guard: if the split ever collapses, this test would pass by
      // asserting nothing at all.
      expect(offWire.length).toBeGreaterThan(0);

      document.documentElement.removeAttribute("style");
      applyHostTheme({ mode, tokens: wireTokens(mode) });

      const clobbered = offWire.filter(
        (k) => document.documentElement.style.getPropertyValue(k) !== "",
      );
      expect(
        clobbered,
        `the SDK wrote ${clobbered.length} token(s) the host delivers only via its ` +
          `:root rule, so its values win over the host's: ${clobbered.join(", ")}`,
      ).toEqual([]);
    });
  }
});
