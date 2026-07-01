// ---------------------------------------------------------------------------
// ToolCallProvenance — Stage 2 / T013 (Q2)
//
// Pins the three behaviors the task spec calls out:
//
//   1. Friendly name + workspace badge — `ws_helix-collateral__get_doc`
//      renders as `collateral.get_doc · Helix` with the Helix
//      workspace badge.
//   2. Fallback to raw on missing workspace — a tool call for
//      `ws_removed-foo` where `ws_removed` is no longer in the user's
//      workspace list renders the raw `ws_removed-foo` string.
//      Adversarial: a regression that defaulted to the personal
//      workspace's display name would be a subtle correctness bug.
//   3. Namespace parsing flows through `parseNamespacedToolName` only —
//      no `.split("/")`. A file-level grep enforces this in the test
//      below.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ToolCallProvenance } = await import("../src/components/chat/ToolCallProvenance");

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
  await act(async () => {
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

function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  const all = Array.from(container.getElementsByTagName("*"));
  for (const el of all) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function ws(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws_helix",
    name: "Helix",
    memberCount: 1,
    bundles: [],
    ...over,
  };
}

describe("ToolCallProvenance", () => {
  test("renders friendly tool name + workspace badge for known namespaced tool", async () => {
    mounted = await mount(
      <ToolCallProvenance
        toolName="ws_helix-collateral__get_doc"
        status="ok"
        workspaces={[ws({ id: "ws_helix", name: "Helix" })]}
      />,
    );
    const text = mounted.container.textContent ?? "";
    // Friendly name: `get_doc` after `stripServerPrefix` removes
    // `collateral__` from `collateral__get_doc`.
    expect(text).toContain("get_doc");
    expect(text).toContain("Helix");
    // Workspace badge carries data attributes for the visual
    // attribution test.
    const badge = findByTestId(mounted.container, "workspace-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("data-workspace-id")).toBe("ws_helix");
    // Badge variant is deterministic per workspace id, but the exact
    // mapping is an implementation detail — assert non-empty + non-
    // "secondary" (secondary is reserved for the personal workspace).
    const variant = badge?.getAttribute("data-workspace-variant");
    expect(variant).toBeTruthy();
    expect(variant).not.toBe("secondary");
    // Status pill present.
    const status = findByTestId(mounted.container, "status-pill");
    expect(status?.getAttribute("data-status")).toBe("ok");
  });

  test("strips the `<server>__` prefix when present", async () => {
    mounted = await mount(
      <ToolCallProvenance
        toolName="ws_helix-gmail__send_message"
        workspaces={[ws({ id: "ws_helix", name: "Helix" })]}
      />,
    );
    const text = mounted.container.textContent ?? "";
    // Friendly form: `send_message` (after stripServerPrefix on
    // `gmail__send_message`).
    expect(text).toContain("send_message");
    // The raw `gmail__` prefix should NOT survive into the friendly
    // tool name — a regression that left it would defeat the Q2
    // "render workspace + friendly name" intent.
    const friendly = findByTestId(mounted.container, "tool-call-provenance");
    const friendlyText = friendly?.textContent ?? "";
    expect(friendlyText.startsWith("gmail__")).toBe(false);
  });

  test("falls back to RAW when workspace is no longer in the user's list (Q2)", async () => {
    // Adversarial: this is the regression the audit pins. A removed
    // workspace must NOT render with the user's personal workspace
    // name as a fallback — that would silently misattribute every
    // historical tool call.
    mounted = await mount(
      <ToolCallProvenance
        toolName="ws_removed-foo"
        workspaces={[
          ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }),
          ws({ id: "ws_helix", name: "Helix" }),
        ]}
      />,
    );
    const root = findByTestId(mounted.container, "tool-call-provenance");
    expect(root?.getAttribute("data-fallback")).toBe("missing-workspace");
    expect(root?.getAttribute("data-raw")).toBe("ws_removed-foo");
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("ws_removed-foo");
    // No workspace badge in the fallback path — there's no friendly
    // workspace to attribute to.
    expect(findByTestId(mounted.container, "workspace-badge")).toBeNull();
    // CRITICAL: the personal workspace name must NOT bleed in.
    expect(text).not.toContain("Personal");
  });

  test("bare/identity input renders the friendly tool name with no workspace badge", async () => {
    // Bare platform tools like `nb__resources_search` are identity-scoped
    // singletons — render the friendly tool name (source prefix stripped),
    // marked as identity scope, with no workspace badge.
    mounted = await mount(
      <ToolCallProvenance
        toolName="nb__resources_search"
        workspaces={[ws({ id: "ws_helix", name: "Helix" })]}
      />,
    );
    const root = findByTestId(mounted.container, "tool-call-provenance");
    expect(root?.getAttribute("data-scope")).toBe("identity");
    expect(mounted.container.textContent).toContain("resources_search");
    expect(findByTestId(mounted.container, "workspace-badge")).toBeNull();
  });

  test("status: error renders the error pill", async () => {
    mounted = await mount(
      <ToolCallProvenance
        toolName="ws_helix-crm__search"
        status="error"
        workspaces={[ws({ id: "ws_helix", name: "Helix" })]}
      />,
    );
    const pill = findByTestId(mounted.container, "status-pill");
    expect(pill?.getAttribute("data-status")).toBe("error");
    expect(pill?.textContent).toBe("error");
  });

  test("status: running renders the running pill", async () => {
    mounted = await mount(
      <ToolCallProvenance
        toolName="ws_helix-crm__search"
        status="running"
        workspaces={[ws({ id: "ws_helix", name: "Helix" })]}
      />,
    );
    const pill = findByTestId(mounted.container, "status-pill");
    expect(pill?.getAttribute("data-status")).toBe("running");
  });

  test("personal workspace gets the dedicated badge variant", async () => {
    mounted = await mount(
      <ToolCallProvenance
        toolName="ws_user_u1-gmail__send"
        workspaces={[ws({ id: "ws_user_u1", name: "Personal", isPersonal: true })]}
      />,
    );
    const badge = findByTestId(mounted.container, "workspace-badge");
    // Personal pin — see workspaceBadgeVariant doc comment.
    expect(badge?.getAttribute("data-workspace-variant")).toBe("secondary");
  });
});

// ---------------------------------------------------------------------------
// Audit grep — task spec acceptance criterion:
//
//   "Namespace parsing via T002 only: grep the new components for
//    `.split(\"/\")` adjacent to a tool-name binding → zero matches."
//
// Reads the source files directly and asserts the regex doesn't match.
// A regression that hand-built `.split("/")` instead of going through
// parseNamespacedToolName would fail loudly here.
// ---------------------------------------------------------------------------

describe("audit: no .split(\"/\") in new T013 components", () => {
  test("ToolCallProvenance + WorkspaceNav have zero matches", async () => {
    // The sidebar workspace surface went through several redesigns post-T013
    // (left rail → labelled vertical section → the workspace tree).
    // WorkspaceNav is the current structural guard for the workspaces surface.
    const root = join(import.meta.dir, "..");
    const targets = [
      "src/components/chat/ToolCallProvenance.tsx",
      "src/components/shell/WorkspaceNav.tsx",
    ];
    const offenders: string[] = [];
    for (const rel of targets) {
      const body = await readFile(join(root, rel), "utf-8");
      if (/\.split\(["']\/["']\)/.test(body)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
