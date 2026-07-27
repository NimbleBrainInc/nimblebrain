/**
 * The host→iframe font channel.
 *
 * An app iframe inherits no `@font-face` from the shell, so injecting a
 * `--font-*` token names a typeface the app cannot render. These tests pin the
 * two halves that make it actually render, and the two ways it silently
 * wouldn't:
 *
 *  1. Every family the iframe token set NAMES must have a face shipped for it.
 *     A palette rename that orphans a face is invisible at runtime — the text
 *     just falls back to `system-ui` and looks fine.
 *  2. The frame's CSP must permit the origin the faces are served from.
 *     `'self'` does NOT cover it: the frame is `srcdoc` without
 *     `allow-same-origin`, so it runs in an opaque origin where `'self'`
 *     matches nothing.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { buildCSP } from "../../../web/src/bridge/iframe.ts";
import {
  FONT_FACES_CONTEXT_KEY,
  FONT_SPECS,
  fontOrigin,
  getHostFontFaces,
  registerHostFontUrls,
} from "../../../web/src/bridge/fonts.ts";
import { buildHostContext, buildHostExtensions } from "../../../web/src/bridge/host-extensions.ts";
import { paletteToExtAppsTokens } from "../../../web/src/theme/projections.ts";

/** The browser entry supplies these at runtime; fixtures stand in here so the
 *  mapping is exercised without `web/` dependencies. */
function registerFixtures(): void {
  registerHostFontUrls(Object.fromEntries(FONT_SPECS.map((s) => [s.family, `/assets/${s.family}.woff2`])));
}

beforeEach(registerFixtures);

const GENERIC =
  /^(system-ui|ui-sans-serif|ui-monospace|ui-serif|sans-serif|serif|monospace|cursive|fantasy)$/;

/**
 * Families named by ANY font token the host injects into an iframe.
 *
 * Derived from the emitted token map rather than a hardcoded key list: naming
 * the keys would reopen the same silent-orphan gap one level up, since adding a
 * fourth font token to `projections.ts` would simply not be guarded. A value is
 * a font stack if it names a generic family or quotes a family name.
 */
function familiesNamedByTokens(): string[] {
  const named = new Set<string>();
  for (const value of Object.values(paletteToExtAppsTokens("light"))) {
    const parts = value.split(",").map((p) => p.trim());
    const looksLikeFontStack =
      parts.some((p) => GENERIC.test(p)) || /^['"]/.test(parts[0] ?? "");
    if (!looksLikeFontStack) continue;
    // First entry is the intended face; the rest is the web-safe tail.
    const first = (parts[0] ?? "").replace(/^['"]|['"]$/g, "");
    // A bare generic is a fallback, not a face we must ship.
    if (first && !GENERIC.test(first)) named.add(first);
  }
  return [...named];
}

describe("host font faces cover what the tokens name", () => {
  test("every family named by an iframe font token has a face shipped", () => {
    // The silent-failure guard. Rename a family in `palette.ts` without
    // updating `fonts.ts` and nothing throws — the iframe just renders in
    // `system-ui` and looks plausible. This is what catches that.
    const shipped = new Set(FONT_SPECS.map((f) => f.family));
    for (const family of familiesNamedByTokens()) {
      expect(shipped.has(family), `no font spec for token family "${family}"`).toBe(true);
    }
  });

  test("each descriptor is well-formed for the SDK's normaliser", () => {
    // `@nimblebrain/synapse` drops entries missing `family`/`src`, and a batch
    // with nothing usable reads as "unchanged" — so a malformed descriptor
    // fails open and silently, exactly like the orphan case above.
    for (const face of getHostFontFaces()) {
      expect(typeof face.family).toBe("string");
      expect(face.family.length).toBeGreaterThan(0);
      expect(face.src).toMatch(/^url\('.+'\)/);
      expect(face.display).toBe("swap");
    }
  });

  test("faces are variable and cover the type scale's weight range", () => {
    // One variable file per family serves every weight, so the type scale
    // can't outrun what's loaded.
    for (const face of FONT_SPECS) {
      expect(face.weight).toMatch(/^\d+ \d+$/);
      const [lo, hi] = face.weight.split(" ").map(Number);
      expect(lo).toBeLessThanOrEqual(400);
      expect(hi).toBeGreaterThanOrEqual(700);
    }
  });
});

describe("faces reach the app through the host context", () => {
  test("published on the handshake extensions", () => {
    const ext = buildHostExtensions(null);
    expect(Array.isArray(ext[FONT_FACES_CONTEXT_KEY])).toBe(true);
    expect((ext[FONT_FACES_CONTEXT_KEY] as unknown[]).length).toBeGreaterThan(0);
  });

  test("published on host-context-changed too", () => {
    // Absent means "unchanged" to the SDK, so omitting them here would be
    // harmless — but sending them keeps the two payloads consistent.
    const ctx = buildHostContext("dark", null);
    expect(Array.isArray(ctx[FONT_FACES_CONTEXT_KEY])).toBe(true);
  });

  test("rides a synapse/ extension key, not a spec field", () => {
    // The ext-apps spec has no font-face field; `styles.variables` is a flat
    // enum of CSS var names. Anything non-spec must be `synapse/`-prefixed so
    // strict clients ignore rather than reject it.
    expect(FONT_FACES_CONTEXT_KEY.startsWith("synapse/")).toBe(true);
    const ctx = buildHostContext("light", null);
    const styles = ctx.styles as { variables: Record<string, string> };
    expect(Object.keys(styles.variables).some((k) => k.includes("fontFace"))).toBe(false);
  });
});

describe("CSP permits the origin the faces are served from", () => {
  test("font-src names the host origin, not just 'self'", () => {
    // `'self'` matches NOTHING in an opaque-origin srcdoc frame, so a policy of
    // `font-src 'self' data:` would block every face while looking permissive.
    const csp = buildCSP();
    const fontSrc = csp.split("; ").find((d) => d.startsWith("font-src"));
    expect(fontSrc).toBeDefined();
    expect(fontSrc).toContain("data:");
    const origin = fontOrigin();
    if (origin) expect(fontSrc).toContain(origin);
  });

  test("the served URLs are absolute, so an opaque origin can resolve them", () => {
    // A relative `/assets/…` URL resolves against the FRAME's origin, which is
    // opaque — so it 404s. Absolute is required, not stylistic. Stub the
    // browser global, since this asserts runtime behaviour and the test env
    // has no `window`.
    const prior = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { origin: "https://app.example.com" },
    };
    try {
      for (const face of getHostFontFaces()) {
        const url = face.src.match(/url\('([^']+)'\)/)?.[1] ?? "";
        expect(url).toStartWith("https://app.example.com/");
      }
      expect(fontOrigin()).toBe("https://app.example.com");
    } finally {
      if (prior === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = prior;
      }
    }
  });

  test("no window (SSR / prerender) degrades without throwing", () => {
    // The bridge modules get imported in non-browser contexts; building
    // descriptors must not be the thing that breaks that. Remove the global
    // explicitly — other suites in this run install a DOM, so asserting on
    // ambient absence would make this order-dependent.
    const prior = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      expect(() => getHostFontFaces()).not.toThrow();
      expect(fontOrigin()).toBe("");
    } finally {
      if (prior !== undefined) (globalThis as { window?: unknown }).window = prior;
    }
  });

  test("declared resourceDomains still append", () => {
    const csp = buildCSP({ resourceDomains: ["https://cdn.example.com"] });
    const fontSrc = csp.split("; ").find((d) => d.startsWith("font-src"));
    expect(fontSrc).toContain("https://cdn.example.com");
    // Sources are space-delimited, so a gap where an unusable origin would have
    // gone parses fine — but it reads as a missing source to anyone auditing the
    // header. The directive is assembled from present parts only.
    expect(fontSrc).not.toContain("  ");
  });

  test("no directive injection via the added origin", () => {
    // The origin is derived from `window.location`, never from bundle input,
    // but assert the shape anyway: exactly the directives we expect.
    const csp = buildCSP();
    const names = csp.split("; ").map((d) => d.split(" ")[0]);
    expect(names).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "frame-src",
      "object-src",
      "base-uri",
    ]);
  });
});

describe("building descriptors can never break the host", () => {
  // `buildHostExtensions` runs during a placement render (SlotRenderer), so a
  // throw in here unmounts the app. An earlier draft called `new URL(path,
  // origin)` unguarded and took down five SlotRenderer tests when the test DOM
  // reported an origin that isn't a URL. Typography must fail soft: at worst
  // the app gets a face it can't fetch, which is the no-fonts case.
  const BAD_ORIGINS = ["null", "", "about:blank", "not a url"];

  for (const origin of BAD_ORIGINS) {
    test(`origin ${JSON.stringify(origin)} degrades instead of throwing`, () => {
      const prior = (globalThis as { window?: unknown }).window;
      (globalThis as { window?: unknown }).window = { location: { origin } };
      try {
        expect(() => getHostFontFaces()).not.toThrow();
        expect(() => buildHostExtensions(null)).not.toThrow();
        expect(() => buildCSP()).not.toThrow();
        // An unusable origin must not be smuggled into the policy, and must not
        // leave a hole where it would have gone.
        expect(fontOrigin()).toBe("");
        expect(buildCSP().split("; ")).toContain("font-src 'self' data:");
      } finally {
        if (prior === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          (globalThis as { window?: unknown }).window = prior;
        }
      }
    });
  }

  test("a window with no location at all is survivable", () => {
    const prior = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(() => getHostFontFaces()).not.toThrow();
      expect(fontOrigin()).toBe("");
    } finally {
      if (prior === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = prior;
      }
    }
  });
});

describe("unregistered URLs mean no fonts, not a broken host", () => {
  test("backend and root-unit importers get no faces, and the key is omitted", () => {
    // `bridge/fonts.ts` is reachable from the shared bridge protocol, which the
    // root unit suite exercises without `web/` deps. It must therefore never
    // import the font packages — the browser entry injects the URLs. Absent
    // that call, no faces, which the SDK reads as "host sends no fonts".
    //
    // Omitted, NOT sent as `[]`: the SDK reads an absent key as "unchanged" and
    // an explicit empty list as "clear every managed face", so sending `[]` here
    // would be an active reset dressed up as absence.
    registerHostFontUrls({});
    expect(getHostFontFaces()).toEqual([]);
    const ext = buildHostExtensions(null);
    expect(FONT_FACES_CONTEXT_KEY in ext).toBe(false);
    expect(FONT_FACES_CONTEXT_KEY in buildHostContext("dark", null)).toBe(false);
  });

  test("a partial registration degrades to fewer faces, not a malformed one", () => {
    registerHostFontUrls({});
    registerHostFontUrls({ [FONT_SPECS[0].family]: "/assets/one.woff2" });
    const faces = getHostFontFaces();
    expect(faces).toHaveLength(1);
    expect(faces[0].family).toBe(FONT_SPECS[0].family);
  });
});
