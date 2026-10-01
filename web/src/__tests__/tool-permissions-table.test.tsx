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

const TOOLS = [
  { name: "search", description: "Search things." },
  { name: "write", description: "Write things." },
];
let listedTools = TOOLS;
const listCalls: Array<[string, string | undefined]> = [];
const setCalls: Array<[string, string, Record<string, string>]> = [];

mock.module("../api/client", () => ({
  ...realClient,
  listConnectorToolsWithPermissions: async (serverName: string, scope?: string) => {
    listCalls.push([serverName, scope]);
    return { tools: listedTools, permissions: { search: "allow", write: "disallow" } };
  },
  setConnectorPermissions: async (
    serverName: string,
    scope: string,
    tools: Record<string, string>,
  ) => {
    setCalls.push([serverName, scope, tools]);
    return { ok: true, scope: scope === "identity" ? "user" : "workspace", serverName };
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ToolPermissionsTable, permissionSummary } = await import(
  "../components/connectors/ToolPermissionsTable"
);

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  listedTools = TOOLS;
  listCalls.length = 0;
  setCalls.length = 0;
});

/** Mounted as each page mounts it: a workspace install collapsible, and opened
 *  unless `open` is false; a personal connector's list shown as it is. */
async function mount(
  canManage: boolean,
  { scope = "workspace", open = true }: { scope?: "workspace" | "identity"; open?: boolean } = {},
): Promise<Mounted> {
  const collapsible = scope === "workspace";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <ToolPermissionsTable
        serverName="acme"
        scope={scope}
        canManage={canManage}
        collapsible={collapsible}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  if (collapsible && open) {
    await act(async () => {
      buttonsNamed(container, "Show tools")[0]?.click();
    });
  }
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

describe("ToolPermissionsTable — collapsed until asked", () => {
  // A connector can expose dozens of tools; listed in full they bury the rest of the page.
  test("starts as one summary line, with no rows and no bulk actions", async () => {
    mounted = await mount(true, { open: false });
    expect(mounted.container.textContent).toContain("2 tools · 1 disallowed");
    expect(policyButtons(mounted.container)).toHaveLength(0);
    expect(buttonsNamed(mounted.container, "Allow all")).toHaveLength(0);
    expect(buttonsNamed(mounted.container, "Show tools")).toHaveLength(1);
    expect(buttonsNamed(mounted.container, "Show tools")[0]?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  test("opens to the full list, and closes again", async () => {
    mounted = await mount(true, { open: false });
    await act(async () => {
      buttonsNamed(mounted!.container, "Show tools")[0]?.click();
    });
    expect(policyButtons(mounted.container)).toHaveLength(4);
    const toggle = buttonsNamed(mounted.container, "Hide tools")[0];
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(
      mounted.container.querySelector(
        `#${CSS.escape(toggle?.getAttribute("aria-controls") ?? "")}`,
      ),
    ).toBeTruthy();
    await act(async () => {
      buttonsNamed(mounted!.container, "Hide tools")[0]?.click();
    });
    expect(policyButtons(mounted.container)).toHaveLength(0);
  });
});

describe("permissionSummary", () => {
  test("says how many tools and how many the agent may not call", () => {
    expect(permissionSummary(27, 0)).toBe("27 tools · all allowed");
    expect(permissionSummary(27, 3)).toBe("27 tools · 3 disallowed");
    expect(permissionSummary(1, 1)).toBe("1 tool · none allowed");
  });
});

describe("ToolPermissionsTable — a personal connector", () => {
  // Its panel is already the disclosure: opening it shows the list, with no second toggle.
  test("shows the list as it is, with no Show tools toggle", async () => {
    mounted = await mount(true, { scope: "identity" });
    expect(policyButtons(mounted.container)).toHaveLength(4);
    expect(buttonsNamed(mounted.container, "Show tools")).toHaveLength(0);
  });

  test("reads and writes the viewer's own policy", async () => {
    mounted = await mount(true, { scope: "identity" });
    expect(listCalls).toEqual([["acme", "identity"]]);
    const allowAll = buttonsNamed(mounted.container, "Allow all")[0];
    await act(async () => {
      allowAll?.click();
    });
    expect(setCalls).toEqual([["acme", "identity", { search: "allow", write: "allow" }]]);
  });

  test("says why the section is empty when no tools could be listed", async () => {
    listedTools = [];
    mounted = await mount(true, { scope: "identity" });
    expect(mounted.container.textContent).toContain("No tools to show right now");
  });
});
