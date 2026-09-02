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
const connectComposioApiKey = mock(async () => ({
  connected: true,
  serverName: "com-posthog-analytics",
  status: "ACTIVE",
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

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { OAuthConnectionSection } = await import("../components/connectors/OAuthConnectionSection");
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

/** Reset all api/client mock invocations between tests. */
beforeEach(() => {
  disconnectConnector.mockClear();
  initiateMcpOAuth.mockClear();
  clearBundleUserConfig.mockClear();
  setBundleUserConfig.mockClear();
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
    bundleName: "https://ipinfo.example.com/mcp",
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
    bundleName: "granola",
    version: "remote",
    type: "remote",
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
    bundleName: "posthog",
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
    bundleName: "asana",
    version: "remote",
    type: "remote",
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

// ── OAuthConnectionSection ──────────────────────────────────────────
//
// Refactored: this section is now ONLY the connection-details surface
// for an established connection. The hero (ConnectorStatusHero) owns
// every primary CTA (Connect / Reconnect / Configure / Set up). The
// section renders only on the happy path: running + remote-OAuth.
// Non-running states are handled by the hero with the right copy +
// CTA, so duplicating them here would double-count the message.

describe("OAuthConnectionSection", () => {
  test("renders nothing for a connector with no url on its ref", async () => {
    mounted = await mount(
      <OAuthConnectionSection
        installed={uncataloguedConnector()}
        canManage={true}
        onChanged={() => {}}
      />,
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

  // ── version line (identity row) ──────────────────────────────────
  // A fleet connector reports a v-prefixed handshake version (image tags carry the
  // "v") and declares no catalog version ("unknown"): render exactly one "v" and no
  // bogus drift note.
  test("version: v-prefixed handshake + declared 'unknown' → single 'v', no catalog note", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={dcrConnector({ handshakeVersion: "v0.1.0", version: "unknown" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("v0.1.0");
    expect(mounted.container.textContent).not.toContain("vv0.1.0");
    expect(mounted.container.textContent).not.toContain("vunknown");
    expect(mounted.container.textContent).not.toContain("catalog v");
  });

  // Edge-channel fleet connectors report the build SHA as their version; a SHA is
  // not semver, so show it as-is (no bogus "v" prefix) and no catalog note.
  test("version: build-SHA handshake + 'remote' declared → SHA as-is, no 'v', no catalog note", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={dcrConnector({ handshakeVersion: "cd0ab7f", version: "remote" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("cd0ab7f");
    expect(mounted.container.textContent).not.toContain("vcd0ab7f");
    expect(mounted.container.textContent).not.toContain("catalog v");
  });

  test("version: a plain semver renders one 'v'", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={uncataloguedConnector({ version: "1.0.0" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("v1.0.0");
    expect(mounted.container.textContent).not.toContain("vv1.0.0");
    expect(mounted.container.textContent).not.toContain("catalog v");
  });

  test("version: real drift (running != declared) shows a catalog note, each one 'v'", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={uncataloguedConnector({ handshakeVersion: "v0.2.0", version: "0.1.0" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("v0.2.0");
    expect(mounted.container.textContent).toContain("catalog v0.1.0");
    expect(mounted.container.textContent).not.toContain("vv");
  });

  test("version: no false drift when running and declared differ only by the 'v' prefix", async () => {
    mounted = await mount(
      <ConnectorStatusHero
        installed={uncataloguedConnector({ handshakeVersion: "v0.1.0", version: "0.1.0" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(mounted.container.textContent).toContain("v0.1.0");
    expect(mounted.container.textContent).not.toContain("catalog v");
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

  test("Reconnect on an already-connected source refreshes in place — no navigation (#679)", async () => {
    const onChanged = mock(() => {});
    // The source reconnected without an interactive flow — startAuth returned no URL.
    initiateMcpOAuth.mockResolvedValueOnce({ authorizationUrl: null });
    locationAssign.mockClear();
    mounted = await mount(
      <ConnectorStatusHero
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
      <ConnectorStatusHero
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
      <ConnectorStatusHero
        installed={dcrConnector({ status: "needs_auth", state: "not_authenticated" })}
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
      <ConnectorStatusHero
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
      <ConnectorStatusHero
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
      <ConnectorStatusHero
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
      <ConnectorStatusHero
        installed={composioApiKeyConnector({ status: "needs_auth", state: "reauth_required" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
    mounted.unmount();

    mounted = await mount(
      <ConnectorStatusHero
        installed={composioApiKeyConnector({ status: "needs_auth", state: "reauth_required" })}
        canManage={true}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).not.toBeNull();
  });

  test("a composio OAUTH2 connector stays open to a member — the server grants it", async () => {
    // `authScheme` is optional and defaults to OAUTH2, so the ordinary composio
    // connector has none and takes /v1/composio-auth/initiate — requireAuth +
    // requireWorkspace, no admin check (#755). Gating it here would hide
    // Reconnect while the server still grants it, which is the client/server
    // divergence #741 exists to remove. This pins the API_KEY discriminator:
    // without it, every composio connector would be gated.
    mounted = await mount(
      <ConnectorStatusHero
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
    // `failed` is the other arm of the rotation predicate — a remote bundle
    // that died still offers Reconnect, and for an API-key connector that is
    // the same admin-gated rotation.
    mounted = await mount(
      <ConnectorStatusHero
        installed={composioApiKeyConnector({ status: "failed", state: "crashed" })}
        canManage={false}
        onChanged={() => {}}
      />,
    );
    expect(findButton(mounted.container, "Reconnect")).toBeNull();
    mounted.unmount();

    mounted = await mount(
      <ConnectorStatusHero
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
      <ConnectorStatusHero
        installed={composioApiKeyConnector({ status: "needs_auth", state: "not_authenticated" })}
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
      <ConnectorStatusHero
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

  test("a missing required field blocks submit (no connect call, shows error)", async () => {
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
    await act(async () => {
      findButton(mounted!.container, "Connect")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectComposioApiKey).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain("required");
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
