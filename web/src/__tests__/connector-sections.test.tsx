// ---------------------------------------------------------------------------
// Connector section components — render contracts.
//
// Pins three things this PR makes load-bearing for the Configure page:
//
//   1. Each section renders only when its credential lifecycle is
//      relevant to the connector. The page composes all three and
//      relies on `null` returns to skip irrelevant ones — without that
//      a stdio bundle would render an empty OAuth section, and a
//      Granola DCR connector would render an empty operator section.
//
//   2. State→affordance mapping on OAuthConnectionSection mirrors the
//      BundleState union exactly (running → Disconnect; reauth_required
//      / crashed / dead → Reconnect; not_authenticated → Connect;
//      pending_auth / starting → no button). A regression here would
//      strand the user with no way to recover a broken connection.
//
//   3. `canManage=false` hides every mutation affordance. Non-admin
//      members see status text only — no Edit, Disconnect, Connect, or
//      Clear buttons.
//
// Same plumbing as ResourceLinkView.test.tsx: bun:test + react-dom/client
// + happy-dom (via web/test/setup.ts), no @testing-library/react.
// happy-dom's selector parser misbehaves on some testing-library
// outputs; getElementsByTagName + textContent is enough for the
// contracts under test.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const initiateMcpOAuth = mock(async () => ({ authorizationUrl: "https://example.test/auth" }));
const clearBundleUserConfig = mock(async () => ({
  ok: true,
  serverName: "stub",
  populated: {},
  respawn: { ok: true },
}));
const setBundleUserConfig = mock(async () => ({
  ok: true,
  serverName: "stub",
  populated: { api_key: true },
  respawn: { ok: true },
}));
const setupConnectorOperator = mock(async () => ({
  ok: true,
  catalogId: "io.asana/mcp",
  clientId: "cid-rotated",
}));

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only these five are
// overridden. Keeps the process-global mock registry complete even when it
// leaks into another suite loading concurrently.
mock.module("../api/client", () => ({
  ...realClient,
  disconnectConnector,
  initiateMcpOAuth,
  clearBundleUserConfig,
  setBundleUserConfig,
  setupConnectorOperator,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { OAuthConnectionSection } = await import("../components/connectors/OAuthConnectionSection");
const { OperatorOAuthSection } = await import("../components/connectors/OperatorOAuthSection");

import type { InstalledConnector } from "../api/client";

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

/** Reset all api/client mock invocations between tests. */
beforeEach(() => {
  disconnectConnector.mockClear();
  initiateMcpOAuth.mockClear();
  clearBundleUserConfig.mockClear();
  setBundleUserConfig.mockClear();
  setupConnectorOperator.mockClear();
});

// ── InstalledConnector fixtures ─────────────────────────────────────
// One factory per connector shape — keeping them at module scope so
// each test's intent reads as "an X connector in Y state" rather
// than 30 lines of object literal.

function stdioBundle(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    serverName: "ipinfo",
    bundleName: "@nimblebraininc/ipinfo",
    version: "1.0.0",
    type: "local",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 5,
    trustScore: null,
    userConfig: {
      schema: {
        api_key: { type: "string", title: "API Key", sensitive: true, required: true },
      },
      populated: { api_key: false },
    },
    ...over,
  };
}

function dcrConnector(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    serverName: "granola",
    bundleName: "granola",
    version: "remote",
    type: "remote",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 3,
    trustScore: null,
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

function staticAuthConnector(over: Partial<InstalledConnector> = {}): InstalledConnector {
  return {
    serverName: "asana",
    bundleName: "asana",
    version: "remote",
    type: "remote",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 8,
    trustScore: null,
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

// ── OAuthConnectionSection ──────────────────────────────────────────
//
// Refactored: this section is now ONLY the connection-details surface
// for an established connection. The hero (ConnectorStatusHero) owns
// every primary CTA (Connect / Reconnect / Configure / Set up). The
// section renders only on the happy path: running + remote-OAuth.
// Non-running states are handled by the hero with the right copy +
// CTA, so duplicating them here would double-count the message.

describe("OAuthConnectionSection", () => {
  test("renders nothing for stdio (non-remote) bundles", async () => {
    mounted = await mount(
      <OAuthConnectionSection installed={stdioBundle()} canManage={true} onChanged={() => {}} />,
    );
    expect(mounted.container.textContent).toBe("");
  });

  test("renders nothing for non-running states — hero owns those", async () => {
    // The hero handles needs_auth (Connect), needs_auth+reauth_required
    // (Reconnect), failed (Reconnect), and connecting (waiting state).
    // Surfacing them here too would double-count.
    for (const state of [
      "not_authenticated",
      "reauth_required",
      "crashed",
      "dead",
      "pending_auth",
      "starting",
      "stopped",
    ] as const) {
      mounted?.unmount();
      mounted = await mount(
        <OAuthConnectionSection
          installed={dcrConnector({ state })}
          canManage={true}
          onChanged={() => {}}
        />,
      );
      expect(mounted.container.textContent).toBe("");
    }
  });

  test("running + identity.email → 'Connected as ...' + Disconnect (admin)", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "running", identity: { email: "you@example.com" } })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Connected as");
    expect(mounted.container.textContent).toContain("you@example.com");
    expect(findButton(mounted.container, "Disconnect")).not.toBeNull();
  });

  test("running without identity → 'Connected' (no name) + Disconnect", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "running" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Connected");
    expect(findButton(mounted.container, "Disconnect")).not.toBeNull();
  });

  test("running + canManage=false hides Disconnect but keeps the connection label", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "running", identity: { email: "you@example.com" } })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Connected as");
    expect(findButton(mounted.container, "Disconnect")).toBeNull();
  });
});

// ── OperatorOAuthSection ────────────────────────────────────────────

describe("OperatorOAuthSection", () => {
  test("renders nothing for stdio bundles (no catalog match)", async () => {
    mounted = await mount(
      <OperatorOAuthSection installed={stdioBundle()} canManage={true} onChanged={() => {}} />,
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

// BundleConfigSection was deleted in the header-action redesign.
// Bundle credentials are now triggered from a top-right Configure
// button on ConnectorDetailPage that opens BundleCredentialsModal
// directly. The modal owns its own Clear-configuration affordance,
// so the inline section had no remaining job.

// ── ConnectorStatusHero ─────────────────────────────────────────────
//
// New component. Owns the page's primary CTA — the dispatcher between
// status and the right next-action affordance. Status pill colors,
// copy, and admin gating are pinned here so future regressions can't
// strand a user with no recovery path.

const { ConnectorStatusHero } = await import("../components/connectors/ConnectorStatusHero");

describe("ConnectorStatusHero", () => {
  test("status=ready → no status block + no CTA (page reads quiet)", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={dcrConnector({ state: "running", status: "ready" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    // Title still present; status block hidden.
    expect(mounted.container.textContent).toContain("Granola");
    expect(mounted.container.textContent).not.toContain("Configuration required");
    expect(mounted.container.textContent).not.toContain("Sign-in required");
    // No status-block buttons (uninstall etc. live elsewhere).
    expect(findButton(mounted.container, "Configure")).toBeNull();
    expect(findButton(mounted.container, "Connect")).toBeNull();
  });

  test("status=needs_setup on stdio → 'Configure' CTA (admin)", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={stdioBundle({
          status: "needs_setup",
          statusReason: "Missing required configuration: API Key.",
        })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Configuration required");
    expect(mounted.container.textContent).toContain("API Key");
    expect(findButton(mounted.container, "Configure")).not.toBeNull();
  });

  test("status=needs_setup + missingOperatorSetup → 'Set up OAuth' (admin)", async () => {
    mounted = await mount(
      <ConnectorStatusHero
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

  test("status=needs_auth + state=not_authenticated → 'Connect'", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={dcrConnector({ status: "needs_auth", state: "not_authenticated" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Sign-in required");
    expect(findButton(mounted.container, "Connect")).not.toBeNull();
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
  });

  test("status=needs_auth + state=reauth_required → 'Reconnect'", async () => {
    mounted = await mount(
      <ConnectorStatusHero
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
        <ConnectorStatusHero
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
      <ConnectorStatusHero
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

  test("status=starting on a stdio bundle → status visible, no CTA (no OAuth to cancel)", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={stdioBundle({ status: "starting", state: "starting" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.getElementsByTagName("button").length).toBe(0);
  });

  test("status=failed on remote bundle → 'Reconnect' + statusReason", async () => {
    mounted = await mount(
      <ConnectorStatusHero
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

  test("status=failed on stdio bundle → status visible, no one-click CTA", async () => {
    // No automated recovery path for a crashed local bundle. The
    // statusReason explains; the admin diagnoses through other tools.
    mounted = await mount(
      <ConnectorStatusHero
        installed={stdioBundle({
          status: "failed",
          state: "crashed",
          statusReason: "Out of memory",
        })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Failed");
    expect(mounted.container.textContent).toContain("Out of memory");
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
    expect(findButton(mounted.container, "Configure")).toBeNull();
  });

  test("admin-gated CTAs hidden when canManage=false; member-actionable kept", async () => {
    // Configure (admin) → hidden for non-admins.
    mounted = await mount(
      <ConnectorStatusHero
        installed={stdioBundle({
          status: "needs_setup",
          statusReason: "Missing required configuration: API Key.",
        })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Configure")).toBeNull();
    mounted.unmount();

    // Connect (member-actionable) → still visible for non-admins:
    // a workspace member can authenticate their own session.
    mounted = await mount(
      <ConnectorStatusHero
        installed={dcrConnector({ status: "needs_auth", state: "not_authenticated" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Connect")).not.toBeNull();
  });
});
