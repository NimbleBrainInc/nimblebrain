/**
 * `Logo` paints the brand's artwork when the brand supplies it and falls back to
 * the bundled artwork when it does not. `alt` is the brand's name either way.
 */

import { afterEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom doesn't expose SyntaxError/TypeError on its Window stub; any
// querySelectorAll trips it. Same patch the other component tests carry.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { Logo } = await import("../components/Logo");
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

  test("re-renders when the brand is applied after mount", async () => {
    const imgs = await images();
    expect(alts(imgs)[0]).toBe("NimbleBrain");
    await act(async () => applyBrand({ name: "ACME", logo: BRAND_LOGO }));
    const container = imgs[0]?.closest("span")?.parentElement;
    expect(srcs([...(container?.querySelectorAll("img") ?? [])])).toEqual([
      BRAND_LOGO.light,
      BRAND_LOGO.dark,
    ]);
  });
});
