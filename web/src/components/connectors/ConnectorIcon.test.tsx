// ---------------------------------------------------------------------------
// ConnectorIcon — the `dark:` variant, not the page's theme, picks a CDN icon's
// variant, so an icon on a dark surface of a light page (a brand's dark
// light-mode sidebar) shows its dark artwork. happy-dom applies no Tailwind, so
// these assert the markup that drives the cascade, not what is visible.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ConnectorIcon } = await import("./ConnectorIcon");

const BASE = "https://static.nimblebrain.ai/logos/github";
const LIGHT = `${BASE}/light.svg`;
const DARK = `${BASE}/dark.svg`;

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(props: { name: string; iconUrl?: string; className?: string }) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
  }
  await act(async () => {
    root?.render(React.createElement(ConnectorIcon, props));
  });
  return container;
}

function imgs() {
  return [...(container?.querySelectorAll("img") ?? [])];
}

async function failLoad(src: string) {
  const img = imgs().find((i) => i.getAttribute("src") === src);
  await act(async () => {
    img?.dispatchEvent(new window.Event("error"));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ConnectorIcon", () => {
  test("themedUrl_rendersBothVariants_withCascadeClasses", async () => {
    await render({ name: "GitHub", iconUrl: LIGHT });
    const [light, dark] = imgs();
    expect(light?.getAttribute("src")).toBe(LIGHT);
    expect(light?.className).toContain("dark:hidden");
    expect(dark?.getAttribute("src")).toBe(DARK);
    expect(dark?.className).toContain("hidden");
    expect(dark?.className).toContain("dark:block");
  });

  test("themedUrl_rendersOneElement_carryingClassName", async () => {
    const el = await render({ name: "GitHub", iconUrl: DARK, className: "size-4 ring-2" });
    expect(el.children).toHaveLength(1);
    expect(el.firstElementChild?.className).toContain("size-4 ring-2");
  });

  test("nonThemedUrl_rendersSingleImg", async () => {
    const url = "https://cdn.example.com/icon.png";
    const el = await render({ name: "Example", iconUrl: url, className: "size-4" });
    expect(imgs().map((i) => i.getAttribute("src"))).toEqual([url]);
    expect(el.firstElementChild?.tagName).toBe("IMG");
    expect(el.firstElementChild?.className).toContain("size-4");
  });

  test("oneVariantErrors_survivorServesBothModes", async () => {
    await render({ name: "GitHub", iconUrl: LIGHT });
    await failLoad(DARK);
    expect(imgs().map((i) => i.getAttribute("src"))).toEqual([LIGHT]);
    expect(imgs()[0]?.className).not.toContain("dark:hidden");
  });

  test("bothVariantsError_showsLetterAvatar", async () => {
    await render({ name: "GitHub", iconUrl: LIGHT });
    await failLoad(DARK);
    await failLoad(LIGHT);
    expect(imgs()).toHaveLength(0);
    expect(container?.textContent).toBe("G");
  });

  test("noIconUrl_showsLetterAvatar", async () => {
    await render({ name: "slack" });
    expect(imgs()).toHaveLength(0);
    expect(container?.textContent).toBe("S");
  });

  test("iconUrlChange_startsWithNothingBroken", async () => {
    await render({ name: "GitHub", iconUrl: LIGHT });
    await failLoad(DARK);
    await failLoad(LIGHT);
    const next = "https://static.nimblebrain.ai/logos/google-drive/light.svg";
    await render({ name: "Drive", iconUrl: next });
    expect(imgs()).toHaveLength(2);
  });
});
