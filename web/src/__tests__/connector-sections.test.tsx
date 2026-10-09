// ---------------------------------------------------------------------------
// Connector section components — render contracts.
//
// Pins three things the Configure page relies on:
//
//   1. Each section renders only when its credential lifecycle is
//      relevant to the connector. The page composes all three and
//      relies on `null` returns to skip irrelevant ones — without that
//      a statically-authenticated connector would render an empty OAuth
//      section, and a Granola DCR connector would render an empty
//      operator section.
//
//   2. State→affordance mapping on ConnectorHeader mirrors the
//      ConnectionState union exactly (running → Disconnect, in its menu;
//      reauth_required / crashed / dead → Reconnect; not_authenticated →
//      Connect; pending_auth / starting → no button). A regression here
//      would strand the user with no way to recover a broken connection.
//
//   3. `canManage=false` hides the affordances the server admin-gates —
//      Edit, Disconnect, Clear, Cancel — while member-actionable ones
//      (authorising your *own* account via a native OAuth flow) stay.
//      "Member-actionable" here means the server permits it, not that the
//      flow is per-caller — native OAuth binds the workspace's shared
//      credential under `WORKSPACE_PRINCIPAL_ID`. Hiding too much strands a
//      member who could have acted; showing too much hands them a 403.
//
// Same plumbing as ResourceLinkView.test.tsx: bun:test + react-dom/client
// + happy-dom (via web/test/setup.ts), no @testing-library/react.
// happy-dom's selector parser misbehaves on some testing-library
// outputs; getElementsByTagName + textContent is enough for the
// contracts under test.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type * as ApiClient from "../api/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom builds its selector errors from `window.SyntaxError`, which it
// does not define; the ConfirmDialog behind Disconnect runs selectors that
// reach that path. Same shim as uninstall-connector-dialog.test.tsx.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

// ── api/client mocks ────────────────────────────────────────────────
// Every section calls into one or two helpers from api/client. We
// override those helpers but spread the real-module snapshot (see the
// mock.module call below) so the stub stays complete.

const disconnectConnector = mock(async () => ({
  ok: true,
  scope: "workspace" as const,
  revoked: {},
  deletedLocal: true,
}));
const initiateMcpOAuth = mock<typeof ApiClient.initiateMcpOAuth>(async () => ({
  authorizationUrl: "https://example.test/auth",
}));
const setupConnectorOperator = mock(async () => ({
  ok: true,
  catalogId: "io.asana/mcp",
  clientId: "cid-rotated",
}));
const connectComposioApiKey = mock<typeof ApiClient.connectComposioApiKey>(async () => ({
  connected: true,
  serverName: "com-posthog-analytics",
  status: "ACTIVE",
}));

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only these four are
// overridden. Keeps the process-global mock registry complete even when it
// leaks into another suite loading concurrently.
mock.module("../api/client", () => ({
  ...realClient,
  disconnectConnector,
  initiateMcpOAuth,
  setupConnectorOperator,
  connectComposioApiKey,
}));

// runOAuth leaves the SPA via `window.location.assign`. happy-dom doesn't implement
// navigation, so stub it — lets a test assert that an "already connected" reconnect
// (null URL) does NOT navigate.
const locationAssign = mock((_url: string) => {});
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, assign: locationAssign },
});

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { OperatorOAuthSection } = await import("../components/connectors/OperatorOAuthSection");
const { ComposioApiKeyModal } = await import("../components/connectors/ComposioApiKeyModal");

import type { ComposioField, InstalledConnector } from "../api/client";

// ── Mount helper (mirrors ResourceLinkView.test.tsx) ────────────────

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
  // Let any post-render effects settle.
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

/** Find a button whose visible text starts with `prefix`. */
function findButton(container: HTMLElement, prefix: string): HTMLButtonElement | null {
  const buttons = Array.from(container.getElementsByTagName("button"));
  return buttons.find((b) => (b.textContent ?? "").trim().startsWith(prefix)) ?? null;
}

/** The open ConfirmDialog, which renders in a portal outside the container. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function dialogButton(text: string): HTMLButtonElement | null {
  const el = dialog();
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
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Reset all api/client mock invocations between tests. */
beforeEach(() => {
  disconnectConnector.mockClear();
  initiateMcpOAuth.mockClear();
  setupConnectorOperator.mockClear();
  connectComposioApiKey.mockClear();
});

// ── InstalledConnector fixtures ─────────────────────────────────────
// One factory per connector shape — keeping them at module scope so
// each test's intent reads as "an X connector in Y state" rather
// than 30 lines of object literal.

/**
 * A connector with no catalog match — the shape an entry installed outside the
 * curated catalog takes. Its `url` is absent, so the catalog-gated sections
 * render nothing.
 */
function uncataloguedConnector(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    serverName: "ipinfo",
    connectorName: "https://ipinfo.example.com/mcp",
    displayName: "ipinfo",
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 5,
    ...over,
  };
}

function dcrConnector(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    serverName: "granola",
    connectorName: "granola",
    displayName: "Granola",
    disconnectable: true,
    version: "remote",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 3,
    url: "https://api.granola.test/mcp",
    catalogId: "ai.granola/mcp",
    catalog: {
      id: "ai.granola/mcp",
      name: "Granola",
      description: "Meeting notes",
      iconUrl: "",
      url: "https://api.granola.test/mcp",
      auth: "dcr",
    },
    ...over,
  };
}

/** Composio API-key connector — the one auth path the server admin-gates. */
function composioApiKeyConnector(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    ...dcrConnector(),
    serverName: "posthog",
    connectorName: "posthog",
    displayName: "PostHog",
    catalogId: "com.posthog/analytics",
    catalog: {
      id: "com.posthog/analytics",
      name: "PostHog",
      description: "Analytics",
      iconUrl: "",
      url: "https://mcp.posthog.test/mcp",
      auth: "composio",
      composio: { toolkit: "posthog", authScheme: "API_KEY" },
    },
    ...over,
  };
}

function staticAuthConnector(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    serverName: "asana",
    connectorName: "asana",
    displayName: "Asana",
    disconnectable: true,
    version: "remote",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 8,
    url: "https://app.asana.com/api/mcp",
    catalogId: "io.asana/mcp",
    catalog: {
      id: "io.asana/mcp",
      name: "Asana",
      description: "Work mgmt",
      iconUrl: "",
      url: "https://app.asana.com/api/mcp",
      auth: "static",
      operatorSetup: {
        portalUrl: "https://app.asana.com/0/developer-console",
        hint: "Create OAuth app",
        clientSecretKey: "asana.client_secret",
      },
    },
    operatorOAuth: {
      clientId: "1234567890abcdef",
      configuredAt: new Date(Date.now() - 60_000).toISOString(),
      configuredBy: "usr_admin",
      configuredByLabel: "Sarah",
    },
    ...over,
  };
}

// ── ConnectorHeader: status badge and menu ──────────────────────────
//
// The connection is stated by the badge beside the name, and Disconnect,
// Uninstall and the technical details sit behind the ⋯ menu. The menu's popup
// renders in a portal, so its contents are read from `document.body`.

describe("ConnectorHeader — badge and menu", () => {
  test("names the connector by its resolved display name, never its server name", async () => {
    mounted = await mount(
      <ConnectorHeader
        installed={dcrConnector()}
        canManage={true}
        onChanged={() => {}}
        onUninstall={() => {}}
      />,
    );
    const title = mounted.container.getElementsByTagName("h1")[0]?.textContent;
    expect(title).toBe("Granola");
  });

  test("states the connection on the badge, with the account when one is known", async () => {
    mounted = await mount(
      <ConnectorHeader
        installed={dcrConnector({ state: "running", identity: { email: "you@example.com" } })}
        canManage={true}
        onChanged={() => {}}
        onUninstall={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Connected as you@example.com");
    // No Disconnect on the page itself; it is in the menu.
    expect(findButton(mounted.container, "Disconnect")).toBeNull();
  });

  test("offers an admin Disconnect, Uninstall and the details, in that order", () => {
    const kinds = connectorMenuItems(
      dcrConnector({ state: "running", handshakeVersion: "4.0.10" }),
      true,
    ).map((i) => i.kind);
    expect(kinds).toEqual(["disconnect", "uninstall", "details"]);
  });

  test("offers a member only the documentation and the details", () => {
    const withDocs = dcrConnector({ state: "running" });
    withDocs.catalog = { ...withDocs.catalog!, docsUrl: "https://docs.granola.test" };
    expect(connectorMenuItems(withDocs, false)).toEqual([
      { kind: "docs", href: "https://docs.granola.test" },
      { kind: "details", text: "3 tools" },
    ]);
  });

  test("offers Disconnect only for an established connection a person signed in to", () => {
    const kinds = (c: InstalledConnector) => connectorMenuItems(c, true).map((i) => i.kind);
    expect(kinds(uncataloguedConnector())).not.toContain("disconnect");
    expect(kinds(dcrConnector({ state: "reauth_required" }))).not.toContain("disconnect");
    // A fleet connector: running, remote, and its token is minted by the platform, so
    // there is no sign-in to revoke.
    expect(kinds(dcrConnector({ state: "running", disconnectable: false }))).not.toContain(
      "disconnect",
    );
  });
});

describe("connectorDetails", () => {
  test("joins version, tool count and interface, and drops what it lacks", () => {
    expect(connectorDetails(dcrConnector({ handshakeVersion: "4.0.10", interactive: true }))).toBe(
      "v4.0.10 · 3 tools · Interactive",
    );
    expect(connectorDetails(dcrConnector({ toolCount: 1 }))).toBe("1 tool");
    expect(connectorDetails(uncataloguedConnector({ handshakeVersion: "2.0.0" }))).toBe(
      "v2.0.0 · catalog v1.0.0 · 5 tools",
    );
  });
});

describe("DisconnectDialog", () => {
  test("Disconnect asks first, saying what stays and that Uninstall removes it", async () => {
    mounted = await mount(
      <DisconnectDialog
        installed={dcrConnector({ state: "running" })}
        open={true}
        onOpenChange={() => {}}
        onDisconnected={() => {}}
      />,
    );
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("for everyone in this workspace");
    expect(text).toContain("stays installed, with its tool permissions");
    expect(text).toContain("Uninstall");
    expect(disconnectConnector).not.toHaveBeenCalled();
  });

  test("confirming Disconnect disconnects and refreshes", async () => {
    const onChanged = mock(() => {});
    mounted = await mount(
      <DisconnectDialog
        installed={dcrConnector({ state: "running" })}
        open={true}
        onOpenChange={() => {}}
        onDisconnected={onChanged}
      />,
    );
    await click(dialogButton("Disconnect"));
    expect(disconnectConnector).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("cancelling Disconnect leaves the connection alone", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    mounted = await mount(
      <DisconnectDialog
        installed={dcrConnector({ state: "running" })}
        open={true}
        onOpenChange={onOpenChange}
        onDisconnected={() => {}}
      />,
    );
    await click(dialogButton("Cancel"));
    expect(disconnectConnector).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  test("a failed Disconnect stays in the dialog with the error", async () => {
    disconnectConnector.mockImplementationOnce(async () => {
      throw new Error("Workspace admin role required");
    });
    mounted = await mount(
      <DisconnectDialog
        installed={dcrConnector({ state: "running" })}
        open={true}
        onOpenChange={() => {}}
        onDisconnected={() => {}}
      />,
    );
    await click(dialogButton("Disconnect"));
    expect(dialog()?.textContent).toContain("Workspace admin role required");
  });
});

// ── OperatorOAuthSection ────────────────────────────────────────────

describe("OperatorOAuthSection", () => {
  test("renders nothing for a connector with no catalog match", async () => {
    mounted = await mount(
      <OperatorOAuthSection
        installed={uncataloguedConnector()}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toBe("");
  });

  test("renders nothing for DCR connectors (auth: 'dcr', not 'static')", async () => {
    mounted = await mount(
      <OperatorOAuthSection installed={dcrConnector()} canManage={true} onChanged={() => {}} />,
    );
    expect(mounted.container.textContent).toBe("");
  });

  test("renders nothing for static-auth connector with no operatorOAuth populated", async () => {
    // Static-auth catalog match but workspace hasn't configured the
    // OAuth app yet. Browse handles first-time setup; Configure stays
    // empty until the install path runs.
    mounted = await mount(
      <OperatorOAuthSection
        installed={staticAuthConnector({ operatorOAuth: undefined })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toBe("");
  });

  test("renders audit info + truncated clientId for configured static-auth", async () => {
    mounted = await mount(
      <OperatorOAuthSection
        installed={staticAuthConnector()}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Configured");
    expect(mounted.container.textContent).toContain("Sarah");
    // Truncated clientId — 1234567890abcdef → 123456…abcdef
    expect(mounted.container.textContent).toContain("123456");
    expect(mounted.container.textContent).toContain("abcdef");
    expect(findButton(mounted.container, "Edit")).not.toBeNull();
  });

  test("canManage=false hides Edit affordance but keeps audit visible", async () => {
    mounted = await mount(
      <OperatorOAuthSection
        installed={staticAuthConnector()}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Configured");
    expect(findButton(mounted.container, "Edit")).toBeNull();
  });
});

// ConnectorConfigSection was deleted in the header-action redesign.
// Connector credentials are now triggered from a top-right Configure
// affordances on ConnectorDetailPage
// directly. The modal owns its own Clear-configuration affordance,
// so the inline section had no remaining job.

// ── ConnectorHeader: banner and primary action ─────────────────────────────────────────────
//
// New component. Owns the page's primary CTA — the dispatcher between
// status and the right next-action affordance. Status pill colors,
// copy, and admin gating are pinned here so future regressions can't
// strand a user with no recovery path.

const { ConnectorHeader, DisconnectDialog, connectorDetails, connectorMenuItems } = await import(
  "../components/connectors/ConnectorHeader"
);

describe("ConnectorHeader — banner and primary action", () => {
  test("status=ready → no status block + no CTA (page reads quiet)", async () => {
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ state: "running", status: "ready" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    // Title still present; status block hidden.
    expect(mounted.container.textContent).toContain("Granola");
    expect(mounted.container.textContent).not.toContain("Configuration required");
    expect(mounted.container.textContent).not.toContain("Reconnection needed");
    // No status-block buttons (uninstall etc. live elsewhere).
    expect(findButton(mounted.container, "Configure")).toBeNull();
    expect(findButton(mounted.container, "Connect")).toBeNull();
  });

  test("status=needs_setup + missingOperatorSetup → 'Set up OAuth' (admin)", async () => {
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={staticAuthConnector({
          status: "needs_setup",
          missingOperatorSetup: true,
          operatorOAuth: undefined,
          statusReason: "OAuth app not configured for this workspace.",
        })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Configuration required");
    expect(findButton(mounted.container, "Set up OAuth")).not.toBeNull();
  });

  test("status=not_connected → neutral 'Not connected' + 'Connect', no Reconnect", async () => {
    // Disconnect leaves the connector here on purpose. It must read as a
    // connector at rest, not as a broken connection to fix.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "not_connected", state: "not_authenticated" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Not connected");
    expect(mounted.container.querySelector(".bg-amber-500")).toBeNull();
    expect(findButton(mounted.container, "Connect")).not.toBeNull();
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
  });

  test("status=needs_auth → amber 'Reconnection needed' + 'Reconnect'", async () => {
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "needs_auth", state: "reauth_required" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Reconnection needed");
    expect(mounted.container.querySelector(".bg-amber-500")).not.toBeNull();
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  // ── version, in the menu's details ──────────────────────────────
  // A fleet connector reports a v-prefixed handshake version (image tags carry the
  // "v") and may declare none ("unknown"); an edge build reports its SHA. Exactly
  // one "v" on a version number, none on a SHA, and a catalog note only on real drift.
  test("version: one 'v' on a version number, none on a SHA, a note only on real drift", () => {
    const d = (over: Partial<InstalledConnector>) =>
      connectorDetails(uncataloguedConnector({ toolCount: 0, ...over }));
    expect(d({ handshakeVersion: "v0.1.0", version: "unknown" })).toBe("v0.1.0");
    expect(d({ handshakeVersion: "cd0ab7f", version: "remote" })).toBe("cd0ab7f");
    expect(d({ version: "1.0.0" })).toBe("v1.0.0");
    expect(d({ handshakeVersion: "v0.2.0", version: "0.1.0" })).toBe("v0.2.0 · catalog v0.1.0");
    expect(d({ handshakeVersion: "v0.1.0", version: "0.1.0" })).toBe("v0.1.0");
  });

  test("status=needs_auth + state=reauth_required → 'Reconnect'", async () => {
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "needs_auth", state: "reauth_required" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
    expect(findButton(mounted.container, "Connect")).toBeNull();
  });

  test("status=connecting / starting on remote → 'Cancel' CTA (escape a wedged OAuth)", async () => {
    for (const status of ["connecting", "starting"] as const) {
      mounted?.unmount();
      mounted = await mount(
        <ConnectorHeader
          onUninstall={() => {}}
          installed={dcrConnector({ status, state: status })}
          canManage={true}
          onChanged={() => {}}
        />,
      );
      // Status block present with the in-flight label, plus a Cancel
      // button so a stuck connect isn't a dead end (regression: this used
      // to render no CTA, leaving "Connecting…" on screen forever).
      expect(findButton(mounted.container, "Cancel")).not.toBeNull();
    }
  });

  test("Cancel on a wedged connect calls disconnectConnector + onChanged", async () => {
    const onChanged = mock(() => {});
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "connecting", state: "pending_auth" })}
        canManage={true}
        onChanged={onChanged}
      />,
    );
    const cancel = findButton(mounted.container, "Cancel");
    expect(cancel).not.toBeNull();
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });
    expect(disconnectConnector).toHaveBeenCalledWith("granola", "workspace");
    expect(onChanged).toHaveBeenCalled();
  });

  test("status=failed on remote connector → 'Reconnect' + statusReason", async () => {
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({
          status: "failed",
          state: "crashed",
          statusReason: "token revoked upstream",
        })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Failed");
    expect(mounted.container.textContent).toContain("token revoked upstream");
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("Reconnect on an already-connected source refreshes in place — no navigation (#679)", async () => {
    const onChanged = mock(() => {});
    // The source reconnected without an interactive flow — startAuth returned no URL.
    initiateMcpOAuth.mockResolvedValueOnce({ authorizationUrl: null });
    locationAssign.mockClear();
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "failed", state: "crashed" })}
        canManage={true}
        onChanged={onChanged}
      />,
    );
    const reconnect = findButton(mounted.container, "Reconnect");
    expect(reconnect).not.toBeNull();
    await act(async () => {
      reconnect?.click();
      await Promise.resolve();
    });
    // Refreshed state in place; did NOT redirect to a nonexistent auth page.
    expect(onChanged).toHaveBeenCalled();
    expect(locationAssign).not.toHaveBeenCalled();
  });

  test("admin-gated CTAs hidden when canManage=false; member-actionable kept", async () => {
    // Set up OAuth (admin) → hidden for non-admins.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={staticAuthConnector({
          status: "needs_setup",
          missingOperatorSetup: true,
          operatorOAuth: undefined,
          statusReason: "OAuth app not configured for this workspace.",
        })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Set up OAuth")).toBeNull();
    mounted.unmount();

    // Connect (member-actionable) → still visible for non-admins:
    // a workspace member can authenticate their own session.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "not_connected", state: "not_authenticated" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Connect")).not.toBeNull();
  });

  test("Cancel is hidden when canManage=false — disconnect is admin-gated server-side", async () => {
    // Cancel calls `disconnectConnector`, and `handleDisconnect` refuses a
    // non-admin outright. Offering it left a member clicking into a red
    // "Workspace admin role required" with the connector still wedged.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "connecting", state: "pending_auth" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Cancel")).toBeNull();
    // Suppressing the CTA without saying why leaves a pulsing dot and no
    // explanation — the regression that copy exists to prevent, so it gets
    // pinned rather than resting on the button assertion above.
    expect(mounted.container.textContent).toContain("Workspace admin required");
    mounted.unmount();

    // ...and present for someone who can actually complete it.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={dcrConnector({ status: "connecting", state: "pending_auth" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Cancel")).not.toBeNull();
  });

  test("a member blocked on operator setup is told that, not just that they lack the role", async () => {
    // The hero half of a must-match pair: ConnectorBrowsePage says "Operator
    // setup required" for this same user in this same state, and that string
    // is pinned in connector-browse-card-action.test.tsx. Pinning one side
    // doesn't pin the pair — this is the other side.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={staticAuthConnector({
          status: "needs_setup",
          missingOperatorSetup: true,
          operatorOAuth: undefined,
          statusReason: "OAuth app not configured for this workspace.",
        })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Set up OAuth")).toBeNull();
    expect(mounted.container.textContent).toContain("Operator setup required");
    // ...and not the generic wording, which is what the ternary exists to avoid.
    expect(mounted.container.textContent).not.toContain("Workspace admin required");
  });

  test("composio API-key Reconnect is hidden from a member — rotation is admin-gated", async () => {
    // `handleConnectApiKey` refuses a non-admin once a connected account
    // exists, which is exactly reauth_required/failed. Offering Reconnect
    // there walks a member through the key form to a refusal on submit.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({ status: "needs_auth", state: "reauth_required" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
    mounted.unmount();

    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({ status: "needs_auth", state: "reauth_required" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("a composio OAUTH2 connector stays open to a member — the server grants it", async () => {
    // `authScheme` is optional and defaults to OAUTH2, so the ordinary composio
    // connector has none and takes /v1/workspaces/:wsId/composio-auth/initiate — requireAuth +
    // requireWorkspace, no admin check (#755). Gating it here would hide
    // Reconnect while the server still grants it, which is the client/server
    // divergence #741 exists to remove. This pins the API_KEY discriminator:
    // without it, every composio connector would be gated.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({
          status: "needs_auth",
          state: "reauth_required",
          catalog: {
            id: "com.posthog/analytics",
            name: "PostHog",
            description: "Analytics",
            iconUrl: "",
            url: "https://mcp.posthog.test/mcp",
            auth: "composio",
            composio: { toolkit: "posthog" },
          },
        })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("a composio API-key connector in `failed` is gated too, not just reauth_required", async () => {
    // `failed` is the other arm of the rotation predicate — a remote connector
    // that died still offers Reconnect, and for an API-key connector that is
    // the same admin-gated rotation.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({ status: "failed", state: "crashed" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
    mounted.unmount();

    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({ status: "failed", state: "crashed" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("composio API-key first Connect stays open to a member — no account to rotate yet", async () => {
    // The server only refuses once `prior.connectedAccountId` exists, so the
    // gate must not swallow the first-time case.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({ status: "not_connected", state: "not_authenticated" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Connect")).not.toBeNull();
  });

  test("a connector with no catalog entry falls back to the ungated native path", async () => {
    // `catalog` is optional on InstalledConnector. Without it the composio
    // predicate can't fire, so this degrades to the same ungated behaviour a
    // native flow has — documented, and it resolves when that gap does.
    mounted = await mount(
      <ConnectorHeader
        onUninstall={() => {}}
        installed={composioApiKeyConnector({
          status: "needs_auth",
          state: "reauth_required",
          catalog: undefined,
        })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });
});

// ── ComposioApiKeyModal — API-key connect form ──────────────────────

const POSTHOG_FIELDS: ComposioField[] = [
  { key: "generic_api_key", title: "Personal API Key", sensitive: true, required: true },
  { key: "subdomain", title: "Region", required: true },
];

function setInputValue(input: HTMLInputElement, value: string): void {
  const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setVal?.call(input, value);
  input.dispatchEvent(new WindowEvent("input", { bubbles: true }));
}

describe("ComposioApiKeyModal", () => {
  test("renders the declared fields; sensitive field is a password input", async () => {
    mounted = await mount(
      <ComposioApiKeyModal
        catalogId="com.posthog/analytics"
        connectorName="PostHog"
        fields={POSTHOG_FIELDS}
        open={true}
        onClose={() => {}}
        onConnected={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Connect PostHog");
    expect(mounted.container.textContent).toContain("Personal API Key");
    expect(mounted.container.textContent).toContain("Region");
    const inputs = Array.from(mounted.container.getElementsByTagName("input"));
    expect(inputs.length).toBe(2);
    expect(inputs[0]?.type).toBe("password"); // generic_api_key (sensitive)
    expect(inputs[1]?.type).toBe("text"); // subdomain
  });

  test("a missing required field leaves Connect disabled (no connect call)", async () => {
    mounted = await mount(
      <ComposioApiKeyModal
        catalogId="com.posthog/analytics"
        connectorName="PostHog"
        fields={POSTHOG_FIELDS}
        open={true}
        onClose={() => {}}
        onConnected={() => {}}
      />,
    );
    const connect = findButton(mounted.container, "Connect");
    expect(connect?.disabled).toBe(true);
    await act(async () => {
      connect?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectComposioApiKey).not.toHaveBeenCalled();
  });

  test("filled fields submit → connectComposioApiKey(catalogId, values) + onConnected", async () => {
    const onConnected = mock(() => {});
    mounted = await mount(
      <ComposioApiKeyModal
        catalogId="com.posthog/analytics"
        connectorName="PostHog"
        fields={POSTHOG_FIELDS}
        open={true}
        onClose={() => {}}
        onConnected={onConnected}
      />,
    );
    const inputs = Array.from(mounted.container.getElementsByTagName("input"));
    await act(async () => {
      setInputValue(inputs[0]!, "phx_secret");
      setInputValue(inputs[1]!, "us");
    });
    await act(async () => {
      findButton(mounted!.container, "Connect")?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(connectComposioApiKey).toHaveBeenCalledTimes(1);
    expect(connectComposioApiKey.mock.calls[0]).toEqual([
      "com.posthog/analytics",
      { generic_api_key: "phx_secret", subdomain: "us" },
    ]);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
