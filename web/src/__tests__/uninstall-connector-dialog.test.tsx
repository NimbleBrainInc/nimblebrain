// ---------------------------------------------------------------------------
// UninstallConnectorDialog — what the uninstall takes with it.
//
// Uninstall used to remove the connector and leave its credentials on the
// volume, where nothing referenced them and no surface admitted they existed:
// the rotation section renders only for an INSTALLED connector, so the moment
// the connector was gone its secret was unreachable from the UI entirely. In a
// store that is plaintext-on-disk in v1, that orphan is a live outbound
// capability nobody can see.
//
// So this asserts the three things that make the change a decision rather than
// a new silent policy:
//
//   1. the dialog NAMES the keys it will delete, and never a value
//   2. deletion is unconditional, and the client names no key — the call
//      carries the intent and the server reads the declaration
//   3. a connector that declares nothing gets the same dialog with no secrets
//      section — one code path, not two
//
// Same plumbing as workspace-secrets-section.test.tsx: bun:test +
// react-dom/client + happy-dom, no @testing-library/react.
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

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

let listResult: (() => Promise<{ keys: Array<{ key: string; updatedAt: string }> }>) | null = null;
let uninstallResult:
  | (() => Promise<{
      ok: boolean;
      scope: "workspace";
      serverName: string;
      deletedSecretKeys?: string[];
      secretDeleteError?: string;
    }>)
  | null = null;

const listWorkspaceSecretKeys = mock(async () => {
  if (!listResult) throw new Error("no stub set");
  return listResult();
});
const uninstallConnector = mock(async (_serverName: string, _scope: "workspace") => {
  if (!uninstallResult) throw new Error("no stub set");
  return uninstallResult();
});

mock.module("../api/client", () => ({
  ...realClient,
  listWorkspaceSecretKeys,
  uninstallConnector,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { UninstallConnectorDialog } = await import(
  "../components/connectors/UninstallConnectorDialog"
);

import type { InstalledConnector } from "../api/client";

const DECLARED = { "X-Db-Url": { ref: "credential", key: "acme.db_url" } };
const TWO_DECLARED = {
  "X-Db-Url": { ref: "credential", key: "acme.db_url" },
  "X-Api-Key": { ref: "credential", key: "acme.api_key" },
};

/** An installed connector carrying a catalog entry, shaped by the test's needs. */
function installed(overrides: {
  auth?: string;
  secretHeaders?: Record<string, unknown>;
}): InstalledConnector {
  return {
    serverName: "com-acme-db-query",
    connectorName: "https://mcp.acme.test/mcp",
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    status: "ready",
    catalog: {
      id: "com.acme/db-query",
      name: "Acme DB Query",
      description: "Read-only queries",
      url: "https://mcp.acme.test/mcp",
      auth: overrides.auth ?? "provider",
      ...(overrides.secretHeaders ? { secretHeaders: overrides.secretHeaders } : {}),
    },
  } as unknown as InstalledConnector;
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
let uninstalledWith: Array<string | undefined> = [];

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  listResult = async () => ({ keys: [{ key: "acme.db_url", updatedAt: HOUR_AGO }] });
  uninstallResult = async () => ({
    ok: true,
    scope: "workspace" as const,
    serverName: "com-acme-db-query",
    deletedSecretKeys: ["acme.db_url"],
  });
  uninstalledWith = [];
  listWorkspaceSecretKeys.mockClear();
  uninstallConnector.mockClear();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

/** Mount the dialog already open, the way the Configure page's button leaves it. */
async function open(connector: InstalledConnector): Promise<Mounted> {
  return mount(
    <UninstallConnectorDialog
      installed={connector}
      open
      onOpenChange={() => {}}
      onUninstalled={(warning) => uninstalledWith.push(warning)}
    />,
  );
}

function popup(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function dialogButton(text: string): HTMLButtonElement | null {
  const el = popup();
  if (!el) return null;
  return (
    Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ?? null
  );
}

async function click(el: Element | null): Promise<void> {
  const MouseEventCtor = (globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } })
    .window.MouseEvent;
  await act(async () => {
    el?.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  await flush();
}

describe("UninstallConnectorDialog — what it names", () => {
  test("names the connector and each stored key it will delete", async () => {
    mounted = await open(installed({ secretHeaders: DECLARED }));
    const text = popup()?.textContent ?? "";
    expect(text).toContain("Uninstall Acme DB Query?");
    expect(text).toContain("acme.db_url");
    expect(text).toContain("will be deleted");
  });

  test("a declared key that is not stored is not named — there is nothing to delete", async () => {
    listResult = async () => ({ keys: [{ key: "acme.db_url", updatedAt: HOUR_AGO }] });
    mounted = await open(installed({ secretHeaders: TWO_DECLARED }));
    const text = popup()?.textContent ?? "";
    expect(text).toContain("acme.db_url");
    expect(text).not.toContain("acme.api_key");
  });

  test("when the key list can't be read, every declared key is named and the gap is said", async () => {
    // An empty list would claim every key is unset. Naming them all and
    // admitting the check failed is the honest shape — and deleting an absent
    // key is a no-op either way.
    listResult = async () => {
      throw new Error("permission_denied");
    };
    mounted = await open(installed({ secretHeaders: TWO_DECLARED }));
    const text = popup()?.textContent ?? "";
    expect(text).toContain("acme.db_url");
    expect(text).toContain("acme.api_key");
    expect(text).toContain("Couldn't check which of these are stored");
  });

  test("a connector declaring no secrets gets the same dialog with no secrets section", async () => {
    mounted = await open(installed({}));
    const text = popup()?.textContent ?? "";
    expect(text).toContain("Uninstall Acme DB Query?");
    expect(text).not.toContain("will be deleted");
    expect(dialogButton("Uninstall")).not.toBeNull();
  });

  test("a non-provider connector declaring secretHeaders names nothing", async () => {
    // Only a `provider`-auth install wires the header, so on any other kind the
    // declaration is inert and nothing was ever written against it. Naming a
    // key uninstall does not delete would make the dialog a worse lie than the
    // silence it replaces.
    mounted = await open(installed({ auth: "dcr", secretHeaders: DECLARED }));
    const text = popup()?.textContent ?? "";
    expect(text).not.toContain("acme.db_url");
    expect(text).not.toContain("will be deleted");
  });
});

describe("UninstallConnectorDialog — deciding", () => {
  test("deletion is unconditional — there is no opt-out to offer", async () => {
    // A connector declaring `secretHeaders` cannot be installed without
    // supplying every value, so a reinstall re-collects and overwrites. A
    // keep-them control would preserve a value the next install replaces, and
    // leave behind the orphan this dialog exists to prevent.
    mounted = await open(installed({ secretHeaders: DECLARED }));
    expect(popup()?.querySelector('input[type="checkbox"]')).toBeNull();

    await click(dialogButton("Uninstall"));
    expect(uninstallConnector).toHaveBeenCalledTimes(1);
    expect(uninstallConnector.mock.calls[0]).toEqual(["com-acme-db-query", "workspace"]);
  });

  test("cancelling uninstalls nothing", async () => {
    mounted = await open(installed({ secretHeaders: DECLARED }));
    await click(dialogButton("Cancel"));
    expect(uninstallConnector).not.toHaveBeenCalled();
  });

  test("no value and no key ever leaves the client", async () => {
    // The connector names the key; the value has no path to this dialog at all.
    // `list_secret_keys` returns no value, and the uninstall call carries the
    // intent rather than a key — a client-supplied key would be a delete
    // pointed at any secret in the workspace.
    mounted = await open(installed({ secretHeaders: DECLARED }));
    await click(dialogButton("Uninstall"));
    expect(JSON.stringify(uninstallConnector.mock.calls)).not.toContain("acme.db_url");
  });
});

describe("UninstallConnectorDialog — reporting", () => {
  test("a clean uninstall reports no warning", async () => {
    mounted = await open(installed({ secretHeaders: DECLARED }));
    await click(dialogButton("Uninstall"));
    expect(uninstalledWith).toEqual([undefined]);
  });

  test("a key that outlived the connector is reported, not swallowed", async () => {
    uninstallResult = async () => ({
      ok: true,
      scope: "workspace" as const,
      serverName: "com-acme-db-query",
      deletedSecretKeys: [],
      secretDeleteError: "EACCES",
    });
    mounted = await open(installed({ secretHeaders: DECLARED }));
    await click(dialogButton("Uninstall"));
    expect(uninstalledWith).toHaveLength(1);
    expect(uninstalledWith[0]).toContain("could not be removed");
    expect(uninstalledWith[0]).toContain("EACCES");
  });

  test("a failed uninstall keeps the dialog open with the reason", async () => {
    uninstallResult = async () => {
      throw new Error("connector is busy");
    };
    mounted = await open(installed({ secretHeaders: DECLARED }));
    await click(dialogButton("Uninstall"));
    expect(popup()?.textContent).toContain("connector is busy");
    expect(uninstalledWith).toEqual([]);
  });
});
