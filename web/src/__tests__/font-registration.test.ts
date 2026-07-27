/**
 * Every font spec must have a built asset URL behind it.
 *
 * `bridge/fonts.ts` deliberately holds no asset imports — it is reachable from
 * the shared bridge protocol, which the ROOT unit suite exercises without
 * `web/` dependencies installed, so a `?url` import there breaks `Unit Tests
 * (root deps only)`. The URLs live in `font-urls.ts` instead.
 *
 * That split leaves one gap nothing else covers: add a family to `FONT_SPECS`,
 * forget to add its URL, and you get no face and no error — the iframe renders
 * that family in `system-ui` and looks plausible. A wrong asset *path* is already
 * fatal at build time (rollup cannot resolve the `?url` import), so a missing
 * *family* is the only half worth asserting here.
 *
 * This asserts the real exported map, not the text of the entry module — a
 * source-grep passes on a match inside a comment and breaks on a harmless
 * rename, which makes it both a false pass and a false failure waiting to happen.
 */

import { describe, expect, test } from "bun:test";
import { FONT_SPECS } from "../bridge/fonts";
import { FONT_URLS } from "../font-urls";

describe("every font spec has a real asset behind it", () => {
  test("each spec family has a built URL", () => {
    for (const spec of FONT_SPECS) {
      expect(FONT_URLS[spec.family], `no built URL registered for "${spec.family}"`).toBeTruthy();
    }
  });

  test("no URL is registered for a family no spec declares", () => {
    // An orphan entry is dead weight that reads as coverage — and it is how the
    // map drifts out of step with the specs without either side looking wrong.
    const declared = new Set<string>(FONT_SPECS.map((s) => s.family));
    for (const family of Object.keys(FONT_URLS)) {
      expect(declared.has(family), `"${family}" has a URL but no font spec`).toBe(true);
    }
  });
});
