// ---------------------------------------------------------------------------
// ToolPermissionsTable — the read/write split on workspace tool policy.
//
// Tool policy decides what the workspace's agent may call, for every member,
// so `set_permissions` is admin-gated server-side (#748). Reading stays open —
// a member should be able to see what their agent is allowed to do — so this
// table renders for everyone and withholds only the controls.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

mock.module("../api/client", () => ({
  ...realClient,
  listConnectorToolsWithPermissions: async () => ({
    tools: [
      { name: "search", description: "Search things." },
      { name: "write", description: "Write things." },
    ],
    permissions: { search: "allow", write: "disallow" },
  }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ToolPermissionsTable } = await import("../components/connectors/ToolPermissionsTable");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mount(canManage: boolean): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(<ToolPermissionsTable serverName="acme" canManage={canManage} />);
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

function buttonsNamed(container: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement[];
}

function policyButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button[aria-pressed]")) as HTMLButtonElement[];
}

describe("ToolPermissionsTable — a member", () => {
  test("still sees the policy, because reading is not gated", async () => {
    mounted = await mount(false);
    expect(mounted.container.textContent).toContain("search");
    expect(mounted.container.textContent).toContain("write");
    expect(policyButtons(mounted.container).length).toBeGreaterThan(0);
  });

  test("cannot change it — every control is disabled and says why", async () => {
    mounted = await mount(false);
    const controls = policyButtons(mounted.container);
    expect(controls.length).toBe(4); // allow + disallow, two tools
    expect(controls.every((b) => b.disabled)).toBe(true);
    expect(
      controls.every((b) => b.getAttribute("aria-label")?.includes("workspace admin required")),
    ).toBe(true);
  });

  test("gets no bulk actions", async () => {
    mounted = await mount(false);
    expect(buttonsNamed(mounted.container, "Allow all")).toHaveLength(0);
    expect(buttonsNamed(mounted.container, "Disallow all")).toHaveLength(0);
  });

  test("is told who does choose", async () => {
    mounted = await mount(false);
    expect(mounted.container.textContent).toContain("Workspace admins choose");
  });
});

describe("ToolPermissionsTable — a workspace admin", () => {
  // The negatives above are worthless without these: a table that rendered
  // nothing would satisfy every one of them.
  test("gets live controls", async () => {
    mounted = await mount(true);
    const controls = policyButtons(mounted.container);
    expect(controls.length).toBe(4);
    expect(controls.some((b) => b.disabled)).toBe(false);
  });

  test("gets the bulk actions", async () => {
    mounted = await mount(true);
    expect(buttonsNamed(mounted.container, "Allow all")).toHaveLength(1);
    expect(buttonsNamed(mounted.container, "Disallow all")).toHaveLength(1);
  });
});
