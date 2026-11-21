// ---------------------------------------------------------------------------
// Login — goes straight to the identity provider, and only when that helps.
//
// The identity provider's page is the sign-in page, so a server that refuses
// bootstrap (401) sends the browser on to it without a click. Everything else
// stays: a server still starting keeps the screen on "Connecting...", which is
// also all a deployment without sign-in (the dev provider) ever shows, and a
// failed or bounced sign-in stops on the button so it cannot loop.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { BootstrapResponse } from "../types";

// Bun's mock.module registry is process-global, and Login probes bootstrap
// through the real client against a stubbed fetch, so this suite pins it
// against another suite's mock.
mock.module("../api/client", () => realClient);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { Login, SIGN_IN_PATH } = await import("../components/Login");

// biome-ignore lint/plugin/double-cast: No `config`: Login hands the body on without reading it.
const BOOTSTRAP = { user: { id: "usr_1" }, workspaces: [] } as unknown as BootstrapResponse;

const originalFetch = globalThis.fetch;
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;

let bootstrapCalls = 0;

function bootstrapAnswers(status: number) {
  bootstrapCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/bootstrap")) {
      bootstrapCalls += 1;
      return status === 200
        ? new Response(JSON.stringify(BOOTSTRAP), { status })
        : new Response("{}", { status });
    }
    // The silent refresh a 401 triggers, refused: there is no session.
    return new Response("{}", { status: 401 });
  }) as typeof fetch;
}

async function mount(firstAnswer?: "signedOut" | "unavailable") {
  const navigated: string[] = [];
  const received: BootstrapResponse[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    // StrictMode, as the app's entry point renders it: effects run, clean up,
    // and run again, so state an effect consumes on its first run is gone on
    // its second.
    root?.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(Login, {
          onLogin: (data) => received.push(data),
          navigate: (path) => navigated.push(path),
          firstAnswer,
        }),
      ),
    );
  });
  return { navigated, received, text: () => container?.textContent ?? "" };
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
});

describe("Login", () => {
  test("noSession_goesStraightToSignIn", async () => {
    bootstrapAnswers(401);
    const view = await mount();
    expect(view.navigated).toEqual([SIGN_IN_PATH]);
    expect(view.text()).toContain("Taking you to sign in");
  });

  test("signedIn_handsOver_neverNavigates", async () => {
    // What the dev provider always answers: there is no sign-in to go to.
    bootstrapAnswers(200);
    const view = await mount();
    expect(view.received).toEqual([BOOTSTRAP]);
    expect(view.navigated).toEqual([]);
  });

  test("serverNotReady_keepsConnecting_neverNavigates", async () => {
    // A server still starting says nothing about the session.
    bootstrapAnswers(503);
    const view = await mount();
    expect(view.navigated).toEqual([]);
    expect(view.text()).toContain("Connecting");
  });

  test("failedSignIn_showsTryAgain_withoutRedirecting", async () => {
    window.history.replaceState({}, "", "/?error=auth_failed");
    bootstrapAnswers(401);
    const view = await mount();
    expect(view.navigated).toEqual([]);
    expect(view.text()).toContain("Try again");
  });

  test("redirectThatCameStraightBack_stopsOnTheButton", async () => {
    sessionStorage.setItem("nb-sign-in-redirected-at", String(Date.now()));
    bootstrapAnswers(401);
    const view = await mount();
    expect(view.navigated).toEqual([]);
    expect(view.text()).toContain("Sign In");
  });

  test("oldRedirect_doesNotHoldBackANewSignIn", async () => {
    sessionStorage.setItem("nb-sign-in-redirected-at", String(Date.now() - 60_000));
    bootstrapAnswers(401);
    const view = await mount();
    expect(view.navigated).toEqual([SIGN_IN_PATH]);
  });

  test("parentFoundNoSession_goesStraightToSignIn_onceAndWithoutAskingAgain", async () => {
    bootstrapAnswers(401);
    const view = await mount("signedOut");
    expect(view.navigated).toEqual([SIGN_IN_PATH]);
    expect(bootstrapCalls).toBe(0);
  });

  test("parentFoundServerNotReady_keepsConnecting_neverNavigates", async () => {
    bootstrapAnswers(503);
    const view = await mount("unavailable");
    expect(view.navigated).toEqual([]);
    expect(view.text()).toContain("Connecting");
  });
});
