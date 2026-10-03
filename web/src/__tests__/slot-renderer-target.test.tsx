// ---------------------------------------------------------------------------
// SlotRenderer `target` — opening a view inside a placement.
//
// Pins: a target reaches the app as `ai.nimblebrain/navigate` only once the
// app is listening, which is once it has reported a location. The handshake
// alone is too early: the app has not yet rendered the code that subscribes,
// and it drops a notification nobody subscribed to. A target given at mount
// waits for that first report; an app that never reports a trail is never sent
// one. A new target `key` on a listening placement sends again (the same view
// asked for twice is sent twice), and an unchanged key is not resent.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { PlacementEntry } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("../api/client", () => ({
  ...realClient,
  getResources: mock(async () => ({ html: "<p>app</p>" })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ThemeProvider } = await import("../context/ThemeContext");
const { SlotRenderer } = await import("../components/SlotRenderer");
const { NAVIGATE_METHOD } = await import("../bridge/extensions");

const PEOPLE = {
  serverName: "people",
  slot: "sidebar.apps",
  resourceUri: "ui://people/main",
  priority: 0,
} as PlacementEntry;

type Target = { id: string; key: string } | undefined;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Mount a placement, then stand in for its iframe and complete the handshake. */
async function mountWithTarget(target: Target) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  const render = (t: Target) =>
    root.render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(SlotRenderer, { placements: [PEOPLE], target: t }),
      ),
    );
  await act(async () => render(target));
  await settle();

  const iframe = container.getElementsByTagName("iframe")[0];
  if (!iframe) throw new Error("no iframe mounted");
  const inbox: unknown[] = [];
  const stub = { postMessage: (data: unknown) => inbox.push(data) } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => stub });
  const send = (data: unknown) => {
    const Ctor = (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
    const event = new Ctor("message", { data });
    Object.defineProperty(event, "source", { configurable: true, get: () => stub });
    window.dispatchEvent(event);
  };
  send({
    jsonrpc: "2.0",
    id: "init",
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      clientInfo: { name: "people", version: "1.0.0" },
      capabilities: {},
    },
  });
  send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  await settle();

  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const navigations = () =>
    inbox.filter((m) => (m as { method?: string }).method === NAVIGATE_METHOD);
  /** The app reports where it is, as `useTrail` does once it is subscribed to `navigate`. */
  const reportLocation = async () => {
    send({
      jsonrpc: "2.0",
      method: "ai.nimblebrain/location",
      params: { trail: [{ id: "people://contacts", label: "People" }] },
    });
    await settle();
  };
  return {
    navigations,
    reportLocation,
    rerender: async (t: Target) => act(async () => render(t)),
  };
}

describe("SlotRenderer target", () => {
  test("a target given at mount waits for the app's first location, then reaches it", async () => {
    const { navigations, reportLocation } = await mountWithTarget({
      id: "people://contacts/1",
      key: "k1",
    });
    // Handshake done, nothing reported: the app is not listening yet.
    expect(navigations()).toEqual([]);

    await reportLocation();
    await reportLocation();
    expect(navigations()).toEqual([
      { jsonrpc: "2.0", method: NAVIGATE_METHOD, params: { id: "people://contacts/1" } },
    ]);
  });

  test("an app that never reports a trail is never sent a target", async () => {
    const { navigations, rerender } = await mountWithTarget({
      id: "people://contacts/1",
      key: "k1",
    });
    await rerender({ id: "people://contacts/2", key: "k2" });
    expect(navigations()).toEqual([]);
  });

  test("a new key sends again; the same key does not", async () => {
    const { navigations, rerender, reportLocation } = await mountWithTarget(undefined);
    await reportLocation();
    expect(navigations()).toEqual([]);

    await rerender({ id: "people://contacts/2", key: "k2" });
    await rerender({ id: "people://contacts/2", key: "k2" });
    await rerender({ id: "people://contacts/2", key: "k3" });

    expect(navigations().map((m) => (m as { params: { id: string } }).params.id)).toEqual([
      "people://contacts/2",
      "people://contacts/2",
    ]);
  });
});
