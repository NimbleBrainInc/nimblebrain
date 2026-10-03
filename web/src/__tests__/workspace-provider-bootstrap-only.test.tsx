// ---------------------------------------------------------------------------
// WorkspaceProvider — bootstrap is the only source of the workspace list.
//
// Every workspace-scoped request is addressed to `/v1/workspaces/<wsId>/…`, so
// the list of workspaces cannot itself be fetched through one: there is no
// workspace to address it to until the list names one. The provider takes the
// list from bootstrap and never asks the server for it. Bootstrap names no
// focus, so no workspace is active until one is named; with an empty list none
// can be, nothing goes out, and a workspace-scoped page shows its
// "No active workspace" state. Same plumbing as login-hands-over-bootstrap:
// bun:test + react-dom/client + happy-dom. A tool call is recorded as well as
// fetch, because `callTool` without an active workspace throws before fetching.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { WorkspaceInfo } from "../context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callToolSpy = mock(realClient.callTool);
mock.module("../api/client", () => ({ ...realClient, callTool: callToolSpy }));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { WorkspaceProvider, useWorkspaceContext } = await import("../context/WorkspaceContext");
const { RequireActiveWorkspace } = await import(
  "../pages/settings/components/RequireActiveWorkspace"
);

const WS_A: WorkspaceInfo = {
  id: "ws_00079598e311c160",
  name: "A",
  memberCount: 1,
  connectorCount: 0,
};
const WS_B: WorkspaceInfo = {
  id: "ws_001c32f121060ff3",
  name: "B",
  memberCount: 1,
  connectorCount: 0,
};

const originalFetch = globalThis.fetch;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  globalThis.fetch = originalFetch;
  callToolSpy.mockClear();
});

function recordRequests(): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return requests;
}

function byAttr(container: HTMLElement, name: string, value: string): Element | null {
  return (
    Array.from(container.getElementsByTagName("*")).find((el) => el.getAttribute(name) === value) ??
    null
  );
}

function ActiveProbe() {
  const { activeWorkspace } = useWorkspaceContext();
  return React.createElement("span", { "data-testid": "active" }, activeWorkspace?.id ?? "none");
}

async function mount(initialWorkspaces: WorkspaceInfo[], initialActiveId?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(WorkspaceProvider, {
        initialWorkspaces,
        initialActiveId,
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(ActiveProbe),
          React.createElement(
            RequireActiveWorkspace,
            null,
            React.createElement("span", { "data-testid": "scoped" }, "scoped"),
          ),
        ),
      }),
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("WorkspaceProvider", () => {
  test("sendsNoRequest_andShowsNoActiveWorkspace_whenBootstrapListsNone", async () => {
    const requests = recordRequests();

    const container = await mount([]);

    expect(callToolSpy).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(byAttr(container, "data-testid", "active")?.textContent).toBe("none");
    expect(byAttr(container, "role", "alert")?.textContent).toContain("No active workspace");
    expect(byAttr(container, "data-testid", "scoped")).toBeNull();
  });

  test("focusesNothing_whenBootstrapListsWorkspacesAndNoneIsNamed", async () => {
    // Bootstrap names no focus: the URL does, through the route guard. A
    // provider given workspaces and no id focuses none, never the first.
    const requests = recordRequests();

    const container = await mount([WS_A, WS_B]);

    expect(callToolSpy).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(byAttr(container, "data-testid", "active")?.textContent).toBe("none");
  });

  test("sendsNoRequest_andFocusesTheWorkspaceItIsGiven", async () => {
    const requests = recordRequests();

    const container = await mount([WS_A, WS_B], "ws_001c32f121060ff3");

    expect(callToolSpy).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(byAttr(container, "data-testid", "active")?.textContent).toBe("ws_001c32f121060ff3");
    expect(byAttr(container, "data-testid", "scoped")).not.toBeNull();
  });
});
