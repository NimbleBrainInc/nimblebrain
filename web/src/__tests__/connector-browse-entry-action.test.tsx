// ---------------------------------------------------------------------------
// EntryAction — Install on a directory entry's page, the one place an install
// starts.
//
// Installing a connector is a workspace-scoped write: `workspaceInstallAdmission`
// refuses a non-admin with "Workspace admin role required to install connectors."
// The browse route carries no `RouteGuard` and its nav entry is `minRole:
// "ws_member"`, so any member reaches this page. The gate here is what stops
// them clicking into that refusal, so it gets pinned rather than resting on a
// render read. Every entry offers the same Install; what differs is only the
// step it opens first, and whether the viewer may use it.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { EntryAction } from "../pages/settings/ConnectorBrowsePage";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");

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
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  const match = Array.from(container.querySelectorAll("button")).find(
    // Exact: "Install" must not match "Installed" or "Install for me".
    (b) => b.textContent?.trim() === text,
  );
  return (match as HTMLButtonElement | undefined) ?? null;
}

function render(canManage: boolean, over: Partial<Parameters<typeof EntryAction>[0]> = {}) {
  return mount(
    <MemoryRouter>
      <EntryAction
        busy={false}
        canManage={canManage}
        isStaticAuth={false}
        oauthClientReady={true}
        onInstall={() => {}}
        onSetUpAndInstall={() => {}}
        {...over}
      />
    </MemoryRouter>,
  );
}

const INSTALLED = { configurePath: "/w/000f7ed6658f9d30/settings/connectors/acme" };

describe("EntryAction — the install gate", () => {
  test("a member sees Install disabled, and is told why", async () => {
    mounted = await render(false);
    expect(findButton(mounted.container, "Install")?.disabled).toBe(true);
    // A disabled button with no reason reads as broken rather than as not-yours.
    expect(mounted.container.textContent).toContain("Workspace admin required");
  });

  test("a workspace admin gets Install", async () => {
    // The negative above is meaningless without its positive.
    mounted = await render(true);
    expect(findButton(mounted.container, "Install")?.disabled).toBe(false);
    expect(mounted.container.textContent).not.toContain("Workspace admin required");
  });

  test("a personal install opens the gate for a member", async () => {
    mounted = await render(false, { personalOffered: true });
    expect(findButton(mounted.container, "Install")?.disabled).toBe(false);
  });

  test("in flight, it says Installing and takes no second click", async () => {
    mounted = await render(true, { busy: true });
    expect(findButton(mounted.container, "Installing…")?.disabled).toBe(true);
  });
});

describe("EntryAction — static auth awaiting OAuth client setup", () => {
  test("an admin's Install sets the client up first, as a step of the install", async () => {
    const onInstall = mock(() => {});
    const onSetUpAndInstall = mock(() => {});
    mounted = await render(true, {
      isStaticAuth: true,
      oauthClientReady: false,
      onInstall,
      onSetUpAndInstall,
    });
    // The same button every entry has, not a different one.
    expect(findButton(mounted.container, "Set up")).toBeNull();
    await act(async () => {
      findButton(mounted!.container, "Install")?.click();
    });
    expect(onSetUpAndInstall).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  test("a member is told the OAuth client blocker, not just that they lack the role", async () => {
    // The blocker here is the missing OAuth client, which no member can supply —
    // naming it is more useful than naming their role.
    mounted = await render(false, { isStaticAuth: true, oauthClientReady: false });
    expect(findButton(mounted.container, "Install")?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain("Needs an OAuth client");
  });
});

describe("EntryAction — an installed entry", () => {
  test("shows a disabled Installed and a link to Configure, not Install", async () => {
    mounted = await render(true, INSTALLED);
    expect(findButton(mounted.container, "Installed")?.disabled).toBe(true);
    const link = mounted.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(INSTALLED.configurePath);
  });

  test("a member sees Installed too — it is a fact, not an action", async () => {
    mounted = await render(false, INSTALLED);
    expect(findButton(mounted.container, "Installed")).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("Workspace admin required");
  });

  test("outranks a pending OAuth client setup", async () => {
    mounted = await render(true, { ...INSTALLED, isStaticAuth: true, oauthClientReady: false });
    expect(findButton(mounted.container, "Installed")).not.toBeNull();
    expect(mounted.container.textContent).not.toContain("Needs an OAuth client");
  });

  test("still offers the viewer's own install beside the workspace's", async () => {
    mounted = await render(true, { ...INSTALLED, personalOffered: true });
    expect(findButton(mounted.container, "Install for me")?.disabled).toBe(false);
  });
});
