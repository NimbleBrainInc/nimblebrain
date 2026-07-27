/**
 * The browser entry must register a URL for every font spec.
 *
 * `bridge/fonts.ts` deliberately holds no asset imports — it is reachable from
 * the shared bridge protocol, which the ROOT unit suite exercises without
 * `web/` dependencies installed, so a `?url` import there breaks `Unit Tests
 * (root deps only)`. The URLs are injected from `main.tsx` instead.
 *
 * That split leaves exactly one gap nothing else covers: add a family to
 * `FONT_SPECS`, forget to register it in `main.tsx`, and you get no face and no
 * error — the iframe renders that family in `system-ui` and looks plausible. A
 * wrong asset *path* is already fatal at build time (rollup cannot resolve the
 * `?url` import), so a missing *family* is the only half worth asserting here.
 */

import { describe, expect, test } from "bun:test";
import { FONT_SPECS } from "../bridge/fonts";

describe("every font spec has a real asset behind it", () => {
  test("main.tsx registers a URL for each spec family", async () => {
    const source = Bun.file(new URL("../main.tsx", import.meta.url).pathname);
    const text = await source.text();
    for (const spec of FONT_SPECS) {
      expect(text, `main.tsx does not register "${spec.family}"`).toContain(`"${spec.family}":`);
    }
  });
});
