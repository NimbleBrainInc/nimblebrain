// ---------------------------------------------------------------------------
// CardAction — the connector card's action slot.
//
// Installing a connector is a workspace-scoped write: `workspaceInstallAdmission`
// refuses a non-admin with "Workspace admin role required to install connectors."
// The browse route carries no `RouteGuard` and its nav entry is `minRole:
// "ws_member"`, so any member reaches this page. The gate here is what stops
// them clicking into that refusal, and it is the substantive behaviour change
// on this page — so it gets pinned rather than resting on a render read.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import type { DirectoryEntry } from "../api/client";
import { CardAction } from "../pages/settings/ConnectorBrowsePage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom doesn't expose SyntaxError/TypeError on its Window stub; any
// querySelectorAll trips it. Same patch the other component tests carry.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

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
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  return (match as HTMLButtonElement | undefined) ?? null;
}

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: "ai.granola/mcp",
    registryId: "curated",
    registryType: "static",
    name: "Granola",
    description: "Meeting notes",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.granola.ai/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
    ...overrides,
  };
}

function render(canManage: boolean, over: Partial<Parameters<typeof CardAction>[0]> = {}) {
  return mount(
    <CardAction
      entry={entry()}
      busy={false}
      canManage={canManage}
      isStaticAuth={false}
      operatorReady={true}
      onInstall={() => {}}
      onSetUp={() => {}}
      {...over}
    />,
  );
}

describe("CardAction — the install gate", () => {
  test("a member gets no Install button, and is told why", async () => {
    mounted = await render(false);
    expect(findButton(mounted.container, "Install")).toBeNull();
    // Suppressing the button without saying why leaves a card that reads as
    // broken rather than as not-yours.
    expect(mounted.container.textContent).toContain("Workspace admin required");
  });

  test("a workspace admin gets Install", async () => {
    // The negative above is meaningless without its positive — a component
    // that rendered nothing at all would satisfy it.
    mounted = await render(true);
    expect(findButton(mounted.container, "Install")).not.toBeNull();
  });

  test("the gate covers the mpak path too, not just the default one", async () => {
    // One gated return serves every install path; this pins that the mpak
    // path is one of them.
    mounted = await render(false, { entry: entry({ install: { kind: "mpak-bundle" } }) });
    expect(findButton(mounted.container, "Install")).toBeNull();
    expect(mounted.container.textContent).toContain("Workspace admin required");
  });
});

describe("CardAction — static auth awaiting operator setup", () => {
  test("an admin gets Set up", async () => {
    mounted = await render(true, { isStaticAuth: true, operatorReady: false });
    expect(findButton(mounted.container, "Set up")).not.toBeNull();
  });

  test("a member is told the operator blocker, not just that they lack the role", async () => {
    // The blocker here is the missing OAuth app, which no member can supply —
    // naming it is more useful than naming their role.
    mounted = await render(false, { isStaticAuth: true, operatorReady: false });
    expect(findButton(mounted.container, "Set up")).toBeNull();
    expect(mounted.container.textContent).toContain("Operator setup required");
  });
});
