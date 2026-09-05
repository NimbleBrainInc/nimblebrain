// ---------------------------------------------------------------------------
// WorkspaceSecretsSection — the rotation surface on the Configure page.
//
// Two things here are easy to get wrong in a way nothing else catches:
//
//   1. `list_secret_keys` is ws-admin gated, so a non-admin member is refused on
//      every render. That refusal is not evidence a key is unset — reading it as
//      one puts "not set" and a "cannot reach its upstream" banner on a working
//      connector, in front of the one reader least able to check the claim.
//
//   2. Only a `provider`-auth install wires the header, so the section must not
//      offer to rotate a value that nothing sends.
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

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

let listResult: (() => Promise<{ keys: Array<{ key: string; updatedAt: string }> }>) | null = null;

const listWorkspaceSecretKeys = mock(async () => {
  if (!listResult) throw new Error("no stub set");
  return listResult();
});
const setWorkspaceSecret = mock(async (_key: string, _value: string) => ({ ok: true }));

mock.module("../api/client", () => ({
  ...realClient,
  listWorkspaceSecretKeys,
  setWorkspaceSecret,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { WorkspaceSecretsSection } = await import(
  "../components/connectors/WorkspaceSecretsSection"
);

import type { InstalledConnector } from "../api/client";

/** An installed connector carrying a catalog entry, shaped by the test's needs. */
function installed(overrides: {
  auth?: string;
  secretHeaders?: Record<string, unknown>;
}): InstalledConnector {
  return {
    serverName: "com-acme-db-query",
    bundleName: "https://mcp.acme.test/mcp",
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

const DECLARED = { "X-Db-Url": { ref: "credential", key: "acme.db_url" } };

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
  listResult = async () => ({ keys: [{ key: "acme.db_url", updatedAt: HOUR_AGO }] });
  listWorkspaceSecretKeys.mockClear();
  setWorkspaceSecret.mockClear();
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

/**
 * The modal's own buttons. Scoped to the dialog because the section behind it
 * has a "Replace credentials" button that `Replace` also matches — and clicking
 * that one silently re-opens the dialog instead of submitting it.
 */
function dialogButton(text: string): HTMLButtonElement | null {
  const dialog = document.body.querySelector('[role="dialog"]');
  return dialog ? findButton(dialog as HTMLElement, text) : null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setVal?.call(input, value);
  input.dispatchEvent(new WindowEvent("input", { bubbles: true }));
}

describe("WorkspaceSecretsSection — what it renders", () => {
  test("a set key reports when it was written and which header carries it", async () => {
    mounted = await mount(
      <WorkspaceSecretsSection installed={installed({ secretHeaders: DECLARED })} canManage />,
    );
    expect(mounted.container.textContent).toContain("Database URL");
    expect(mounted.container.textContent).toContain("set 1h ago");
    expect(mounted.container.textContent).toContain("X-Db-Url");
    // Nothing is missing, so the connector is not accused of being broken.
    expect(mounted.container.textContent).not.toContain("cannot reach its upstream");
    expect(findButton(mounted.container, "Replace credentials")).not.toBeNull();
  });

  test("a key the workspace never set is named, and the connector is flagged", async () => {
    listResult = async () => ({ keys: [] });
    mounted = await mount(
      <WorkspaceSecretsSection installed={installed({ secretHeaders: DECLARED })} canManage />,
    );
    expect(mounted.container.textContent).toContain("not set");
    expect(mounted.container.textContent).toContain("cannot reach its upstream");
    expect(findButton(mounted.container, "Set credentials")).not.toBeNull();
  });

  test("nothing renders for an entry that declares no secret", async () => {
    mounted = await mount(<WorkspaceSecretsSection installed={installed({})} canManage />);
    expect(mounted.container.textContent).toBe("");
    expect(listWorkspaceSecretKeys).not.toHaveBeenCalled();
  });

  // Only the `provider` branch of the install wires a header; on any other auth
  // kind the declaration is inert, so offering to rotate it would be a lie.
  test("nothing renders for a non-provider entry, even one declaring the field", async () => {
    mounted = await mount(
      <WorkspaceSecretsSection
        installed={installed({ auth: "dcr", secretHeaders: DECLARED })}
        canManage
      />,
    );
    expect(mounted.container.textContent).toBe("");
    expect(listWorkspaceSecretKeys).not.toHaveBeenCalled();
  });
});

describe("WorkspaceSecretsSection — when the key list cannot be read", () => {
  // `list_secret_keys` refuses a non-admin by design, so this is what every
  // member sees. It must not become a claim about the connector's health.
  test("a refused read says status unknown, not 'not set'", async () => {
    listResult = async () => {
      throw new Error("Workspace admin role required to list workspace secrets.");
    };
    mounted = await mount(
      <WorkspaceSecretsSection
        installed={installed({ secretHeaders: DECLARED })}
        canManage={false}
      />,
    );
    expect(mounted.container.textContent).toContain("status unknown");
    expect(mounted.container.textContent).not.toContain("not set");
    expect(mounted.container.textContent).not.toContain("cannot reach its upstream");
    expect(mounted.container.textContent).toContain("Only a workspace admin");
    // No affordance a member's next click would be refused for.
    expect(findButton(mounted.container, "credentials")).toBeNull();
  });

  test("an admin's failed read surfaces the reason instead of the role message", async () => {
    listResult = async () => {
      throw new Error("network down");
    };
    mounted = await mount(
      <WorkspaceSecretsSection installed={installed({ secretHeaders: DECLARED })} canManage />,
    );
    expect(mounted.container.textContent).toContain("network down");
    expect(mounted.container.textContent).not.toContain("Only a workspace admin");
    expect(mounted.container.textContent).not.toContain("cannot reach its upstream");
    // Unknown is not missing, so the dialog opens in rotate mode, not collect.
    expect(findButton(mounted.container, "Replace credentials")).not.toBeNull();
  });
});

describe("WorkspaceSecretsSection — rotating", () => {
  test("the dialog writes the key and re-reads, without ever showing a value", async () => {
    mounted = await mount(
      <WorkspaceSecretsSection installed={installed({ secretHeaders: DECLARED })} canManage />,
    );
    await act(async () => {
      findButton(mounted!.container, "Replace credentials")?.click();
    });
    expect(document.body.textContent).toContain("Replace Acme DB Query credentials");

    const input = document.body.getElementsByTagName("input")[0] as HTMLInputElement;
    expect(input.type).toBe("password");
    await act(async () => {
      setInputValue(input, "postgres://rotated.acme.test/db");
    });
    expect(document.body.textContent).not.toContain("postgres://");

    await act(async () => {
      dialogButton("Replace")?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setWorkspaceSecret.mock.calls[0]).toEqual([
      "acme.db_url",
      "postgres://rotated.acme.test/db",
    ]);
    // One read on mount, one after the write.
    expect(listWorkspaceSecretKeys).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("postgres://");
  });

  test("an unset key opens the dialog in collect mode", async () => {
    listResult = async () => ({ keys: [] });
    mounted = await mount(
      <WorkspaceSecretsSection installed={installed({ secretHeaders: DECLARED })} canManage />,
    );
    await act(async () => {
      findButton(mounted!.container, "Set credentials")?.click();
    });
    expect(document.body.textContent).toContain("Connect Acme DB Query");
    expect(dialogButton("Save and install")).not.toBeNull();
  });
});
