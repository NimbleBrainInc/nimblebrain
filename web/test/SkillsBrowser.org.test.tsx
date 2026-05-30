/**
 * Behavioral tests for `<SkillsBrowser lockedScope="org" />` — the
 * shared component the org-admin /org/skills surface renders.
 *
 * The role-gate test (orgRoleGate.test.ts) covers WHO can reach this
 * surface. This file covers WHAT the surface does once reached:
 *
 *   1. The scope filter is suppressed (only one scope is in view).
 *   2. The create form has no scope picker.
 *   3. Submitting the create form sends `scope: "org"` to the tool,
 *      regardless of what the user did inside the form. This is the
 *      load-bearing assertion: if a future edit drops the
 *      `useState<WritableScope>(lockedScope ?? "workspace")` default,
 *      the org surface would silently author into workspace scope.
 *      Nothing else catches that — the server's checkPathAccess gate
 *      rejects MEMBERS writing org skills, but cannot catch an ADMIN
 *      writing to the wrong scope through a regressed UI.
 *
 * The workspace surface (no lock) is covered structurally by the absence
 * of changes in the unmounted path — both selects render, scope defaults
 * to "workspace" — see SkillsTab.tsx::SkillsTab.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Patch globals happy-dom forgets to expose on its Window stub. Without
// these, mounting any `<select>` inside the component graph throws on
// `HTMLOptionElement[updateSelectedness]` → `new this.window.SyntaxError(...)`,
// and dispatching events throws on `new this.window.TypeError(...)`. The
// status filter select alone is enough to trip the first failure on initial
// render. Setting these on the happy-dom window once at module load avoids
// per-test scaffolding.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

// Capture every callTool invocation so we can assert against the create
// payload at the end of the flow. The list call returns an empty catalog so
// the UI lands on "no skills, click New skill" — the create form is the
// surface we want to exercise. Spread the preload snapshot so other exports
// (getAuthToken, getActiveWorkspaceId, …) stay intact for cross-suite safety.
type CallToolArgs = {
  server: string;
  tool: string;
  args: Record<string, unknown>;
};
const callToolCalls: CallToolArgs[] = [];

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    callToolCalls.push({ server, tool, args });
    if (server === "skills" && tool === "list") {
      return { structuredContent: { skills: [] }, isError: false };
    }
    if (server === "skills" && tool === "create") {
      return { structuredContent: { id: "/tmp/test-skill.md" }, isError: false };
    }
    return { structuredContent: {}, isError: false };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { SkillsBrowser } = await import("../src/pages/settings/SkillsTab");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  callToolCalls.length = 0;
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  // Drain the initial fetch + state updates.
  await act(async () => {
    await Promise.resolve();
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

function clickButtonByText(container: HTMLElement, text: string): boolean {
  for (const el of Array.from(container.querySelectorAll("button"))) {
    if (el.textContent?.includes(text)) {
      el.click();
      return true;
    }
  }
  return false;
}

describe("SkillsBrowser with lockedScope='org' (the /org/skills surface)", () => {
  test("does not render the scope filter selector", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    const filterSelect = mounted.container.querySelector('select[aria-label="Filter by scope"]');
    expect(filterSelect).toBeNull();
    // Status filter still renders — it's an orthogonal axis.
    const statusSelect = mounted.container.querySelector('select[aria-label="Filter by status"]');
    expect(statusSelect).not.toBeNull();
  });

  test("does not render the scope picker inside the create form", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    await act(async () => {
      clickButtonByText(mounted!.container, "New skill");
    });
    const scopePicker = mounted.container.querySelector("#skill-scope");
    expect(scopePicker).toBeNull();
    // Name input does render — confirms the form mounted, not just the
    // entire form was suppressed.
    const nameInput = mounted.container.querySelector("#skill-name");
    expect(nameInput).not.toBeNull();
  });

  test("submitting the create form sends scope='org' regardless of internal state", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    await act(async () => {
      clickButtonByText(mounted!.container, "New skill");
    });

    // Fill in the name — required to enable the Create button.
    const nameInput = mounted.container.querySelector("#skill-name") as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      // React uses a synthetic event system; fire a native input event and
      // set the value through the descriptor so React's onChange fires.
      // Use the happy-dom window's Event constructor — a globalThis.Event
      // instance fails happy-dom's `instanceof Event` check (it has its
      // own per-Window Event class).
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(nameInput, "voice-rule");
      const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window
        .Event;
      nameInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
    });

    await act(async () => {
      clickButtonByText(mounted!.container, "Create");
    });
    await act(async () => {
      await Promise.resolve();
    });

    const createCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "create");
    expect(createCall).toBeDefined();
    // This is THE assertion the gate can't catch — if the form's
    // `useState<WritableScope>(lockedScope ?? "workspace")` default ever
    // drops the lock, scope here goes to "workspace" and the org surface
    // silently authors into the wrong tier. Pin it.
    expect(createCall!.args.scope).toBe("org");
    expect((createCall!.args.manifest as { name?: string }).name).toBe("voice-rule");
  });

  test("initial skills.list fetch is scoped to org-tier", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    const listCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "list");
    expect(listCall).toBeDefined();
    // The scope filter starts at the locked value, so the first network
    // call must already be scoped — no flash of cross-tier skills.
    expect(listCall!.args.scope).toBe("org");
  });
});
