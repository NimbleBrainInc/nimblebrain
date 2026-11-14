// ---------------------------------------------------------------------------
// Where an app's `_meta.ui.prefersBorder` is honoured
//
// An inline view sits among chat content, so a frame the app asks to have
// bordered gets the border. A placement that fills its pane is already bounded
// by the shell's chrome, and a border there doubles the header rule above it,
// so it renders borderless whatever the app asks. A placement sized to its
// content sits in a page's flow and keeps the border, as an inline view does.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../test/setup";
import type * as ApiClient from "../api/client";
import type { PlacementEntry } from "../types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getResources = mock<typeof ApiClient.getResources>(async () => ({
  html: "<html><head></head><body></body></html>",
  metaUi: { prefersBorder: true },
}));

mock.module("../api/client", () => ({ ...realClient, getResources }));

mock.module("../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mock(async () => ({ result: { content: [] } })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NoticeProvider } = await import("../components/notices");
const { ThemeProvider } = await import("../context/ThemeContext");
const { InlineAppView } = await import("../components/InlineAppView");
const { SlotRenderer } = await import("../components/SlotRenderer");

// happy-dom does not expand a `var()` inside the `border` shorthand into its
// longhands, so a bordered frame is told by its `var(--card)` background (set
// only with the border) and a border style other than `none`.
function isBordered(iframe: HTMLIFrameElement): boolean {
  return iframe.style.borderStyle !== "none" && iframe.style.background === "var(--card)";
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

/** Render `el` inside the shell's providers and return the app frame it mounts. */
async function mountFrame(el: React.ReactElement): Promise<HTMLIFrameElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(NoticeProvider, null, React.createElement(ThemeProvider, null, el)),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  teardown = () => {
    act(() => root.unmount());
    container.remove();
  };
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("no iframe mounted");
  return iframe;
}

const placement: PlacementEntry = {
  serverName: "todos",
  slot: "sidebar.apps",
  resourceUri: "ui://todos/main",
  priority: 0,
};

describe("an app that sets prefersBorder", () => {
  test("inline view: the frame is bordered", async () => {
    const iframe = await mountFrame(
      React.createElement(InlineAppView, { appName: "todos", resourceUri: "ui://todos/main" }),
    );
    expect(isBordered(iframe)).toBe(true);
  });

  test("full-pane placement: the frame is borderless", async () => {
    const iframe = await mountFrame(React.createElement(SlotRenderer, { placements: [placement] }));
    expect(iframe.style.borderStyle).toBe("none");
    expect(isBordered(iframe)).toBe(false);
  });

  test("placement sized to its content: the frame is bordered", async () => {
    const iframe = await mountFrame(
      React.createElement(SlotRenderer, { placements: [placement], fitContent: true }),
    );
    expect(isBordered(iframe)).toBe(true);
  });
});
