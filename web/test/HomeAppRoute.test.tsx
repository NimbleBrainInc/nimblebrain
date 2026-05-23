// ---------------------------------------------------------------------------
// HomeAppRoute — `?force=1` query-param contract.
//
// Pins the home-route force-refresh behavior:
//   1. `?force=1` → the home app receives `forceRefresh: true`.
//   2. No param  → `forceRefresh: false`.
//   3. The param is stripped after the first read (one-shot cache-bust,
//      not a persistent mode — must not survive a reload/workspace switch).
//   4. The strip removes ONLY `force`; other query params survive.
//
// Case 4 is the load-bearing one: the strip uses a functional
// `setSearchParams` updater, and a refactor that replaces it with a
// whole-object set would silently drop unrelated params (e.g. `?tab=`).
//
// Same plumbing as connector-sections.test.tsx: bun:test + react-dom/client
// + happy-dom (via web/test/setup.ts), no @testing-library/react.
// AppWithChat is stubbed — unmocked it mounts SlotRenderer → app iframes →
// resource fetches, none of which work or matter under happy-dom.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PlacementEntry } from "../src/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub AppWithChat down to a probe that records the `forceRefresh` prop.
let receivedForce: boolean | undefined;
mock.module("../src/components/AppWithChat", () => ({
  AppWithChat: (props: { forceRefresh?: boolean }) => {
    receivedForce = props.forceRefresh;
    return null;
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, useLocation } = await import("react-router-dom");
const { HomeAppRoute } = await import("../src/components/HomeAppRoute");

const fakePlacement: PlacementEntry = {
  serverName: "home",
  slot: "main",
  resourceUri: "ui://home/main",
  priority: 0,
  route: "/",
};

// `useLocation().search` after the strip effect settles. A render-time
// probe is enough — `setSearchParams` re-renders all router consumers.
let currentSearch = "";
function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

let active: { unmount(): void } | null = null;
afterEach(() => {
  active?.unmount();
  active = null;
  receivedForce = undefined;
  currentSearch = "";
});

async function renderAt(url: string): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <LocationProbe />
        <HomeAppRoute placement={fakePlacement} onNavigate={() => {}} />
      </MemoryRouter>,
    );
  });
  // Flush the strip effect and the re-render it triggers.
  await act(async () => {
    await Promise.resolve();
  });
  active = {
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

describe("HomeAppRoute", () => {
  test("?force=1 → app receives forceRefresh true", async () => {
    await renderAt("/?force=1");
    expect(receivedForce).toBe(true);
  });

  test("no force param → app receives forceRefresh false", async () => {
    await renderAt("/");
    expect(receivedForce).toBe(false);
  });

  test("strips ?force=1 from the URL after mount (one-shot)", async () => {
    await renderAt("/?force=1");
    expect(currentSearch).toBe("");
  });

  test("strips only force, preserves other query params", async () => {
    await renderAt("/?force=1&tab=activity");
    expect(currentSearch).toBe("?tab=activity");
  });
});
