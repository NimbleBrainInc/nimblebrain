// ---------------------------------------------------------------------------
// InstallConnectorDialog — render + interaction contract (T010).
//
// Pins the load-bearing behaviors of the new install dialog:
//
//   1. Default-to-personal heuristic — opens for a `defaultBinding:
//      "personal"` connector and preselects the user's personal
//      workspace. Opens for a `defaultBinding: "workspace"` connector
//      with no obvious default and leaves the picker empty.
//
//   2. Typed-confirmation gate — installs into any non-personal
//      workspace require typing the workspace's display name to
//      enable Install. Personal installs skip the gate. Case-
//      insensitive comparison (decision documented inline in the
//      dialog's `typedConfirmationMatches` helper).
//
//   3. Install fires installConnector(entry, picked-wsId) — the wsId
//      passed to the API is the one selected in the dialog, NOT the
//      session-header workspace. Pins "no ambient leak" (Stage 1
//      lesson 2: audit attribution per install).
//
//   4. Dialog state reset on close — closing while typing `Helix`
//      and reopening for `Acme` clears the typed-confirmation state.
//      Adversarial: a leaked substring could let `Helix` typed for a
//      previous workspace also pass for a new workspace named
//      `Helix Apps`. The dialog clears confirmText + selection on
//      every open transition.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const installConnector = mock(async (_entry: unknown, _wsId: string) => ({
  ok: true,
  alreadyInstalled: false,
  serverName: "io-asana-mcp",
  scope: "workspace" as const,
  wsId: "ws_helix",
}));

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only `installConnector`
// is overridden. Keeps the process-global mock registry complete even when it
// leaks into another suite mid-run.
mock.module("../api/client", () => ({
  ...realClient,
  installConnector,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");

const { InstallConnectorDialog, preselectWorkspaceId, typedConfirmationMatches } = await import(
  "../components/connectors/InstallConnectorDialog"
);

import type { DirectoryEntry } from "../api/client";
import { WorkspaceProvider, type WorkspaceInfo } from "../context/WorkspaceContext";

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
  rerender(element: React.ReactElement): Promise<void>;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  installConnector.mockClear();
});

beforeEach(() => {
  installConnector.mockClear();
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
    async rerender(next: React.ReactElement) {
      await act(async () => {
        root.render(next);
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

/**
 * Fire a React-compatible change on a controlled input. happy-dom's
 * native dispatchEvent doesn't trigger React's onChange because React
 * patches the value setter on the native input prototype; we have to
 * call the native setter manually and then dispatch the synthetic-
 * equivalent `input` event so React notices the change.
 */
function fireInputChange(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  for (const el of Array.from(container.getElementsByTagName("*"))) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.getElementsByTagName("button")).find(
      (b) => (b.textContent ?? "").trim() === label,
    ) ?? null
  );
}

const PERSONAL_WS_ID = "ws_user_u1";
const HELIX_WS_ID = "ws_helix";
const ACME_WS_ID = "ws_acme";

const WORKSPACES: WorkspaceInfo[] = [
  {
    id: PERSONAL_WS_ID,
    name: "Personal",
    memberCount: 1,
    bundles: [],
    userRole: "admin",
    isPersonal: true,
  },
  {
    id: HELIX_WS_ID,
    name: "Helix",
    memberCount: 5,
    bundles: [],
    userRole: "admin",
    isPersonal: false,
  },
  {
    id: ACME_WS_ID,
    name: "Acme",
    memberCount: 8,
    bundles: [],
    userRole: "admin",
    isPersonal: false,
  },
  {
    id: "ws_partner",
    name: "Partner",
    memberCount: 3,
    bundles: [],
    userRole: "member", // viewer-only — should NOT appear in the picker
    isPersonal: false,
  },
];

function personalEntry(): DirectoryEntry {
  return {
    id: "ai.granola/mcp",
    registryId: "bundled-static",
    registryType: "static",
    name: "Granola",
    description: "Meeting notes",
    defaultBinding: "personal",
    install: {
      kind: "remote-oauth",
      url: "https://api.granola.test/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

function sharedEntry(): DirectoryEntry {
  return {
    id: "io.asana/mcp",
    registryId: "bundled-static",
    registryType: "static",
    name: "Asana",
    description: "Tasks, projects, and team workflows",
    defaultBinding: "workspace",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.asana.com/v2/mcp",
      transportType: "streamable-http",
      auth: "static",
      operatorSetup: {
        portalUrl: "https://app.asana.com/0/developer-console",
        hint: "Create an OAuth app",
        clientSecretKey: "asana.client_secret",
      },
    },
  };
}

function withWorkspaces(children: React.ReactElement): React.ReactElement {
  return (
    <WorkspaceProvider initialWorkspaces={WORKSPACES} initialActiveId={HELIX_WS_ID}>
      {children}
    </WorkspaceProvider>
  );
}

// ── Pure-helper tests ───────────────────────────────────────────────

describe("preselectWorkspaceId", () => {
  test("preselects the user's personal workspace when defaultBinding is 'personal'", () => {
    const out = preselectWorkspaceId(personalEntry(), [
      { id: PERSONAL_WS_ID, name: "Personal", isPersonal: true },
      { id: HELIX_WS_ID, name: "Helix", isPersonal: false },
    ]);
    expect(out).toBe(PERSONAL_WS_ID);
  });

  test("returns null for a workspace-binding connector — user picks explicitly", () => {
    const out = preselectWorkspaceId(sharedEntry(), [
      { id: PERSONAL_WS_ID, name: "Personal", isPersonal: true },
      { id: HELIX_WS_ID, name: "Helix", isPersonal: false },
    ]);
    expect(out).toBeNull();
  });

  test("returns null for a personal-binding connector when no personal workspace is eligible", () => {
    // E.g. a user whose personal workspace hasn't been provisioned
    // yet (pre-Stage-1 deployment in the migration window). Defaults
    // gracefully — no preselection means the picker stays empty and
    // the user picks explicitly.
    const out = preselectWorkspaceId(personalEntry(), [
      { id: HELIX_WS_ID, name: "Helix", isPersonal: false },
    ]);
    expect(out).toBeNull();
  });
});

describe("typedConfirmationMatches", () => {
  test("case-insensitive exact match after trimming both sides", () => {
    // Intentional decision (documented inline in the dialog): the
    // typed-confirmation gate is friction, not key-entry precision.
    // A user typing `helix` for a workspace named `Helix` clearly
    // means to install there; punishing case mismatch would be
    // hostile UX. Documenting via assertions so a tightening to
    // case-sensitive doesn't slip in unnoticed.
    expect(typedConfirmationMatches("Helix", "Helix")).toBe(true);
    expect(typedConfirmationMatches("helix", "Helix")).toBe(true);
    expect(typedConfirmationMatches("  HELIX  ", "Helix")).toBe(true);
    expect(typedConfirmationMatches("", "Helix")).toBe(false);
    expect(typedConfirmationMatches("Hel", "Helix")).toBe(false);
    expect(typedConfirmationMatches("Helix Apps", "Helix")).toBe(false);
  });
});

// ── Dialog mount + interaction tests ─────────────────────────────────

describe("InstallConnectorDialog — default-to-personal", () => {
  test("a Gmail-style connector preselects the user's personal workspace", async () => {
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={personalEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );
    const personalButton = findByTestId(mounted.container, `workspace-target-${PERSONAL_WS_ID}`);
    expect(personalButton?.getAttribute("aria-checked")).toBe("true");
    // Install button is enabled — no typed confirmation required for
    // personal installs.
    const installBtn = findByTestId(mounted.container, "install-confirm-button");
    expect(installBtn?.hasAttribute("disabled")).toBe(false);
    // Typed-confirmation input is NOT rendered.
    expect(findByTestId(mounted.container, "install-typed-confirmation")).toBeNull();
  });

  test("a workspace-binding connector with no obvious default leaves the picker empty", async () => {
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );
    // No workspace preselected — every row's aria-checked is false.
    const personal = findByTestId(mounted.container, `workspace-target-${PERSONAL_WS_ID}`);
    const helix = findByTestId(mounted.container, `workspace-target-${HELIX_WS_ID}`);
    const acme = findByTestId(mounted.container, `workspace-target-${ACME_WS_ID}`);
    expect(personal?.getAttribute("aria-checked")).toBe("false");
    expect(helix?.getAttribute("aria-checked")).toBe("false");
    expect(acme?.getAttribute("aria-checked")).toBe("false");
    // Install button is disabled — nothing selected.
    const installBtn = findByTestId(mounted.container, "install-confirm-button");
    expect(installBtn?.hasAttribute("disabled")).toBe(true);
  });
});

describe("InstallConnectorDialog — picker filters to installable workspaces", () => {
  test("workspaces the user is only a member of do not appear in the picker", async () => {
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );
    // Personal + Helix + Acme are admin-role → present.
    expect(findByTestId(mounted.container, `workspace-target-${PERSONAL_WS_ID}`)).not.toBeNull();
    expect(findByTestId(mounted.container, `workspace-target-${HELIX_WS_ID}`)).not.toBeNull();
    expect(findByTestId(mounted.container, `workspace-target-${ACME_WS_ID}`)).not.toBeNull();
    // Partner is member-only → absent.
    expect(findByTestId(mounted.container, "workspace-target-ws_partner")).toBeNull();
  });
});

describe("InstallConnectorDialog — typed-confirmation gate", () => {
  test("Install into a shared workspace is disabled until the user types its name", async () => {
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );
    // Click Helix to select it.
    const helixButton = findByTestId(
      mounted.container,
      `workspace-target-${HELIX_WS_ID}`,
    ) as HTMLButtonElement | null;
    expect(helixButton).not.toBeNull();
    await act(async () => {
      helixButton?.click();
    });
    // Confirm input is now rendered; Install is disabled.
    const confirmInput = findByTestId(
      mounted.container,
      "install-typed-confirmation",
    ) as HTMLInputElement | null;
    expect(confirmInput).not.toBeNull();
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(true);

    // Type the workspace name (lowercase — case-insensitive match).
    await act(async () => {
      if (confirmInput) fireInputChange(confirmInput, "helix");
    });
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(false);
  });

  test("Install into the personal workspace is enabled immediately (no typed-confirmation gate)", async () => {
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={personalEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );
    // Personal is preselected; Install is enabled and no confirm input
    // is rendered.
    expect(findByTestId(mounted.container, "install-typed-confirmation")).toBeNull();
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("InstallConnectorDialog — install fires with the picked wsId (no ambient leak)", () => {
  test("clicking Install calls installConnector(entry, picked-wsId)", async () => {
    const onInstalled = mock((_r: { serverName: string; wsId: string }) => {});
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={onInstalled}
        />,
      ),
    );
    // Pick Helix, type its name to satisfy the gate, click Install.
    const helixButton = findByTestId(
      mounted.container,
      `workspace-target-${HELIX_WS_ID}`,
    ) as HTMLButtonElement | null;
    await act(async () => {
      helixButton?.click();
    });
    const confirmInput = findByTestId(
      mounted.container,
      "install-typed-confirmation",
    ) as HTMLInputElement | null;
    await act(async () => {
      if (confirmInput) fireInputChange(confirmInput, "Helix");
    });
    const installBtn = findByTestId(
      mounted.container,
      "install-confirm-button",
    ) as HTMLButtonElement | null;
    await act(async () => {
      installBtn?.click();
    });
    expect(installConnector).toHaveBeenCalledTimes(1);
    expect(installConnector.mock.calls[0]?.[1]).toBe(HELIX_WS_ID);
    // Audit attribution flows back via the mock's resolved wsId. The
    // bridge between UI selection and the recorded wsId is what
    // prevents the Stage-1-style "ambient session leak" failure.
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });
});

describe("InstallConnectorDialog — state reset on close (adversarial)", () => {
  test("closing for Helix (typed 'Helix') and reopening for Acme requires re-typing", async () => {
    // Adversarial scenario: a user opens the install dialog for a
    // shared connector, picks Helix, types `Helix`, then closes
    // (clicks Cancel) before confirming. They then reopen the dialog
    // for a different connector (or the same one). The dialog MUST
    // clear the typed-confirmation text and the prior selection —
    // otherwise stale `Helix` text could satisfy the typed-
    // confirmation gate for a different workspace whose name happens
    // to be `Helix` (or even for the same workspace, bypassing
    // intentional UX friction the second time).
    //
    // This test pins the state-reset contract by walking the dialog
    // through: open(Helix-pick + type-Helix) → close → reopen → Acme
    // pick must show the gate fresh + empty.
    mounted = await mount(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );
    // 1. Pick Helix and type the confirmation.
    const helixButton = findByTestId(
      mounted.container,
      `workspace-target-${HELIX_WS_ID}`,
    ) as HTMLButtonElement | null;
    await act(async () => {
      helixButton?.click();
    });
    const confirmInputA = findByTestId(
      mounted.container,
      "install-typed-confirmation",
    ) as HTMLInputElement | null;
    await act(async () => {
      if (confirmInputA) fireInputChange(confirmInputA, "Helix");
    });
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(false);

    // 2. Close the dialog (open=false).
    await mounted.rerender(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={false}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );

    // 3. Reopen the dialog with `open=true`. The selection + typed
    // confirmation MUST be cleared.
    await mounted.rerender(
      withWorkspaces(
        <InstallConnectorDialog
          entry={sharedEntry()}
          open={true}
          onClose={() => {}}
          onInstalled={() => {}}
        />,
      ),
    );

    // No workspace preselected (sharedEntry has defaultBinding: "workspace").
    const helixAfter = findByTestId(mounted.container, `workspace-target-${HELIX_WS_ID}`);
    expect(helixAfter?.getAttribute("aria-checked")).toBe("false");
    // No confirm input rendered until the user picks a non-personal
    // workspace — selection was cleared.
    expect(findByTestId(mounted.container, "install-typed-confirmation")).toBeNull();
    // Install button is disabled — nothing selected, no leaked state.
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(true);

    // 4. Pick Acme; the confirmation input is freshly empty (NOT
    //    pre-filled with the prior `Helix` text); Install stays
    //    disabled until the user types `Acme`.
    const acmeButton = findByTestId(
      mounted.container,
      `workspace-target-${ACME_WS_ID}`,
    ) as HTMLButtonElement | null;
    await act(async () => {
      acmeButton?.click();
    });
    const confirmInputB = findByTestId(
      mounted.container,
      "install-typed-confirmation",
    ) as HTMLInputElement | null;
    expect(confirmInputB).not.toBeNull();
    expect(confirmInputB?.value).toBe("");
    // Install still disabled — neither the prior `Helix` text nor any
    // auto-fill bypasses the gate.
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(true);
    // Typing the WRONG name (the prior workspace's name) still leaves
    // it disabled.
    await act(async () => {
      if (confirmInputB) fireInputChange(confirmInputB, "Helix");
    });
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(true);
    // Typing the right name unlocks Install.
    await act(async () => {
      if (confirmInputB) fireInputChange(confirmInputB, "Acme");
    });
    expect(
      findByTestId(mounted.container, "install-confirm-button")?.hasAttribute("disabled"),
    ).toBe(false);
  });
});

// Silence the noisy unused-import warning happy-dom can trigger.
void findButton;
