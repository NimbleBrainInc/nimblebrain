// ---------------------------------------------------------------------------
// ThemeProvider — the theme in force is the person's own choice, else the
// brand's `defaultTheme`, else the OS.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom's selector parser constructs `window.SyntaxError`, which the test
// window lacks. Same patch the other DOM tests carry.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ThemeProvider, useTheme, effectivePreference } = await import("../context/ThemeContext");
const { applyBrand, bootBrand } = await import("../brand");

let theme: ReturnType<typeof useTheme>;
function Probe() {
  theme = useTheme();
  return null;
}

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;
const realMatchMedia = window.matchMedia;

/** Report the OS as dark mode. */
function osPrefersDark() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("dark"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  });
}

beforeEach(() => {
  localStorage.removeItem("nb-theme");
  document.documentElement.classList.remove("dark");
  osPrefersDark();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  applyBrand({});
  delete window.__NB_BRAND__;
  localStorage.removeItem("nb-theme");
  window.matchMedia = realMatchMedia;
});

describe("effectivePreference", () => {
  test("a stored choice wins, then the brand default, then the OS", () => {
    expect(effectivePreference("dark", "light")).toBe("dark");
    expect(effectivePreference(null, "light")).toBe("light");
    expect(effectivePreference(null, undefined)).toBe("system");
  });
});

describe("ThemeProvider with a brand default", () => {
  test("no stored choice, brand defaultTheme light, OS dark: light", async () => {
    window.__NB_BRAND__ = { defaultTheme: "light" };
    bootBrand();
    await mount();
    expect(theme.mode).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // The default is not recorded as the person's choice.
    expect(localStorage.getItem("nb-theme")).toBeNull();
  });

  test("a stored choice wins over the brand default", async () => {
    localStorage.setItem("nb-theme", "dark");
    applyBrand({ defaultTheme: "light" });
    await mount();
    expect(theme.mode).toBe("dark");
  });

  test("no brand default follows the OS", async () => {
    await mount();
    expect(theme.mode).toBe("dark");
  });
});
