// ---------------------------------------------------------------------------
// Browse narrows by category when the catalog states categories, and looks as
// it always did when it does not.
//
// A category is display text on each catalog entry. Browse builds its filter
// from the categories the entries name, so a catalog that names fewer than two
// shows no filter at all.
//
// Same plumbing as connector-browse-installed.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

function entry(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: `${name} tools`,
    install: {
      kind: "remote-oauth" as const,
      url: `https://${id.replace("/", ".")}.test/mcp`,
      transportType: "streamable-http" as const,
      auth: "dcr" as const,
    },
    ...extra,
  };
}

const HUBSPOT = entry("com.hubspot/mcp", "HubSpot", {
  category: "Sales & support",
  tags: ["crm"],
});
const CLOSE = entry("com.close/mcp", "Close", { category: "Sales & support" });
const SENTRY = entry("com.sentry/mcp", "Sentry", { category: "Developer tools" });
const UNCATEGORIZED = entry("com.example/mcp", "Example");

let entries: Array<ReturnType<typeof entry>> = [];

const listDirectory = mock(async () => ({ entries, errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed: [] }));
const listPlugins = mock(async () => ({ wsId: "ws_000f7ed6658f9d30", plugins: [] }));

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  listPlugins,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");

const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { PluginsBrowsePage } = await import("../pages/PluginsBrowsePage");
const { buttonNamed, openEntry } = await import("./directory-entry-helpers");

const WORKSPACE = {
  id: "ws_0076759dbbe19fcc",
  name: "Acme",
  memberCount: 1,
  connectorCount: 0,
  userRole: "admin" as const,
};

function Page() {
  return (
    <WorkspaceProvider initialWorkspaces={[WORKSPACE]} initialActiveId={WORKSPACE.id}>
      <MemoryRouter initialEntries={["/w/000f7ed6658f9d30/plugins/browse"]}>
        <Routes>
          <Route path="/w/:slug/plugins/browse/*" element={<PluginsBrowsePage />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </WorkspaceProvider>
  );
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  entries = [HUBSPOT, CLOSE, SENTRY, UNCATEGORIZED];
});

async function mount(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(<Page />);
  });
  await act(async () => {
    await Promise.resolve();
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

function filter(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="category-filter"]');
}

/** The names of the rows in view. */
function rowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="directory-entry"] a')).map(
    (a) => a.textContent ?? "",
  );
}

/** The filter button whose label starts with `label` (its count follows). */
function chip(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(filter(container)?.querySelectorAll("button") ?? []).find((b) =>
    b.textContent?.startsWith(label),
  );
  if (!button) throw new Error(`no category chip ${label}`);
  return button;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.click();
  });
}

async function search(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("no search box");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

describe("Browse category filter", () => {
  test("offers each category the catalog names, with its count, after All", async () => {
    mounted = await mount();
    const labels = Array.from(filter(mounted.container)?.querySelectorAll("button") ?? []).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["All", "Developer tools1", "Sales & support2"]);
    expect(chip(mounted.container, "All").getAttribute("aria-pressed")).toBe("true");
  });

  test("a category narrows the list to its entries; choosing it again shows all", async () => {
    mounted = await mount();
    await click(chip(mounted.container, "Sales & support"));
    expect(rowNames(mounted.container).sort()).toEqual(["Close", "HubSpot"]);
    expect(chip(mounted.container, "Sales & support").getAttribute("aria-pressed")).toBe("true");

    await click(chip(mounted.container, "Sales & support"));
    expect(rowNames(mounted.container)).toHaveLength(4);
    expect(chip(mounted.container, "All").getAttribute("aria-pressed")).toBe("true");
  });

  test("search matches the category, and applies together with it", async () => {
    mounted = await mount();
    await search(mounted.container, "developer");
    expect(rowNames(mounted.container)).toEqual(["Sentry"]);

    await search(mounted.container, "crm");
    await click(chip(mounted.container, "Developer tools"));
    expect(rowNames(mounted.container)).toEqual([]);
    expect(mounted.container.textContent).toContain('No results for "crm".');
  });

  test("a catalog that names fewer than two categories shows no filter", async () => {
    entries = [UNCATEGORIZED, entry("com.other/mcp", "Other")];
    mounted = await mount();
    expect(filter(mounted.container)).toBeNull();
    expect(rowNames(mounted.container)).toHaveLength(2);

    mounted.unmount();
    entries = [HUBSPOT, CLOSE];
    mounted = await mount();
    expect(filter(mounted.container)).toBeNull();
  });

  test("an entry's page shows its category, and nothing when it has none", async () => {
    mounted = await mount();
    const page = await openEntry(mounted.container, "HubSpot");
    expect(page.querySelector("header")?.textContent).toContain("Sales & support");
    // Tags are search keywords, not shown.
    expect(page.querySelector("header")?.textContent).not.toContain("crm");
    expect(buttonNamed(page, "Install")).not.toBeNull();
  });
});
