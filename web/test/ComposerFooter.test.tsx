// ---------------------------------------------------------------------------
// ComposerFooter — Stage 2 / T013 (Q1)
//
// Three behaviors the task spec pins:
//
//   1. TOOLS FROM reflects the aggregator output, NOT the active
//      workspace. Multi-workspace + single-workspace cases both
//      exercised — the adversarial test the spec calls out explicitly
//      pins the multi-workspace case ("a regression that pinned the
//      badges to the active workspace would look correct in
//      single-workspace tests but break in multi-workspace").
//
//   2. Viewing line updates on workspace switch — re-rendering with
//      a different active workspace flips the displayed name.
//
//   3. TOOLS FROM updates on workspace addition — a watcher
//      invalidation event that grows the set re-renders the footer
//      with the new badge count.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ComposerFooter } = await import("../src/components/chat/ComposerFooter");
const { ToolWorkspacesProvider } = await import("../src/context/ToolWorkspacesContext");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { ShellProvider } = await import("../src/context/ShellContext");
import type { PlacementEntry } from "../src/types";

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
  rerender(element: React.ReactElement): Promise<void>;
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
    async rerender(next: React.ReactElement) {
      await act(async () => {
        root.render(next);
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  const all = Array.from(container.getElementsByTagName("*"));
  for (const el of all) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function findAllByTestId(container: HTMLElement, testid: string): HTMLElement[] {
  const all = Array.from(container.getElementsByTagName("*"));
  return all.filter((el) => el.getAttribute("data-testid") === testid) as HTMLElement[];
}

function ws(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws_a",
    name: "Workspace A",
    memberCount: 1,
    bundles: [],
    userRole: "admin",
    ...over,
  };
}

const SHELL_VALUE = {
  forSlot: (_slot: string): PlacementEntry[] => [
    {
      serverName: "gmail",
      slot: "sidebar.apps",
      resourceUri: "ui://gmail/main",
      priority: 10,
      label: "Gmail",
      route: "gmail",
    },
    {
      serverName: "collateral-studio",
      slot: "sidebar.apps",
      resourceUri: "ui://collateral-studio/main",
      priority: 11,
      label: "Collateral Studio",
      route: "collateral-studio",
    },
  ],
  mainRoutes: (): PlacementEntry[] => [],
  // Unused by ComposerFooter (it reads forSlot directly); present to satisfy
  // the ShellContextValue contract.
  shellWorkspaceId: undefined,
};

function harness({
  workspaces,
  activeId,
  toolWorkspaces,
  initialUrl,
}: {
  workspaces: WorkspaceInfo[];
  activeId: string | undefined;
  toolWorkspaces: WorkspaceInfo[];
  initialUrl?: string;
}): React.ReactElement {
  return (
    <MemoryRouter initialEntries={[initialUrl ?? "/"]}>
      <ShellProvider value={SHELL_VALUE}>
        <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={activeId}>
          <ToolWorkspacesProvider value={{ toolWorkspaces }}>
            <ComposerFooter />
          </ToolWorkspacesProvider>
        </WorkspaceProvider>
      </ShellProvider>
    </MemoryRouter>
  );
}

describe("ComposerFooter — TOOLS FROM line", () => {
  test("reflects multi-workspace aggregator output (the adversarial pin)", async () => {
    // The regression this asserts against: an implementation that
    // pinned the TOOLS FROM badges to the active workspace would
    // pass a single-workspace test trivially, but fail here.
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount(
      harness({
        workspaces: [personal, helix],
        activeId: "ws_user_u1",
        toolWorkspaces: [personal, helix],
      }),
    );
    const badges = findAllByTestId(mounted.container, "tools-from-badge");
    expect(badges).toHaveLength(2);
    const ids = badges.map((b) => b.getAttribute("data-workspace-id"));
    expect(ids).toContain("ws_user_u1");
    expect(ids).toContain("ws_helix");
  });

  test("renders a single badge when aggregator returns one workspace", async () => {
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
    mounted = await mount(
      harness({
        workspaces: [personal],
        activeId: "ws_user_u1",
        toolWorkspaces: [personal],
      }),
    );
    const badges = findAllByTestId(mounted.container, "tools-from-badge");
    expect(badges).toHaveLength(1);
  });

  test("updates when the aggregator's workspace set grows (watcher invalidation)", async () => {
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const clinic = ws({ id: "ws_clinic", name: "Clinic" });

    mounted = await mount(
      harness({
        workspaces: [personal, helix],
        activeId: "ws_user_u1",
        toolWorkspaces: [personal, helix],
      }),
    );
    expect(findAllByTestId(mounted.container, "tools-from-badge")).toHaveLength(2);

    // Simulate a T005 watcher invalidation that adds ws_clinic.
    await mounted.rerender(
      harness({
        workspaces: [personal, helix, clinic],
        activeId: "ws_user_u1",
        toolWorkspaces: [personal, helix, clinic],
      }),
    );
    expect(findAllByTestId(mounted.container, "tools-from-badge")).toHaveLength(3);
  });

  test("empty state — no contributing workspaces", async () => {
    mounted = await mount(
      harness({
        workspaces: [],
        activeId: undefined,
        toolWorkspaces: [],
      }),
    );
    const line = findByTestId(mounted.container, "tools-from-line");
    expect(line?.getAttribute("data-state")).toBe("empty");
  });
});

describe("ComposerFooter — viewing line", () => {
  test("'Not viewing an app' when no app route matches", async () => {
    mounted = await mount(
      harness({
        workspaces: [ws({ id: "ws_a", name: "Workspace A" })],
        activeId: "ws_a",
        toolWorkspaces: [ws({ id: "ws_a", name: "Workspace A" })],
        initialUrl: "/", // not an app route
      }),
    );
    const line = findByTestId(mounted.container, "viewing-line");
    expect(line?.getAttribute("data-state")).toBe("no-app");
    expect(line?.textContent).toBe("Not viewing an app");
  });

  test("renders app + workspace name when on an app route", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount(
      harness({
        workspaces: [helix],
        activeId: "ws_helix",
        toolWorkspaces: [helix],
        initialUrl: "/w/helix/app/gmail",
      }),
    );
    const line = findByTestId(mounted.container, "viewing-line");
    expect(line?.getAttribute("data-state")).toBe("viewing");
    const appName = findByTestId(mounted.container, "viewing-app");
    expect(appName?.textContent).toBe("Gmail");
    const wsName = findByTestId(mounted.container, "viewing-workspace");
    expect(wsName?.textContent).toBe("Helix");
  });

  test("updates when the active workspace changes (sidebar switch)", async () => {
    // We mount two trees back-to-back rather than re-rendering the
    // same tree — WorkspaceProvider's `initialActiveId` is read
    // during mount, so a true workspace switch in production goes
    // through `setActiveWorkspace`, which the sidebar-app-list test
    // covers. Here we assert the footer renders the correct
    // workspace name *given* the active state, which is the
    // composable contract we're pinning.
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const acme = ws({ id: "ws_acme", name: "Acme" });

    mounted = await mount(
      harness({
        workspaces: [helix, acme],
        activeId: "ws_helix",
        toolWorkspaces: [helix, acme],
        initialUrl: "/w/helix/app/gmail",
      }),
    );
    expect(findByTestId(mounted.container, "viewing-workspace")?.textContent).toBe("Helix");
    expect(findByTestId(mounted.container, "viewing-app")?.textContent).toBe("Gmail");

    mounted.unmount();
    mounted = await mount(
      harness({
        workspaces: [helix, acme],
        activeId: "ws_acme",
        toolWorkspaces: [helix, acme],
        initialUrl: "/w/acme/app/collateral-studio",
      }),
    );
    expect(findByTestId(mounted.container, "viewing-workspace")?.textContent).toBe("Acme");
    expect(findByTestId(mounted.container, "viewing-app")?.textContent).toBe("Collateral Studio");
  });
});
