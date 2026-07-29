/**
 * The host's tokens must survive the SDK applying a theme.
 *
 * The host delivers its token set over TWO channels, because
 * `hostContext.styles.variables` is a closed enum in the ext-apps spec:
 *
 *  1. spec-enum keys cross the protocol (`getSpecThemeTokens`), and
 *  2. everything else — the `--nb-*` extensions plus NimbleBrain's own additions
 *     to spec-shaped families, `--color-text-accent` among them — reaches the app
 *     only as a `:root` rule inside `buildThemeStyleBlock`.
 *
 * Channel 2 is a plain author stylesheet, so anything the SDK writes to
 * `documentElement.style` (the INLINE attribute) outranks it and wins
 * permanently. A key delivered only by channel 2 must therefore never appear in
 * the SDK's inline write.
 *
 * `@nimblebrain/synapse` 0.13.0 applies a 19-key neutral default map inline
 * before layering the host's variables on top, which silently overrode four
 * brand tokens (`--color-text-accent`, `--nb-color-danger/success/warning`).
 * Tracked upstream as NimbleBrainInc/synapse#49 — the default layer belongs in
 * an `@layer` stylesheet, where it behaves like the fallback it is described as.
 *
 * This asserts the invariant rather than that bug's specifics, so it holds for
 * whatever the SDK's default map grows to next, and derives both channels from
 * the host's own source of truth rather than restating a key list.
 *
 * Deliberately reads the inline style attribute, not `getComputedStyle` — the
 * question is what the SDK *wrote*, not how a full cascade resolves it, so the
 * assertion needs no CSS-cascade support from the test DOM.
 *
 * **What this does NOT cover.** Channel 2 is derived as `getThemeTokens` minus
 * `getSpecThemeTokens`, so it only sees keys the host actually defines. An SDK
 * default for a var the host defines *nowhere* cannot appear in that set, and the
 * app would silently get the SDK's value. That set is currently empty — the host
 * projects all 17 keys the SDK backs — so nothing falls through today, but the
 * blind spot reopens the moment the SDK backs a var this host does not send.
 * Closing it properly would need the SDK's default map exported (it isn't) or
 * restated here, and a restated copy is the drift this guard exists to catch.
 *
 * The SDK import resolves from the ROOT `node_modules`, not `web/`'s — `web/` has
 * no `@nimblebrain/synapse` pin, and shouldn't get one: the version under test
 * must be the version the bundle UIs and root install, and a second manifest is a
 * second thing to keep in sync. CI installs root before `web/` (`ci.yml`), so the
 * hoisted copy is always present.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { applyHostTheme } from "@nimblebrain/synapse/host";
import { getSpecThemeTokens, getThemeTokens } from "../bridge/theme";

/** Keys the host can only deliver as a `:root` rule — never over the protocol. */
function styleBlockOnlyKeys(mode: "light" | "dark"): string[] {
  const onWire = new Set(Object.keys(getSpecThemeTokens(mode)));
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
      applyHostTheme({ mode, tokens: getSpecThemeTokens(mode) });

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
