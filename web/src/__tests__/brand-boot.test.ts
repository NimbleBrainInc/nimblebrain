/**
 * The brand boot: a cached brand paints before the fetch resolves, the fetch
 * corrects the cache, `{}` from the server restores the canonical look, and a
 * failure never leaves the shell unpainted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyBrand, BRAND_CACHE_KEY, bootBrand, getBrand } from "../brand";
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

const ACME: ResolvedBrand = {
  name: "ACME",
  favicon: "https://static.example.com/brands/acme/favicon.png",
  colors: { primary: ["#B53707", "#FF8A4C"], "primary-foreground": ["#FFFFFF", "#1B1B1F"] },
  fonts: {
    sans: {
      stack: "'Instrument Sans', system-ui, sans-serif",
      family: "Instrument Sans",
      faces: [
        {
          url: "https://static.example.com/brands/acme/fonts/instrument-sans.woff2",
          weight: "400 700",
        },
      ],
    },
  },
};

/** A fetch that answers only when the test says so. */
function deferredFetch() {
  let answer: (body: unknown, status?: number) => void = () => {};
  const impl = (() =>
    new Promise<Response>((resolve) => {
      answer = (body, status = 200) =>
        resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
    })) as unknown as typeof fetch;
  return { impl, answer: (body: unknown, status?: number) => answer(body, status) };
}

const failingFetch = (() =>
  Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;

/** Let queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const brandStyle = () => document.getElementById("nb-brand");
const iconHrefs = () =>
  [...document.querySelectorAll('link[rel~="icon"]')].map((el) => el.getAttribute("href"));

beforeEach(() => {
  document.head.innerHTML =
    '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" type="image/png" href="/favicon-192.png" sizes="192x192">';
  document.title = "NimbleBrain";
  localStorage.clear();
});

afterEach(() => {
  applyBrand({});
  localStorage.clear();
});

describe("bootBrand", () => {
  test("a cached brand paints before the fetch resolves", async () => {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(ACME));
    const server = deferredFetch();

    await bootBrand({ fetch: server.impl });

    // The fetch has not answered; everything below came from the cache.
    expect(brandStyle()?.textContent).toContain("--primary: #B53707;");
    expect(brandStyle()?.textContent).toContain("font-family: 'Instrument Sans'");
    expect(document.title).toBe("ACME");
    expect(iconHrefs()).toEqual([ACME.favicon, ACME.favicon]);
    expect(getThemeTokens("light")["--color-text-accent"]).toBe("#B53707");
    expect(brandFontOrigins()).toEqual(["https://static.example.com"]);

    server.answer(ACME);
    await settle();
    expect(document.title).toBe("ACME");
  });

  test("a brand removed on the server clears the cache and restores canonical", async () => {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(ACME));
    const server = deferredFetch();
    await bootBrand({ fetch: server.impl });
    expect(document.title).toBe("ACME");

    server.answer({});
    await settle();

    expect(brandStyle()).toBeNull();
    expect(document.title).toBe("NimbleBrain");
    expect(iconHrefs()).toEqual(["/favicon.ico", "/favicon-192.png"]);
    expect(document.querySelector('link[href="/favicon-192.png"]')?.getAttribute("type")).toBe(
      "image/png",
    );
    expect(localStorage.getItem(BRAND_CACHE_KEY)).toBeNull();
    expect(getThemeTokens("light")["--color-text-accent"]).not.toBe("#B53707");
    expect(brandFontOrigins()).toEqual([]);
  });

  test("a changed brand on the server replaces the cached one", async () => {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(ACME));
    const server = deferredFetch();
    await bootBrand({ fetch: server.impl });

    const renamed = { ...ACME, name: "ACME Corp" };
    server.answer(renamed);
    await settle();

    expect(document.title).toBe("ACME Corp");
    expect(JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) ?? "{}")).toEqual(renamed);
  });

  test("with no cache, the first render waits for the fetch and caches its answer", async () => {
    const server = deferredFetch();
    let resolved = false;
    const booted = bootBrand({ fetch: server.impl, firstPaintWaitMs: 5_000 }).then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);

    server.answer(ACME);
    await booted;

    expect(getBrand().name).toBe("ACME");
    expect(brandStyle()?.textContent).toContain("--primary: #B53707;");
    expect(JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) ?? "{}")).toEqual(ACME);
  });

  test("a slow server does not hold the first render; its answer still applies", async () => {
    const server = deferredFetch();
    await bootBrand({ fetch: server.impl, firstPaintWaitMs: 1 });
    expect(getBrand()).toEqual({});

    server.answer(ACME);
    await settle();
    expect(getBrand().name).toBe("ACME");
  });

  test("a failed fetch keeps the cached brand", async () => {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(ACME));
    await bootBrand({ fetch: failingFetch });
    await settle();
    expect(document.title).toBe("ACME");
    expect(localStorage.getItem(BRAND_CACHE_KEY)).not.toBeNull();
  });

  test("a failed fetch with no cache is canonical", async () => {
    await bootBrand({ fetch: failingFetch });
    expect(getBrand()).toEqual({});
    expect(brandStyle()).toBeNull();
  });

  test("a server that does not serve the route is canonical", async () => {
    const server = deferredFetch();
    const booted = bootBrand({ fetch: server.impl });
    server.answer({ error: "not_found" }, 404);
    await booted;
    expect(getBrand()).toEqual({});
  });

  test("an unreadable cache is ignored", async () => {
    localStorage.setItem(BRAND_CACHE_KEY, "{not json");
    await bootBrand({ fetch: failingFetch });
    expect(getBrand()).toEqual({});
  });
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
