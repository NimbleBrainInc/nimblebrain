// ---------------------------------------------------------------------------
// Login — hands the parent the bootstrap it fetched.
//
// The screen probes bootstrap and stops polling as soon as one succeeds. If
// the parent then fetched bootstrap AGAIN to authenticate, the two could
// disagree: on sign-out the probe raced the logout request, went out with the
// session cookie still set and succeeded, and the parent's second fetch landed
// after the cookie was cleared and got a 401. The parent never authenticated,
// the screen never polled again, and the user sat on "Connecting..." forever.
//
// Handing over the probe's own result makes that disagreement impossible: one
// fetch decides. Same plumbing as NotFoundPage.test.tsx: bun:test +
// react-dom/client + happy-dom, no @testing-library/react.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import type { BootstrapResponse } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { Login } = await import("../components/Login");

const BOOTSTRAP = {
  user: {
    id: "usr_1",
    email: "user@example.com",
    displayName: "User",
    orgRole: "member",
    preferences: {},
  },
  workspaces: [],
} as unknown as BootstrapResponse;

const originalFetch = globalThis.fetch;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  globalThis.fetch = originalFetch;
});

describe("Login", () => {
  test("passesTheBootstrapItFetchedToOnLogin_soTheParentDoesNotFetchAgain", async () => {
    const bootstrapCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/bootstrap")) {
        bootstrapCalls.push(url);
        return new Response(JSON.stringify(BOOTSTRAP), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const received: BootstrapResponse[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(React.createElement(Login, { onLogin: (data) => received.push(data) }));
    });
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };

    expect(received).toEqual([BOOTSTRAP]);
    expect(bootstrapCalls).toHaveLength(1);
  });
});
