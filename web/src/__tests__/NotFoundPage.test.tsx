// ---------------------------------------------------------------------------
// NotFoundPage — the shell's terminal route.
//
// `<Routes>` renders `null` when nothing matches, so before this existed an
// unmatched path left the main area blank: a white screen that looked exactly
// like a crashed app. The common way to reach it is an app URL whose placement
// is gone, which is why the copy points at the app rather than at the URL.
//
// The `settled` gate is the subtle half. App routes are derived from the shell's
// placements, and on a workspace switch those deliberately lag (the no-flash
// window). A path that will match once they land must not be declared missing
// first — so `settled=false` must render pending, never the not-available copy.
//
// Same plumbing as ResourceLinkView.test.tsx: bun:test + react-dom/client +
// happy-dom, no @testing-library/react.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NotFoundPage } = await import("../pages/NotFoundPage");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mount(settled: boolean): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, null, React.createElement(NotFoundPage, { settled })),
    );
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

describe("NotFoundPage", () => {
  test("settled_rendersNotAvailableWithAWayOut", async () => {
    const { container } = await mount(true);
    expect(container.textContent).toContain("isn’t available");
    // A terminal route with no escape is its own dead end.
    const link = container.getElementsByTagName("a")[0];
    expect(link?.getAttribute("href")).toBe("/");
  });

  test("notSettled_rendersPendingNotAClaimThatTheRouteIsMissing", async () => {
    const { container } = await mount(false);
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("isn’t available");
  });
});
