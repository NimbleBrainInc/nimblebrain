// ---------------------------------------------------------------------------
// Installing a connector that declares `secretHeaders`.
//
// The ordering is the contract, not a detail. An `auth: "provider"` entry
// eager-starts its source at install, and a start whose header reference
// resolves to nothing fails with CredentialNotFoundError — so collecting the
// value afterwards shows the user a failure and then asks them to fix it. The
// dialog therefore opens BEFORE `install`, every key is written, and only then
// does the install run.
//
// Cancelling installs nothing. That is the honest outcome for a connector that
// could not have worked: no dead row on the Connectors list, nothing to clean up.
//
// Same plumbing as connector-sections.test.tsx: bun:test + react-dom/client +
// happy-dom, no @testing-library/react.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

// One ordered log of every server call the flow makes, so the test can assert
// the sequence rather than each call in isolation — the sequence is the fix.
let calls: string[] = [];

const ENTRY = {
  id: "com.acme/db-query",
  registryId: "bundled-static",
  registryType: "static",
  name: "Acme DB Query",
  description: "Read-only queries against the workspace's own database",
  install: {
    kind: "remote-oauth" as const,
    url: "https://mcp.acme.test/mcp",
    transportType: "streamable-http" as const,
    auth: "provider" as const,
    providerAuth: { provider: "minted", config: {} },
    secretHeaders: { "X-Db-Url": { ref: "credential" as const, key: "acme.db_url" } },
  },
};

const listDirectory = mock(async () => ({ entries: [ENTRY], errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed: [] }));
const setWorkspaceSecret = mock(async (key: string, _value: string) => {
  calls.push(`set_secret:${key}`);
  return { ok: true };
});
const installConnector = mock(async () => {
  calls.push("install");
  return {
    ok: true,
    alreadyInstalled: false,
    serverName: "com-acme-db-query",
    scope: "workspace" as const,
    wsId: "ws_test",
  };
});

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  setWorkspaceSecret,
  installConnector,
}));

// The page is admin-gated; the flow under test is only reachable for an admin.
mock.module("../hooks/useScopedRole", () => ({
  useCanWriteActiveWorkspace: () => true,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");

const { ConnectorBrowsePage } = await import("../pages/settings/ConnectorBrowsePage");

// The real router, not a mock of it: a whole-module `react-router-dom` stub is
// registered process-wide by bun and breaks every other suite that renders one.
// The page reads `slug` from the route and navigates on a completed install, so
// mounting it under the real route is also the more faithful test.
let lastPath = "";

function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/w/acme/settings/connectors/browse"]}>
      <LocationProbe />
      <Routes>
        <Route path="/w/:slug/settings/connectors/browse" element={<ConnectorBrowsePage />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
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
  calls = [];
  setWorkspaceSecret.mockClear();
  installConnector.mockClear();
  lastPath = "";
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

function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ??
    null
  );
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setVal?.call(input, value);
  input.dispatchEvent(new WindowEvent("input", { bubbles: true }));
}

async function openDialog(): Promise<Mounted> {
  const m = await mount(<Page />);
  await act(async () => {
    findButton(m.container, "Install")?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return m;
}

describe("a Browse entry that declares secretHeaders", () => {
  test("says so on the card, before the click", async () => {
    mounted = await mount(<Page />);
    expect(mounted.container.textContent).toContain("Needs a credential");
  });

  test("Install opens the dialog and installs nothing yet", async () => {
    mounted = await openDialog();
    // The derived label — the entry declares none, so it comes from the key.
    expect(document.body.textContent).toContain("Database URL");
    expect(installConnector).not.toHaveBeenCalled();
    expect(setWorkspaceSecret).not.toHaveBeenCalled();
  });

  test("the value is masked and never rendered back into the DOM", async () => {
    mounted = await openDialog();
    const input = document.body.getElementsByTagName("input")[1] as HTMLInputElement;
    expect(input.type).toBe("password");
    await act(async () => {
      setInputValue(input, "postgres://secret.acme.test/db");
    });
    expect(document.body.textContent).not.toContain("postgres://");
  });

  test("submitting writes every key, then installs — in that order", async () => {
    mounted = await openDialog();
    const input = document.body.getElementsByTagName("input")[1] as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "postgres://a.acme.test/db");
    });
    await act(async () => {
      findButton(document.body as unknown as HTMLElement, "Save and install")?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toEqual(["set_secret:acme.db_url", "install"]);
    expect(setWorkspaceSecret.mock.calls[0]).toEqual(["acme.db_url", "postgres://a.acme.test/db"]);
    // provider-auth completes without a sign-in, so the install routes straight
    // to Configure — the credential is already in place when it starts.
    expect(lastPath).toBe("/w/acme/settings/connectors/com-acme-db-query");
  });

  test("cancelling installs nothing and stores nothing", async () => {
    mounted = await openDialog();
    await act(async () => {
      findButton(document.body as unknown as HTMLElement, "Cancel")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([]);
    expect(installConnector).not.toHaveBeenCalled();
    expect(setWorkspaceSecret).not.toHaveBeenCalled();
  });

  test("a blank required value blocks the whole flow, install included", async () => {
    mounted = await openDialog();
    await act(async () => {
      findButton(document.body as unknown as HTMLElement, "Save and install")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("required");
    expect(calls).toEqual([]);
  });
});
