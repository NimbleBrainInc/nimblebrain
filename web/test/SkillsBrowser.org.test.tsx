/**
 * Behavioral tests for `<SkillsBrowser lockedScope="org" />` after the
 * skills-redesign rewrite. The org-admin tab uses this surface.
 *
 *   1. No scope filter (single-scope view).
 *   2. The create form's "Name it" + "What should the agent do?" submit
 *      sends `scope: "org"` regardless of internal state — the load-
 *      bearing assertion the server's checkPathAccess can't catch.
 *   3. Initial skills__list fetch is pre-scoped to org-tier.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

type CallToolArgs = { server: string; tool: string; args: Record<string, unknown> };
const callToolCalls: CallToolArgs[] = [];

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    callToolCalls.push({ server, tool, args });
    if (server === "skills" && tool === "list") {
      return { structuredContent: { skills: [] }, isError: false };
    }
    if (server === "skills" && tool === "create") {
      return { structuredContent: { id: "/tmp/org/test.md" }, isError: false };
    }
    return { structuredContent: {}, isError: false };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
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
    root.render(React.createElement(MemoryRouter, null, element));
  });
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

function clickByText(container: HTMLElement, text: string): boolean {
  for (const el of Array.from(container.querySelectorAll("button"))) {
    if (el.textContent?.includes(text)) {
      el.click();
      return true;
    }
  }
  return false;
}

describe("SkillsBrowser with lockedScope='org' (org-admin /org/skills surface)", () => {
  test("does not render a scope filter", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    expect(mounted.container.querySelector('select[aria-label="Filter by scope"]')).toBeNull();
  });

  test("submitting + Add a skill sends scope='org' regardless of internal state", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    await act(async () => {
      clickByText(mounted!.container, "+ Add a skill");
    });

    const nameInput = mounted.container.querySelector("#rule-name") as HTMLInputElement | null;
    const bodyInput = mounted.container.querySelector("#rule-body") as HTMLTextAreaElement | null;
    expect(nameInput).not.toBeNull();
    expect(bodyInput).not.toBeNull();

    const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window
      .Event;
    await act(async () => {
      const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setVal?.call(nameInput, "voice-rule");
      nameInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setTa?.call(bodyInput, "Match editorial voice.");
      bodyInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
    });
    await act(async () => {
      clickByText(mounted!.container, "Save");
    });
    await act(async () => {
      await Promise.resolve();
    });

    const createCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "create");
    expect(createCall).toBeDefined();
    expect(createCall!.args.scope).toBe("org");
    expect((createCall!.args.manifest as { name?: string }).name).toBe("voice-rule");
    // Title → on-disk description (required non-empty) + row label.
    expect((createCall!.args.manifest as { description?: string }).description).toBe("voice-rule");
    // Rules are always-on; sent explicitly so the skill actually loads.
    expect((createCall!.args.manifest as { loadingStrategy?: string }).loadingStrategy).toBe(
      "always",
    );
    // The removed `type` field is no longer sent.
    expect((createCall!.args.manifest as { type?: string }).type).toBeUndefined();
  });

  test("initial skills.list fetch is pre-scoped to org", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { lockedScope: "org" }));
    const listCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "list");
    expect(listCall).toBeDefined();
    expect(listCall!.args.scope).toBe("org");
  });
});
