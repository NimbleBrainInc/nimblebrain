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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── api/client mocks ────────────────────────────────────────────────
// Every section calls into one or two helpers from api/client. We
// mock the module wholesale so the components don't try to fetch.

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
  catalogId: "asana",
  clientId: "cid-rotated",
}));

mock.module("../api/client", () => ({
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
const { BundleConfigSection } = await import("../components/connectors/BundleConfigSection");

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
    scope: "workspace",
    interactive: false,
    toolCount: 3,
    trustScore: null,
    url: "https://api.granola.test/mcp",
    catalogId: "granola",
    catalog: {
      id: "granola",
      name: "Granola",
      description: "Meeting notes",
      iconUrl: "",
      url: "https://api.granola.test/mcp",
      auth: "dcr",
      defaultScope: "workspace",
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
    scope: "workspace",
    interactive: false,
    toolCount: 8,
    trustScore: null,
    url: "https://app.asana.com/api/mcp",
    catalogId: "asana",
    catalog: {
      id: "asana",
      name: "Asana",
      description: "Work mgmt",
      iconUrl: "",
      url: "https://app.asana.com/api/mcp",
      auth: "static",
      defaultScope: "workspace",
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

describe("OAuthConnectionSection", () => {
  test("renders nothing for stdio (non-remote) bundles", async () => {
    mounted = await mount(
      <OAuthConnectionSection installed={stdioBundle()} canManage={true} onChanged={() => {}} />,
    );
    expect(mounted.container.textContent).toBe("");
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

  test("reauth_required → reconnection notice + Reconnect button", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "reauth_required" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Reconnection needed");
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("crashed → 'Failed: <lastError>' + Reconnect button", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "crashed", lastError: "token revoked upstream" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Failed: token revoked upstream");
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("not_authenticated → 'Not connected' + Connect button", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "not_authenticated" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Not connected");
    expect(findButton(mounted.container, "Connect")).not.toBeNull();
  });

  test("pending_auth → 'Connecting…' with no actionable button", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={dcrConnector({ state: "pending_auth" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("Connecting");
    // No Connect / Disconnect / Reconnect button while in-flight.
    expect(findButton(mounted.container, "Connect")).toBeNull();
    expect(findButton(mounted.container, "Disconnect")).toBeNull();
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
  });

  test("canManage=false hides every action button regardless of state", async () => {
    // Non-admin: shouldn't see Disconnect on running, Reconnect on
    // reauth_required, or Connect on not_authenticated.
    for (const state of [
      "running",
      "reauth_required",
      "crashed",
      "dead",
      "not_authenticated",
    ] as const) {
      mounted?.unmount();
      mounted = await mount(
        <OAuthConnectionSection
          installed={dcrConnector({ state })}
          canManage={false}
          onChanged={() => {}}
        />,
      );
      const buttonCount = mounted.container.getElementsByTagName("button").length;
      expect(buttonCount).toBe(0);
    }
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

// ── BundleConfigSection ─────────────────────────────────────────────

describe("BundleConfigSection", () => {
  test("renders nothing for connectors without a userConfig schema (DCR / static-auth)", async () => {
    mounted = await mount(
      <BundleConfigSection installed={dcrConnector()} canManage={true} onChanged={() => {}} />,
    );
    expect(mounted.container.textContent).toBe("");
  });

  test("renders schema-driven rows for stdio bundle with user_config", async () => {
    mounted = await mount(
      <BundleConfigSection installed={stdioBundle()} canManage={true} onChanged={() => {}} />,
    );
    expect(mounted.container.textContent).toContain("Bundle configuration");
    expect(mounted.container.textContent).toContain("API Key");
    expect(mounted.container.textContent).toContain("Not configured");
    expect(findButton(mounted.container, "Edit")).not.toBeNull();
  });

  test("populated field renders '✓ configured' instead of 'Not configured'", async () => {
    mounted = await mount(
      <BundleConfigSection
        installed={stdioBundle({
          userConfig: {
            schema: {
              api_key: { type: "string", title: "API Key", sensitive: true, required: true },
            },
            populated: { api_key: true },
          },
        })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("configured");
    expect(mounted.container.textContent).not.toContain("Not configured");
  });

  test("Clear configuration link only appears when at least one field is populated", async () => {
    // Nothing configured → no clear link.
    mounted = await mount(
      <BundleConfigSection installed={stdioBundle()} canManage={true} onChanged={() => {}} />,
    );
    expect(findButton(mounted.container, "Clear configuration")).toBeNull();
    mounted.unmount();

    // One field configured → clear link appears.
    mounted = await mount(
      <BundleConfigSection
        installed={stdioBundle({
          userConfig: {
            schema: {
              api_key: { type: "string", title: "API Key", sensitive: true, required: true },
            },
            populated: { api_key: true },
          },
        })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Clear configuration")).not.toBeNull();
  });

  test("canManage=false hides Edit + Clear (rows still rendered)", async () => {
    mounted = await mount(
      <BundleConfigSection
        installed={stdioBundle({
          userConfig: {
            schema: {
              api_key: { type: "string", title: "API Key", sensitive: true, required: true },
            },
            populated: { api_key: true },
          },
        })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("API Key");
    expect(findButton(mounted.container, "Edit")).toBeNull();
    expect(findButton(mounted.container, "Clear configuration")).toBeNull();
  });
});
