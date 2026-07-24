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
 *   4. The create form ("+ Add a skill") sends `scope: "workspace"`
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
    loadingStrategy: "always",
    loading: { wouldLoad: true, mechanism: "always" },
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
    toolAffinity: ["mpak__*"],
    loading: { wouldLoad: true, mechanism: "tool_affinity" },
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
    triggers: ["cut a release"],
    loading: { wouldLoad: true, mechanism: "trigger" },
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
    expect(text).toContain("2 personal skills active here");
    const link = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit in your profile"),
    );
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/profile/skills");
  });

  test("submitting + Add a skill sends scope='workspace' regardless of internal state", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
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
    // The typed title doubles as the on-disk description (required non-empty)
    // and the row label; for an always-on rule it's a label, not an activation
    // signal.
    expect((createCall!.args.manifest as { description?: string }).description).toBe("new-ws-rule");
    // A rule is always-on: the UI sends loadingStrategy explicitly so the skill
    // actually loads. The server default ("dynamic") with no triggers/affinity
    // would be catalog-only — it would never load.
    expect((createCall!.args.manifest as { loadingStrategy?: string }).loadingStrategy).toBe(
      "always",
    );
    // The removed `type` field is no longer sent.
    expect((createCall!.args.manifest as { type?: string }).type).toBeUndefined();
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
    // loadingStrategy is set once at create ("always") and is not part of an
    // edit — a rule is always-on by definition, and update only patches the
    // fields the user explicitly touched (priority, body). Sending it here
    // would be a redundant no-op.
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

    // List view is back — the "+ Add a skill" affordance only renders
    // on the list, not the edit view.
    const hasAddRule = Array.from(mounted.container.querySelectorAll("button")).some((b) =>
      b.textContent?.includes("+ Add a skill"),
    );
    expect(hasAddRule).toBe(true);
    // And we're NOT still in edit mode — the rule-name input is gone.
    expect(mounted.container.querySelector("#rule-name")).toBeNull();
  });
});

// ── Figure/ground reground (scene 6) ─────────────────────────────────────
//
// The catalog must read owned-vs-inherited and always-vs-dynamic from the
// resting state alone: owned groups sit on a card surface; inherited groups
// stay ambient text; every row states its loading mechanism under the name;
// scope renders through the palette scope tokens.
describe("SkillsBrowser with surface='workspace' — figure/ground reground", () => {
  test("owned group renders on a card surface; inherited groups stay ambient", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const cards = Array.from(mounted.container.querySelectorAll("section.bg-card"));
    // The workspace group is the operable surface — it's carded.
    expect(cards.some((c) => c.textContent?.includes("From your workspace"))).toBe(true);
    // Inherited groups are ground, not figure — never inside a card.
    const cardedText = cards.map((c) => c.textContent ?? "").join(" ");
    expect(cardedText).not.toContain("From your organization");
    expect(cardedText).not.toContain("From the system");
  });

  test("each row states its loading mechanism at rest, without expanding", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // The always-on workspace rule shows its mechanism in the resting row.
    expect(mounted.container.textContent ?? "").toContain("Always on · every conversation");
  });

  test("a row carries a visible focus indicator, not just a background tint", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const row = Array.from(mounted.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Workspace-tier rule."),
    );
    expect(row).toBeDefined();
    const cls = row?.className ?? "";
    // The tint alone is ~1.05:1 against the card — a keyboard user needs an
    // actual indicator, so the row must never suppress its outline outright.
    expect(cls).not.toContain("focus-visible:outline-none");
    expect(cls).toContain("focus-visible:outline-2");
  });

  test("no per-row scope label — the group heading already names provenance", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // `groupByScope` emits one group per scope, so a row label would be the
    // same word on every row of its group.
    expect(mounted.container.querySelector(".ledger-scope--workspace")).toBeNull();
    expect(mounted.container.querySelector(".ledger-scope--bundle")).toBeNull();
  });

  test("an inherited row still states its mechanism once its group is opened", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // Inherited sections are collapsed at rest; open the org group.
    await act(async () => {
      clickByText(mounted!.container, "From your organization");
    });
    await act(async () => {
      await Promise.resolve();
    });
    const text = mounted.container.textContent ?? "";
    // The org skill is tool-affinity — the mechanism line and its glob show.
    expect(text).toContain("On tool match");
    expect(text).toContain("mpak__*");
    expect(mounted.container.querySelector(".ledger-scope--org")).toBeNull();
  });

  test("expanded skill body is settings sans, not the chat serif voice", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // Expand the workspace rule (its label is the description).
    await act(async () => {
      clickByText(mounted!.container, "Workspace-tier rule.");
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The markdown renders, but never in the chat transcript's serif voice.
    expect(mounted.container.querySelector(".streamdown-container")).not.toBeNull();
    expect(mounted.container.querySelector(".presence-assistant-message")).toBeNull();
  });
});
