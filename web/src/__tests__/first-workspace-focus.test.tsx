// ---------------------------------------------------------------------------
// The first workspace focused in a session.
//
// The shell mounts with no workspace focused. Focusing the first one loads its
// placements behind the mounted tree, so state the tree holds (a theme chosen
// on the home page) outlives the load instead of being seeded again from the
// bootstrap taken at sign-in, and a deep link waits for its placements rather
// than reporting its page missing.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";

// Bun's mock.module registry is process-global, and these tests drive the real
// client against a stubbed fetch, so they pin it against another suite's mock.
mock.module("../api/client", () => realClient);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { App } = await import("../App");

const originalFetch = globalThis.fetch;
let storedTheme = "light";
/** What a workspace's shell request answers; a test can hold it open. */
let shellResponse: () => Promise<Response>;
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function toolResult(structuredContent: unknown) {
  return json({ content: [{ type: "text", text: "ok" }], structuredContent, isError: false });
}

/** A signed-in account whose stored theme lives in `storedTheme`, as the server's would. */
function signedIn() {
  const bootstrapTheme = storedTheme;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v1/events")) return new Promise<Response>(() => {});
    if (url.endsWith("/v1/bootstrap")) {
      return json({
        user: {
          id: "user-1",
          email: "person@example.com",
          displayName: "Person",
          orgRole: "member",
          preferences: { theme: bootstrapTheme },
        },
        // Two, because the home page opens a person's only workspace by itself.
        workspaces: [
          { id: "ws_acme", name: "Acme", role: "admin", memberCount: 1, connectorCount: 0 },
          { id: "ws_globex", name: "Globex", role: "admin", memberCount: 1, connectorCount: 0 },
        ],
        config: { models: {}, configuredProviders: [], files: {} },
        version: "test",
      });
    }
    if (url.endsWith("/shell")) return shellResponse();
    if (url.endsWith("/v1/tools/call") && typeof init?.body === "string") {
      const call = JSON.parse(init.body) as { tool: string; arguments?: { theme?: string } };
      if (call.tool === "set_preferences" && call.arguments?.theme) {
        storedTheme = call.arguments.theme;
      }
      return toolResult({ configuredProviders: [], preferences: { theme: storedTheme } });
    }
    return json({});
  }) as typeof fetch;
}

function isDark() {
  return document.documentElement.classList.contains("dark");
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function toggleTheme() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true, bubbles: true }),
    );
  });
  await settle();
}

async function openWorkspace() {
  const link = container?.querySelector<HTMLElement>('a[href^="/w/"]');
  expect(link).not.toBeNull();
  await act(async () => {
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
  expect(window.location.pathname.startsWith("/w/")).toBe(true);
}

async function mountApp() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root?.render(React.createElement(App));
  });
  await settle();
}

beforeEach(() => {
  storedTheme = "light";
  shellResponse = async () => json({ placements: [], eventsEndpoint: "/v1/events" });
  localStorage.removeItem("nb-theme");
  document.documentElement.classList.remove("dark");
  window.history.pushState({}, "", "/");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
  localStorage.removeItem("nb-theme");
  window.history.pushState({}, "", "/");
});

describe("first workspace focus", () => {
  test("homeToggle_thenOpenWorkspace_keepsTheToggledTheme", async () => {
    signedIn();
    await mountApp();
    expect(isDark()).toBe(false);

    await toggleTheme();
    expect(isDark()).toBe(true);
    expect(storedTheme).toBe("dark");

    await openWorkspace();

    expect(isDark()).toBe(true);
    expect(localStorage.getItem("nb-theme")).toBe("dark");
  });

  test("deepLinkToApp_whilePlacementsLoad_waitsWithoutReportingThePageMissing", async () => {
    let finishShell: (response: Response) => void = () => {};
    shellResponse = () =>
      new Promise<Response>((resolve) => {
        finishShell = resolve;
      });
    window.history.pushState({}, "", "/w/acme/app/report");
    signedIn();
    await mountApp();

    expect(container?.textContent).toContain("Loading");
    expect(container?.textContent).not.toContain("isn’t available");

    await act(async () => {
      finishShell(
        json({
          placements: [
            {
              serverName: "report",
              resourceUri: "ui://report/main",
              slot: "main",
              route: "report",
              priority: 1,
            },
          ],
          eventsEndpoint: "/v1/events",
        }),
      );
    });
    await settle();

    expect(window.location.pathname).toBe("/w/acme/app/report");
    expect(container?.textContent).not.toContain("isn’t available");
  });
});
