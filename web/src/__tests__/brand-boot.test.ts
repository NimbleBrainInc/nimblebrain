/**
 * The brand boot: the brand `/v1/brand.js` assigned is painted synchronously,
 * before the first render, and anything else paints canonical.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyBrand, bootBrand, getBrand } from "../brand";
import { brandFontOrigins } from "../bridge/fonts";
import { getThemeTokens } from "../bridge/theme";
import type { ResolvedBrand } from "../theme/brand";

// happy-dom's selector parser constructs `window.SyntaxError`, which the test
// window lacks, so any querySelectorAll throws. Same patch the other DOM tests carry.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const ACME_FAVICON = "https://static.example.com/brands/acme/favicon.png";

const ACME: ResolvedBrand = {
  name: "ACME",
  favicon: ACME_FAVICON,
  colors: { primary: ["#B53707", "#FF8A4C"], ring: ["#B53707", "#FF8A4C"] },
  fonts: {
    sans: {
      stack: "'Instrument Sans', system-ui, sans-serif",
      family: "Instrument Sans",
      url: "https://static.example.com/brands/acme/fonts/instrument-sans.woff2",
      weight: "400 700",
    },
  },
};

const brandStyle = () => document.getElementById("nb-brand");
const iconHrefs = () =>
  [...document.querySelectorAll('link[rel~="icon"]')].map((el) => el.getAttribute("href"));

beforeEach(() => {
  document.head.innerHTML =
    '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" type="image/png" href="/favicon-192.png" sizes="192x192">';
  document.title = "NimbleBrain";
  delete window.__NB_BRAND__;
});

afterEach(() => {
  applyBrand({});
  delete window.__NB_BRAND__;
});

describe("bootBrand", () => {
  test("paints the assigned brand synchronously", () => {
    window.__NB_BRAND__ = ACME;

    bootBrand();

    // No await: everything is in place before the caller's next line, which is createRoot.
    expect(getBrand()).toEqual(ACME);
    expect(brandStyle()?.textContent).toContain("--primary: #B53707;");
    expect(brandStyle()?.textContent).toContain("font-family: 'Instrument Sans'");
    expect(document.title).toBe("ACME");
    expect(iconHrefs()).toEqual([ACME_FAVICON, ACME_FAVICON]);
    expect(document.querySelector("link[rel~='icon']")?.hasAttribute("sizes")).toBe(false);
    expect(getThemeTokens("light")["--color-text-accent"]).toBe("#B53707");
    expect(brandFontOrigins()).toEqual(["https://static.example.com"]);
  });

  test("{} is canonical", () => {
    window.__NB_BRAND__ = {};
    bootBrand();
    expect(getBrand()).toEqual({});
    expect(brandStyle()).toBeNull();
    expect(document.title).toBe("NimbleBrain");
    expect(iconHrefs()).toEqual(["/favicon.ico", "/favicon-192.png"]);
  });

  test("a script that never loaded is canonical", () => {
    bootBrand();
    expect(getBrand()).toEqual({});
    expect(brandStyle()).toBeNull();
    expect(document.title).toBe("NimbleBrain");
    expect(iconHrefs()).toEqual(["/favicon.ico", "/favicon-192.png"]);
  });

  for (const [label, value] of [
    ["null", null],
    ["a string", "ACME"],
    ["an array", [ACME]],
  ] as const) {
    test(`${label} is canonical`, () => {
      window.__NB_BRAND__ = value;
      bootBrand();
      expect(getBrand()).toEqual({});
      expect(brandStyle()).toBeNull();
      expect(document.title).toBe("NimbleBrain");
    });
  }
});

describe("applyBrand", () => {
  test("a brand the merge cannot read falls back to canonical", () => {
    applyBrand({ name: "Broken", colors: { primary: null } } as unknown as ResolvedBrand);
    expect(getBrand()).toEqual({});
    expect(brandStyle()).toBeNull();
    expect(document.title).toBe("NimbleBrain");
  });

  test("a brand with only a name writes no style block", () => {
    applyBrand({ name: "ACME" });
    expect(brandStyle()).toBeNull();
    expect(document.title).toBe("ACME");
  });
});
