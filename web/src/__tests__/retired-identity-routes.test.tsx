// ---------------------------------------------------------------------------
// A renamed identity view's old path redirects to its new one, so a bookmark
// or a shared link to `/w/<slug>/automations` opens the Tasks view.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { retiredIdentityAppRoutes } = await import("../lib/retired-identity-routes");

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;
let path = "";

function PathProbe() {
  path = useLocation().pathname;
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("retired identity view paths", () => {
  test("/w/<slug>/automations redirects to /w/<slug>/tasks", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={["/w/0071a5bbf40116e6/automations"]}>
          <Routes>
            <Route path="/w/:slug">
              <Route path="tasks" element={<PathProbe />} />
              {retiredIdentityAppRoutes()}
            </Route>
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(path).toBe("/w/0071a5bbf40116e6/tasks");
  });
});
