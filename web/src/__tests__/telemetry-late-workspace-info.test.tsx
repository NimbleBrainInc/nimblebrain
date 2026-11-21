// ---------------------------------------------------------------------------
// A late workspace_info answer does not name a signed-out person.
//
// The shell starts telemetry from workspace_info's answer. One that arrives
// after sign-out belongs to a person the shell no longer holds, so it is
// dropped instead of identifying the browser's next events as them.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";

mock.module("../api/client", () => realClient);

const telemetryCalls: string[] = [];
mock.module("../telemetry", () => ({
  initTelemetry: (_installId: string, person?: { userId: string }) => {
    telemetryCalls.push(`init ${person?.userId ?? "anonymous"}`);
  },
  resetTelemetry: () => {
    telemetryCalls.push("reset");
  },
  setTelemetryWorkspace: () => {},
  setTelemetryRoute: () => {},
  captureEvent: () => {},
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { App } = await import("../App");

const originalFetch = globalThis.fetch;
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BOOTSTRAP = {
  user: {
    id: "usr_a",
    email: "a@example.com",
    displayName: "Ada",
    orgRole: "member",
    preferences: {},
  },
  workspaces: [],
  config: { models: {}, configuredProviders: [], files: {} },
  version: "test",
};

function isWorkspaceInfo(init?: RequestInit): boolean {
  return typeof init?.body === "string" && init.body.includes('"tool":"workspace_info"');
}

let signedIn = true;
/** Answers the pending workspace_info call; the test holds it open until after sign-out. */
let answerWorkspaceInfo: (response: Response) => void = () => {};

/** The server: signed in until logout, with workspace_info held open. */
async function server(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/v1/events")) return new Promise<Response>(() => {});
  if (url.endsWith("/v1/auth/logout")) signedIn = false;
  if (!signedIn) return json({ error: "unauthorized" }, 401);
  if (url.endsWith("/v1/bootstrap")) return json(BOOTSTRAP);
  if (isWorkspaceInfo(init)) {
    return new Promise<Response>((resolve) => {
      answerWorkspaceInfo = resolve;
    });
  }
  return json({ content: [], structuredContent: {}, isError: false });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
  window.history.pushState({}, "", "/");
});

describe("telemetry after sign-out", () => {
  test("a workspace_info answer arriving after sign-out identifies no one", async () => {
    signedIn = true;
    globalThis.fetch = server as typeof fetch;
    // Login settles on its button instead of redirecting to sign in again.
    sessionStorage.setItem("nb-sign-in-redirected-at", String(Date.now()));

    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root?.render(React.createElement(App));
    });
    await settle();

    const trigger = container.querySelector<HTMLElement>('[data-testid="user-menu-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    const signOut = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Sign out"),
    );
    expect(signOut).toBeDefined();
    await act(async () => signOut?.click());
    await settle();
    expect(telemetryCalls).toContain("reset");

    await act(async () =>
      answerWorkspaceInfo(
        json({
          content: [],
          structuredContent: {
            telemetryEnabled: true,
            telemetryIdentify: true,
            installId: "install-1",
          },
          isError: false,
        }),
      ),
    );
    await settle();

    expect(telemetryCalls.filter((call) => call.startsWith("init"))).toEqual([]);
  });
});
