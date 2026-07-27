/**
 * The browser entry must register a URL for every font spec.
 *
 * `bridge/fonts.ts` deliberately holds no asset imports — it is reachable from
 * the shared bridge protocol, which the ROOT unit suite exercises without
 * `web/` dependencies installed, so a `?url` import there breaks `Unit Tests
 * (root deps only)`. The URLs are injected from `main.tsx` instead.
 *
 * That split has a gap only a web-deps suite can close: adding a family to
 * `FONT_SPECS` and forgetting to register it in `main.tsx` yields no face for
 * it, and nothing throws — the iframe just renders that family in `system-ui`.
 * This lives here, not in the root suite, because verifying it requires
 * resolving the real font packages.
 */

import { describe, expect, test } from "bun:test";
import { FONT_SPECS } from "../bridge/fonts";

/** The font-package files `main.tsx` imports, resolved the same way Vite will. */
const REGISTERED_FILES: Record<string, string> = {
  "Hanken Grotesk":
    "@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2",
  "JetBrains Mono Variable":
    "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
};

describe("every font spec has a real asset behind it", () => {
  test("main.tsx registers a URL for each spec family", () => {
    const source = Bun.file(new URL("../main.tsx", import.meta.url).pathname);
    return source.text().then((text) => {
      for (const spec of FONT_SPECS) {
        expect(text, `main.tsx does not register "${spec.family}"`).toContain(`"${spec.family}":`);
      }
    });
  });

  test("each registered file exists in node_modules", async () => {
    // A Fontsource restructure renames these; catching it here beats shipping a
    // build whose `?url` import resolves to nothing.
    for (const [family, specifier] of Object.entries(REGISTERED_FILES)) {
      const resolved = Bun.resolveSync(specifier, import.meta.dir);
      expect(await Bun.file(resolved).exists(), `missing woff2 for ${family}`).toBe(true);
    }
  });

  test("the spec list and the registered files agree", () => {
    expect(Object.keys(REGISTERED_FILES).sort()).toEqual(FONT_SPECS.map((s) => s.family).sort());
  });
});
