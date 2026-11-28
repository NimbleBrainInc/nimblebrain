// ---------------------------------------------------------------------------
// The shell keeps this browser's theme in step with the person's server-side
// preference, including when they have none: a theme cleared anywhere (chat,
// another tab, the profile page in another browser) drops this browser's copy,
// so the default applies.
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
/** The person's stored theme on the server; null is none. */
let storedTheme: string | null = null;
/** Pushes a frame onto the open `/v1/events` stream. */
let pushEvent: (frame: string) => void = () => {};
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const prefs = () => (storedTheme ? { theme: storedTheme } : {});

function signedIn() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v1/events")) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          pushEvent = (frame) => controller.enqueue(encoder.encode(frame));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/v1/bootstrap")) {
      return json({
        user: {
          id: "user-1",
          email: "person@example.com",
          displayName: "Person",
          orgRole: "member",
          preferences: prefs(),
        },
        workspaces: [
          { id: "ws_acme", name: "Acme", role: "admin", memberCount: 1, connectorCount: 0 },
          { id: "ws_globex", name: "Globex", role: "admin", memberCount: 1, connectorCount: 0 },
        ],
        config: { models: {}, configuredProviders: [], files: {} },
        version: "test",
      });
    }
    if (url.endsWith("/shell")) return json({ placements: [], eventsEndpoint: "/v1/events" });
    if (url.endsWith("/v1/tools/call")) {
      return json({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { configuredProviders: [], preferences: prefs() },
        isError: false,
      });
    }
    return json({});
  }) as typeof fetch;
}

const isDark = () => document.documentElement.classList.contains("dark");

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
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
  storedTheme = null;
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

describe("a theme cleared on the server", () => {
  test("cleared elsewhere while the shell is open: this browser's theme is dropped", async () => {
    storedTheme = "dark";
    signedIn();
    await mountApp();
    expect(isDark()).toBe(true);
    expect(localStorage.getItem("nb-theme")).toBe("dark");

    // Cleared through chat or another tab: the server says so with config.changed.
    storedTheme = null;
    await act(async () => pushEvent('event: config.changed\ndata: {"fields":["preferences"]}\n\n'));
    await settle();

    expect(localStorage.getItem("nb-theme")).toBeNull();
    expect(isDark()).toBe(false);
  });

  test("cleared before this load: the stale copy in this browser is dropped", async () => {
    localStorage.setItem("nb-theme", "dark");
    document.documentElement.classList.add("dark");
    signedIn();
    await mountApp();

    expect(localStorage.getItem("nb-theme")).toBeNull();
    expect(isDark()).toBe(false);
  });
});
