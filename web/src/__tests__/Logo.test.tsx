/**
 * `Logo` paints the brand's artwork when the brand supplies it and falls back to
 * the bundled artwork when it does not. `alt` is the brand's name either way.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { Logo, MAX_GROWTH, MAX_WIDEN, opticalSize } = await import("../components/Logo");
const { applyBrand } = await import("../brand");

const BRAND_LOGO = {
  light: "https://static.example.com/brands/acme/logo-light.svg",
  dark: "https://static.example.com/brands/acme/logo-dark.svg",
  mark: "https://static.example.com/brands/acme/mark.svg",
};

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  applyBrand({});
});

async function images(props: Parameters<typeof Logo>[0] = {}): Promise<HTMLImageElement[]> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(Logo, props));
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return [...container.querySelectorAll("img")];
}

const srcs = (imgs: HTMLImageElement[]) => imgs.map((img) => img.getAttribute("src"));
const alts = (imgs: HTMLImageElement[]) => imgs.map((img) => img.getAttribute("alt"));

describe("Logo", () => {
  test("with no brand, renders the bundled artwork named NimbleBrain", async () => {
    const imgs = await images();
    expect(imgs).toHaveLength(2);
    for (const src of srcs(imgs)) expect(src).not.toContain("static.example.com");
    expect(alts(imgs)).toEqual(["NimbleBrain", "NimbleBrain"]);
  });

  test("renders the brand's light and dark logos, named for the brand", async () => {
    applyBrand({ name: "ACME", logo: BRAND_LOGO });
    const imgs = await images();
    expect(srcs(imgs)).toEqual([BRAND_LOGO.light, BRAND_LOGO.dark]);
    expect(alts(imgs)).toEqual(["ACME", "ACME"]);
  });

  test("a brand with one logo variant uses it in both modes", async () => {
    applyBrand({ name: "ACME", logo: { light: BRAND_LOGO.light } });
    const imgs = await images();
    expect(srcs(imgs)).toEqual([BRAND_LOGO.light]);
  });

  test("the icon variant renders the brand's mark", async () => {
    applyBrand({ name: "ACME", logo: BRAND_LOGO });
    const imgs = await images({ variant: "icon" });
    expect(srcs(imgs)).toEqual([BRAND_LOGO.mark]);
  });

  test("falls back to the bundled artwork when the brand has no logo", async () => {
    applyBrand({ name: "ACME" });
    const imgs = await images();
    expect(imgs).toHaveLength(2);
    for (const src of srcs(imgs)) expect(src).not.toContain("static.example.com");
    expect(alts(imgs)).toEqual(["ACME", "ACME"]);
  });

  test("the icon variant falls back when the brand has no mark", async () => {
    applyBrand({ name: "ACME", logo: { light: BRAND_LOGO.light } });
    const imgs = await images({ variant: "icon" });
    expect(imgs).toHaveLength(2);
    for (const src of srcs(imgs)) expect(src).not.toContain("static.example.com");
  });
});

describe("opticalSize", () => {
  const FULL = 6735 / 1336;

  test("bundled artwork's own aspect renders at the given height", () => {
    expect(opticalSize(24, FULL, FULL)).toBeCloseTo(24);
  });

  test("a compact lockup renders taller, at the same area", () => {
    const h = opticalSize(24, FULL, 800 / 429);
    expect(h).toBeCloseTo(39.5, 1);
    expect(h * h * (800 / 429)).toBeCloseTo(24 * 24 * FULL);
  });

  test("never taller than maxHeight", () => {
    expect(opticalSize(24, FULL, 1)).toBe(24 * MAX_GROWTH);
    expect(opticalSize(28, 1576 / 1336, 0.5, 36)).toBe(36);
  });

  test("never wider than the bundled artwork allows", () => {
    const aspect = 12;
    expect(opticalSize(24, FULL, aspect) * aspect).toBeCloseTo(24 * FULL * MAX_WIDEN);
  });

  test("never wider than maxWidth", () => {
    expect(opticalSize(28, 1576 / 1336, 2, 36, 36) * 2).toBe(36);
  });
});

describe("Logo sizing", () => {
  function dispatch(img: HTMLImageElement, type: "load" | "error") {
    act(() => {
      const win = img.ownerDocument.defaultView;
      if (!win) throw new Error("no window");
      img.dispatchEvent(new win.Event(type));
    });
  }

  function load(img: HTMLImageElement, width: number, height: number) {
    Object.defineProperty(img, "naturalWidth", { value: width });
    Object.defineProperty(img, "naturalHeight", { value: height });
    dispatch(img, "load");
  }

  async function brandImage(): Promise<HTMLImageElement> {
    applyBrand({ name: "ACME", logo: { light: BRAND_LOGO.light } });
    const [img] = await images({ height: 24 });
    if (!img) throw new Error("no image");
    return img;
  }

  test("bundled artwork renders at the given height", async () => {
    const [img] = await images({ height: 24 });
    expect(img?.style.height).toBe("24px");
    expect(img?.style.visibility).toBe("");
  });

  test("a brand's artwork stays hidden until it loads, then renders at the optical size", async () => {
    const img = await brandImage();
    expect(img.style.visibility).toBe("hidden");
    load(img, 800, 429);
    expect(img.style.visibility).toBe("");
    expect(Number.parseFloat(img.style.height)).toBeCloseTo(
      opticalSize(24, 6735 / 1336, 800 / 429),
      1,
    );
  });

  test("a brand's artwork with no natural size renders at the given height", async () => {
    const img = await brandImage();
    load(img, 0, 0);
    expect(img.style.visibility).toBe("");
    expect(img.style.height).toBe("24px");
  });

  test("a brand's artwork that fails to load is shown, so its alt text is", async () => {
    const img = await brandImage();
    dispatch(img, "error");
    expect(img.style.visibility).toBe("");
    expect(img.style.height).toBe("24px");
  });
});
