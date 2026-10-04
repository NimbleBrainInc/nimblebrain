/**
 * The loading frame draws the sidebar at the width the shell will open it at,
 * so a refresh keeps its layout: expanded or collapsed as remembered on a wide
 * screen, collapsed on a medium one, and no sidebar on a narrow one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { AppFrameSkeleton } = await import("../src/components/AppFrameSkeleton");

const realMatchMedia = window.matchMedia;
let unmount: (() => void) | null = null;

afterEach(() => {
  window.matchMedia = realMatchMedia;
  localStorage.clear();
  unmount?.();
  unmount = null;
});

/** A viewport `width` px wide, as far as the breakpoints are concerned. */
function viewport(width: number) {
  window.matchMedia = ((query: string) => {
    const mq = realMatchMedia.call(window, query);
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    return Object.defineProperty(mq, "matches", { value: width >= min });
  }) as typeof window.matchMedia;
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => root.render(<AppFrameSkeleton />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

const sidebar = (c: HTMLElement) =>
  c.querySelector("[data-testid='app-frame-skeleton'] > div[aria-hidden='true']");

describe("the loading frame", () => {
  test("draws an expanded sidebar on a wide screen, and says it is loading to a screen reader", async () => {
    viewport(1280);
    const c = await mount();
    expect(sidebar(c)?.className).toContain("w-60");
    expect(c.querySelector("[role='status']")?.textContent).toBe("Loading…");
    expect(c.textContent).not.toContain("Loading...");
  });

  test("keeps a sidebar the reader collapsed", async () => {
    viewport(1280);
    localStorage.setItem("nb:sidebarState", "collapsed");
    const c = await mount();
    expect(sidebar(c)?.className).toContain("w-16");
  });

  test("draws no sidebar on a narrow screen", async () => {
    viewport(600);
    const c = await mount();
    expect(sidebar(c)).toBeNull();
  });
});
