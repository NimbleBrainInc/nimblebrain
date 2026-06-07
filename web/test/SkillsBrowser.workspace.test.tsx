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
    if (server === "skills" && tool === "update") {
      return { structuredContent: { id: args.id }, isError: false };
    }
    if (server === "skills" && tool === "read") {
      // The fixture's editable rule is "workflow" (a `type: skill` with
      // a curated description). The update-path test below relies on
      // this: a hardcoded description: "" or type: "context" on update
      // would silently wipe these values, which is the regression PR
      // QA caught.
      return {
        structuredContent: {
          id: args.id,
          content: "Original body content.",
          layer: 3,
          scope: "workspace",
          source: { path: args.id },
          metadata: {
            name: "workflow",
            description: "Workspace-tier rule.",
            type: "skill",
            priority: 75,
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
    expect(text).toContain("From the system");
    // User-tier skills never appear as a section — only as the
    // personal-footer count.
    expect(text).not.toMatch(/From user/);
  });

  test("personal-skills footer shows the correct count and links to /profile/skills", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("2 personal rules active here");
    const link = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit in your profile"),
    );
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/profile/skills");
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

  test("editing an existing rule does NOT send description or type (would wipe on-disk values)", async () => {
    // CRITICAL regression guard. skills__update is a partial-patch
    // merge: any field present in the manifest is written to disk and
    // overwrites the prior value. Earlier in this PR the UI was sending
    // `{ description: "", type: "context", ... }` identically on create
    // and update — which silently wiped author-curated descriptions and
    // coerced `type: skill` rules into `type: context`, changing
    // Layer-3 loading inference. (It was also self-defeating because
    // the redesigned row's display label IS the description.)
    //
    // The fix at SkillsTab.tsx::handleSubmit splits the manifest by
    // branch: update only carries fields the user explicitly touched
    // via the Advanced expander; create carries the full set.
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));

    // Expand the workspace rule (the "workflow" fixture), wait for the
    // read, then click Edit.
    await act(async () => {
      clickByText(mounted!.container, "Workspace-tier rule.");
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      clickByText(mounted!.container, "Edit");
    });

    // Modify the body so there's a real edit to ship.
    const bodyInput = mounted.container.querySelector("#rule-body") as HTMLTextAreaElement | null;
    expect(bodyInput).not.toBeNull();
    const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window
      .Event;
    await act(async () => {
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setTa?.call(bodyInput, "Edited body content.");
      bodyInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
    });
    await act(async () => {
      clickByText(mounted!.container, "Save");
    });
    await act(async () => {
      await Promise.resolve();
    });

    const updateCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "update");
    expect(updateCall).toBeDefined();
    // The body change goes through.
    expect(updateCall!.args.body).toBe("Edited body content.");
    // THE load-bearing assertions — the manifest patch MUST NOT carry
    // description, type, or name. If any of these appear, the partial
    // patch silently overwrites disk and we're back in the bug.
    const manifest = updateCall!.args.manifest as Record<string, unknown>;
    expect(manifest.description).toBeUndefined();
    expect(manifest.type).toBeUndefined();
    expect(manifest.name).toBeUndefined();
    // `loadingStrategy` is intentionally absent from the LLM-facing
    // schema (schemas/skills.ts ManifestFields). Sending it would be
    // a silent no-op (validator strips it) and was misleading in the
    // UI as a "When to load" override. The dropdown is gone.
    expect(manifest.loadingStrategy).toBeUndefined();
  });

  test("edit-view back arrow returns to the list (not up the route tree)", async () => {
    // CRITICAL regression guard. EditView is component state on
    // SkillsBrowser — when `view === "edit"` the parent returns
    // <EditView /> instead of the list. The URL stays the same.
    //
    // An earlier version of EditView passed
    // `back={{ to: "..", ... }}` to SettingsPageHeader, which renders
    // a <Link to=".."> — a router link that navigates UP one route
    // segment. From /w/:slug/settings/skills that goes to
    // /w/:slug/settings (out of skills); from /profile/skills that
    // goes to /profile/general; from /org/skills it leaves
    // entirely. Each navigation silently discards the form state.
    //
    // The fix routes through SettingsPageHeader's `onBack` prop,
    // which renders a <button> that calls a handler the parent
    // controls (onCancel, which flips view back to "list").
    //
    // This test pins it: open the edit view, click the back arrow,
    // assert the URL is unchanged AND the list view is back.
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));

    await act(async () => {
      clickByText(mounted!.container, "Workspace-tier rule.");
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      clickByText(mounted!.container, "Edit");
    });

    // We're in the edit view now.
    expect(mounted.container.querySelector("#rule-name")).not.toBeNull();

    // Click the back-arrow button (aria-label="Back to skills").
    const backButton = mounted.container.querySelector(
      'button[aria-label="Back to skills"]',
    ) as HTMLButtonElement | null;
    expect(backButton).not.toBeNull();
    await act(async () => {
      backButton!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // List view is back — the "+ Add a rule" affordance only renders
    // on the list, not the edit view.
    const hasAddRule = Array.from(mounted.container.querySelectorAll("button")).some((b) =>
      b.textContent?.includes("+ Add a rule"),
    );
    expect(hasAddRule).toBe(true);
    // And we're NOT still in edit mode — the rule-name input is gone.
    expect(mounted.container.querySelector("#rule-name")).toBeNull();
  });
});
