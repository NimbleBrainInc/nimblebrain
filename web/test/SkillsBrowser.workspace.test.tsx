/**
 * Behavioral tests for `<SkillsBrowser surface="workspace" />` after the
 * skills-redesign rewrite.
 *
 * The workspace surface owes its user:
 *
 *   1. No scope filter — sections are the partition.
 *   2. No status filter either — the per-row On/Off toggle is the
 *      enablement control.
 *   3. Sections render: workspace, inherited from organization,
 *      inherited from installed apps. User-tier skills surface only
 *      as the personal-footer count, not as a section.
 *   4. The create form ("+ Add a rule") sends `scope: "workspace"`
 *      regardless of internal state. This is the load-bearing assertion
 *      the server's checkPathAccess can't catch.
 *   5. Initial skills__list fetch is unfiltered by scope.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom doesn't expose SyntaxError/TypeError on its Window stub;
// any <select> render trips this. Same patch as the org-surface test.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

type CallToolArgs = { server: string; tool: string; args: Record<string, unknown> };
const callToolCalls: CallToolArgs[] = [];

const SKILLS_FIXTURE = [
  {
    id: "/tmp/skills/ws/workflow.md",
    name: "workflow",
    description: "Workspace-tier rule.",
    scope: "workspace",
    layer: 3,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 100,
    source: { path: "/tmp/skills/ws/workflow.md" },
  },
  {
    id: "/tmp/skills/org/voice.md",
    name: "voice",
    description: "Org-tier voice rules.",
    scope: "org",
    layer: 3,
    status: "active",
    type: "context",
    priority: 30,
    tokens: 50,
    source: { path: "/tmp/skills/org/voice.md" },
  },
  {
    id: "skill://bundle/usage",
    name: "bundle-skill",
    description: "Bundle (Layer 1).",
    scope: "bundle",
    layer: 1,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 80,
    source: { uri: "skill://bundle/usage" },
  },
  {
    id: "/tmp/skills/user/personal-1.md",
    name: "personal-1",
    description: "Personal skill A.",
    scope: "user",
    layer: 3,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 25,
    source: { path: "/tmp/skills/user/personal-1.md" },
  },
  {
    id: "/tmp/skills/user/personal-2.md",
    name: "personal-2",
    description: "Personal skill B.",
    scope: "user",
    layer: 3,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 35,
    source: { path: "/tmp/skills/user/personal-2.md" },
  },
];

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    callToolCalls.push({ server, tool, args });
    if (server === "skills" && tool === "list") {
      return { structuredContent: { skills: SKILLS_FIXTURE }, isError: false };
    }
    if (server === "skills" && tool === "create") {
      return { structuredContent: { id: "/tmp/skills/ws/test-skill.md" }, isError: false };
    }
    if (server === "skills" && tool === "read") {
      return {
        structuredContent: {
          id: args.id,
          content: "Test body.",
          layer: 3,
          scope: "workspace",
          source: { path: args.id },
          metadata: {
            name: "x",
            type: "context",
            priority: 50,
            status: "active",
          },
        },
        isError: false,
      };
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

describe("SkillsBrowser with surface='workspace' (workspace settings tab)", () => {
  test("does not render a scope filter", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    expect(mounted.container.querySelector('select[aria-label="Filter by scope"]')).toBeNull();
  });

  test("renders inherited-org, inherited-bundles sections (no user section)", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("From your organization");
    expect(text).toContain("From installed apps");
    // User-tier skills never appear as a section — only as the
    // personal-footer count.
    expect(text).not.toMatch(/From user/);
  });

  test("personal-skills footer shows the correct count and links to /profile", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("2 personal rules active here");
    const link = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit in your profile"),
    );
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/profile");
  });

  test("submitting + Add a rule sends scope='workspace' regardless of internal state", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    await act(async () => {
      clickByText(mounted!.container, "+ Add a rule");
    });

    const nameInput = mounted.container.querySelector("#rule-name") as HTMLInputElement | null;
    const bodyInput = mounted.container.querySelector("#rule-body") as HTMLTextAreaElement | null;
    expect(nameInput).not.toBeNull();
    expect(bodyInput).not.toBeNull();

    const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window
      .Event;
    await act(async () => {
      const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setVal?.call(nameInput, "new-ws-rule");
      nameInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setTa?.call(bodyInput, "Match the workspace voice.");
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
    // THE load-bearing assertion. If a future refactor drops the
    // workspace-surface lock, the server's checkPathAccess won't catch
    // an admin authoring into the wrong scope.
    expect(createCall!.args.scope).toBe("workspace");
    expect((createCall!.args.manifest as { name?: string }).name).toBe("new-ws-rule");
    // Description field is never authored from the UI.
    expect((createCall!.args.manifest as { description?: string }).description).toBe("");
    // Type defaults to "context" so the loader picks `loading_strategy:
    // always` for short prose rules.
    expect((createCall!.args.manifest as { type?: string }).type).toBe("context");
  });

  test("initial skills.list fetch is unfiltered by scope", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const listCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "list");
    expect(listCall).toBeDefined();
    expect(listCall!.args.scope).toBeUndefined();
  });
});
