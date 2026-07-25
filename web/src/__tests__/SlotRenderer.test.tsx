// ---------------------------------------------------------------------------
// SlotRenderer — a placement that fails to load must SAY so.
//
// The container is populated imperatively, so the pre-existing behavior on a
// failed `getResources` was `console.warn` plus an empty container: blank space,
// indistinguishable from a crashed app.
//
// This path is common rather than exotic. Keeping a boot-failed bundle's
// placement alive means the app stays in the sidebar while its source is
// unregistered, so `getResources` returns 403 until something revives it — a
// failure the user can reach by clicking the app.
//
// Pinned here: the message names the app and carries the reason, text goes
// through `textContent` (the label is bundle-authored and the message is
// server-supplied), and one broken placement doesn't stop the ones after it.
//
// Same plumbing as ContextInspectorPage.test.tsx: whole-module mock over the
// api/client snapshot from web/test/setup.ts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { PlacementEntry } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getResources = mock(
  async (_appName: string, _path: string): Promise<{ html: string }> => ({ html: "<p>ok</p>" }),
);

mock.module("../api/client", () => ({ ...realClient, getResources }));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ThemeProvider } = await import("../context/ThemeContext");
const { SlotRenderer } = await import("../components/SlotRenderer");

function placement(serverName: string, label?: string): PlacementEntry {
  return {
    serverName,
    slot: "sidebar.apps",
    resourceUri: `ui://${serverName}/main`,
    priority: 0,
    ...(label ? { label } : {}),
  } as unknown as PlacementEntry;
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
beforeEach(() => {
  getResources.mockReset();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mount(placements: PlacementEntry[]): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ThemeProvider, null, React.createElement(SlotRenderer, { placements })),
    );
  });
  // Let the async render loop settle (fetch → mount / error).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const handle: Mounted = {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted = handle;
  return handle;
}

describe("SlotRenderer — failed placement", () => {
  test("failedLoad_namesTheAppAndTheReason", async () => {
    getResources.mockImplementation(async () => {
      throw new Error('App "memory" is not available in this workspace');
    });

    const { container } = await mount([placement("memory", "Memory")]);

    expect(container.textContent).toContain("Memory");
    expect(container.textContent).toContain("couldn’t be loaded");
    expect(container.textContent).toContain("is not available in this workspace");
    // The failure replaces the iframe rather than sitting beside it.
    expect(container.getElementsByTagName("iframe").length).toBe(0);
  });

  test("failedLoad_fallsBackToTheServerNameWithoutALabel", async () => {
    getResources.mockImplementation(async () => {
      throw new Error("boom");
    });

    const { container } = await mount([placement("ai-nimblebrain-memory-mcp")]);

    expect(container.textContent).toContain("ai-nimblebrain-memory-mcp");
  });

  test("nonErrorRejection_stillRendersAReason", async () => {
    // The `err instanceof Error` branch — a non-Error rejection must not render
    // "[object Object]" or an empty reason.
    getResources.mockImplementation(async () => {
      throw "just a string";
    });

    const { container } = await mount([placement("memory", "Memory")]);

    expect(container.textContent).toContain("Unknown error");
  });

  test("markupInTheReason_isEscapedNotParsed", async () => {
    // The label is bundle-authored and the message is server-supplied, so both
    // go through textContent. A tag in either must stay inert.
    getResources.mockImplementation(async () => {
      throw new Error("<img src=x onerror=alert(1)>");
    });

    const { container } = await mount([placement("memory", "Memory")]);

    expect(container.getElementsByTagName("img").length).toBe(0);
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("oneBrokenPlacement_doesNotBlockTheNextOne", async () => {
    getResources.mockImplementation(async (appName: string) => {
      if (appName === "broken") throw new Error("down");
      return { html: "<p>fine</p>" };
    });

    const { container } = await mount([placement("broken", "Broken"), placement("ok", "Ok")]);

    expect(container.textContent).toContain("Broken");
    expect(container.getElementsByTagName("iframe").length).toBe(1);
  });
});
