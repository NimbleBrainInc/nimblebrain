// ---------------------------------------------------------------------------
// The theme applies before sign-in.
//
// The theme provider sits at the root of the app, above the auth gate, so the
// loading skeleton and the sign-in page paint in the person's theme (their
// stored choice, else the brand's default) and the theme shortcut works there.
// No one is signed in, so a toggle stays in this browser and nothing is sent to
// the server.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { App } = await import("../App");
const { applyBrand } = await import("../brand");

const originalFetch = globalThis.fetch;
let requests: string[] = [];
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

/** No session: bootstrap is refused and the server is up, so Login settles on its sign-in button. */
function signedOut() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(`${url} ${typeof init?.body === "string" ? init.body : ""}`);
    if (url.endsWith("/v1/health")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 401 });
  }) as typeof fetch;
}

/** Bootstrap never answers, so the app stays on its loading skeleton. */
function bootstrapPending() {
  globalThis.fetch = ((_input: string | URL | Request) =>
    new Promise<Response>(() => {})) as typeof fetch;
}

async function mountApp() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root?.render(React.createElement(App));
  });
}

function isDark() {
  return document.documentElement.classList.contains("dark");
}

beforeEach(() => {
  requests = [];
  localStorage.removeItem("nb-theme");
  document.documentElement.classList.remove("dark");
  applyBrand({});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
  applyBrand({});
});

describe("theme before sign-in", () => {
  test("signInPage_storedDarkChoice_isDark", async () => {
    localStorage.setItem("nb-theme", "dark");
    signedOut();
    await mountApp();
    expect(container?.textContent).toContain("Sign In");
    expect(isDark()).toBe(true);
  });

  test("signInPage_brandDefaultDark_isDark", async () => {
    applyBrand({ defaultTheme: "dark" });
    signedOut();
    await mountApp();
    expect(container?.textContent).toContain("Sign In");
    expect(isDark()).toBe(true);
  });

  test("skeleton_storedDarkChoice_isDarkWhileBootstrapPending", async () => {
    localStorage.setItem("nb-theme", "dark");
    bootstrapPending();
    await mountApp();
    expect(container?.textContent).not.toContain("Sign In");
    expect(isDark()).toBe(true);
  });

  test("shortcutOnSignIn_togglesThemeLocally_sendsNoPreference", async () => {
    signedOut();
    await mountApp();
    expect(isDark()).toBe(false);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(isDark()).toBe(true);
    expect(localStorage.getItem("nb-theme")).toBe("dark");
    expect(requests.some((r) => r.includes("set_preferences"))).toBe(false);
  });
});
