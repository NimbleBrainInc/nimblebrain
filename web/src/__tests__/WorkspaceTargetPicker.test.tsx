// ---------------------------------------------------------------------------
// WorkspaceTargetPicker — render + selection contract.
//
// Pins three things T010's install dialog relies on:
//
//   1. `workspacesEligibleForInstall` filters to admin-role workspaces.
//      Member-only workspaces are HIDDEN, not disabled — a member can't
//      install into a workspace they don't admin, and surfacing the row
//      as a dead affordance would imply the operation is on the table.
//      (Personal workspaces invariably have the owner as admin per
//      Stage 1 invariant, so personal rows pass this filter
//      unconditionally.)
//
//   2. The Personal vs Shared badge renders correctly. The dialog's
//      typed-confirmation gate is driven by `isPersonal`, so a wrong
//      badge would visually mislead the user about whether they're
//      about to install into a shared workspace.
//
//   3. The picker is fully controlled — clicking a row calls `onChange`
//      with that workspace id; the picker does NOT store its own
//      selection state. The dialog owns selection so a close+reopen
//      can reset it (regression: an internal-state picker would
//      leak prior selection into the next install).
//
// Mirrors the testing patterns in connector-sections.test.tsx: bun:test +
// react-dom/client + happy-dom (via web/test/setup.ts). Uses
// getElementsByTagName + data-testid lookups instead of CSS selectors —
// happy-dom's selector parser misbehaves on common testing-library
// idioms like `[role="radio"]`.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { WorkspaceTargetPicker, workspacesEligibleForInstall } = await import(
  "../components/connectors/WorkspaceTargetPicker"
);

import type { WorkspaceInfo } from "../context/WorkspaceContext";

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function ws(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws_default",
    name: "Default",
    memberCount: 1,
    bundles: [],
    userRole: "admin",
    ...over,
  };
}

/** Find a button by data-testid; happy-dom dislikes [data-foo] selectors,
 *  so iterate getElementsByTagName and read the attribute. */
function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  const all = Array.from(container.getElementsByTagName("*"));
  for (const el of all) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function countByRole(container: HTMLElement, role: string): number {
  const all = Array.from(container.getElementsByTagName("*"));
  return all.filter((el) => el.getAttribute("role") === role).length;
}

describe("workspacesEligibleForInstall", () => {
  test("hides member-only workspaces (admin-only install)", () => {
    const out = workspacesEligibleForInstall([
      ws({ id: "ws_personal", name: "Personal", userRole: "admin", isPersonal: true }),
      ws({ id: "ws_shared_admin", name: "Helix", userRole: "admin" }),
      ws({ id: "ws_viewer", name: "Partner", userRole: "member" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_personal", "ws_shared_admin"]);
    // Member-only row is not present — see the comment header. A
    // disabled-with-tooltip variant was considered and rejected:
    // hiding the row keeps the picker scannable when the user is
    // in many workspaces they don't admin.
    expect(out.find((w) => w.id === "ws_viewer")).toBeUndefined();
  });

  test("preserves the Personal/Shared distinction via isPersonal", () => {
    const out = workspacesEligibleForInstall([
      ws({ id: "ws_personal", name: "Personal", userRole: "admin", isPersonal: true }),
      ws({ id: "ws_shared", name: "Helix", userRole: "admin", isPersonal: false }),
    ]);
    expect(out[0]?.isPersonal).toBe(true);
    expect(out[1]?.isPersonal).toBe(false);
  });

  test("returns an empty list when the user is only a member (no admin workspaces)", () => {
    const out = workspacesEligibleForInstall([ws({ id: "ws_a", userRole: "member" })]);
    expect(out).toEqual([]);
  });
});

describe("WorkspaceTargetPicker", () => {
  test("renders one radio row per workspace, Personal/Shared badges visible", async () => {
    mounted = await mount(
      <WorkspaceTargetPicker
        workspaces={[
          { id: "ws_user_u1", name: "My Workspace", isPersonal: true },
          { id: "ws_helix", name: "Helix", isPersonal: false },
        ]}
        selectedWorkspaceId={null}
        onChange={() => {}}
      />,
    );
    expect(countByRole(mounted.container, "radio")).toBe(2);
    // Badge text is part of the rendered subtree.
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Personal");
    expect(text).toContain("Shared");
    expect(text).toContain("My Workspace");
    expect(text).toContain("Helix");
  });

  test("aria-checked reflects the controlled selection", async () => {
    mounted = await mount(
      <WorkspaceTargetPicker
        workspaces={[
          { id: "ws_user_u1", name: "My Workspace", isPersonal: true },
          { id: "ws_helix", name: "Helix", isPersonal: false },
        ]}
        selectedWorkspaceId="ws_helix"
        onChange={() => {}}
      />,
    );
    const selected = findByTestId(mounted.container, "workspace-target-ws_helix");
    const unselected = findByTestId(mounted.container, "workspace-target-ws_user_u1");
    expect(selected?.getAttribute("aria-checked")).toBe("true");
    expect(unselected?.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking a row invokes onChange with that workspace id (controlled — no internal state)", async () => {
    const onChange = mock((_id: string) => {});
    mounted = await mount(
      <WorkspaceTargetPicker
        workspaces={[
          { id: "ws_user_u1", name: "My Workspace", isPersonal: true },
          { id: "ws_helix", name: "Helix", isPersonal: false },
        ]}
        selectedWorkspaceId={null}
        onChange={onChange}
      />,
    );
    const helixButton = findByTestId(
      mounted.container,
      "workspace-target-ws_helix",
    ) as HTMLButtonElement | null;
    expect(helixButton).not.toBeNull();
    await act(async () => {
      helixButton?.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe("ws_helix");
  });

  test("empty workspace list renders a clear empty-state, not an empty radio group", async () => {
    mounted = await mount(
      <WorkspaceTargetPicker workspaces={[]} selectedWorkspaceId={null} onChange={() => {}} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text.toLowerCase()).toContain("no workspaces");
    expect(countByRole(mounted.container, "radio")).toBe(0);
  });
});
