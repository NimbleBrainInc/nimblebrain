/**
 * Behavioral tests for `<SkillsBrowser surface="workspace" />` — the workspace
 * vantage of the composition list.
 *
 * The workspace surface owes its user:
 *
 *   1. One list of tiers, agency-first (Yours, You, Organization, System),
 *      with a segment filter derived from the tiers present.
 *   2. No status filter — the per-row On/Off toggle is the enablement control.
 *   3. Personal skills render as a read-only "You" tier that deep-links to the
 *      profile — not a footer count.
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

// Skills the mock has "deleted" — dropped from subsequent list reads so a
// refetch can shrink the tier set (exercises the stale-filter fallback).
const deletedIds = new Set<string>();

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    callToolCalls.push({ server, tool, args });
    if (server === "skills" && tool === "list") {
      return {
        structuredContent: { skills: SKILLS_FIXTURE.filter((s) => !deletedIds.has(s.id)) },
        isError: false,
      };
    }
    if (server === "skills" && tool === "delete") {
      deletedIds.add(args.id as string);
      return { structuredContent: { id: args.id }, isError: false };
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
const { SessionProvider } = await import("../src/context/SessionContext");

/** Wrap an element in a session so `useScopedRole` resolves a real org role. */
function withOrgRole(element: React.ReactElement, orgRole: string): React.ReactElement {
  return React.createElement(
    SessionProvider,
    {
      session: {
        authenticated: true,
        user: { id: "u1", email: "a@b.co", displayName: "A", orgRole },
      },
    },
    element,
  );
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  callToolCalls.length = 0;
  deletedIds.clear();
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

/**
 * A skill's on/off toggle, addressed by accessible name. The toggle is a
 * *sibling* of the row's expander, so it can't be reached by querying inside
 * the expander — and addressing it by name is what a screen-reader user does.
 * Covers both `Toggle` label forms: locked (`<name> — on, managed elsewhere`)
 * and live (`Turn off <name>`).
 */
function toggleFor(container: HTMLElement, skillName: string): HTMLButtonElement | null {
  const match = Array.from(container.querySelectorAll("button")).find((b) => {
    const label = b.getAttribute("aria-label") ?? "";
    return label.startsWith(`${skillName} — `) || label.endsWith(` ${skillName}`);
  });
  return (match as HTMLButtonElement | undefined) ?? null;
}

/** The row expander button carrying `text`. */
function expanderFor(container: HTMLElement, text: string): HTMLButtonElement | null {
  const match = Array.from(container.querySelectorAll("button[aria-expanded]")).find((b) =>
    b.textContent?.includes(text),
  );
  return (match as HTMLButtonElement | undefined) ?? null;
}

describe("SkillsBrowser with surface='workspace' (workspace settings tab)", () => {
  test("does not render a scope filter", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    expect(mounted.container.querySelector('select[aria-label="Filter by scope"]')).toBeNull();
  });

  test("renders every tier of the composition, agency-first", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    // One list, tier dividers from `tierChrome`, ordered agency-first.
    expect(text).toContain("You · follows you everywhere");
    expect(text).toContain("Organization · managed in org settings");
    expect(text).toContain("System · built in");
    // Personal skills are a tier now, never a footer count.
    expect(text).not.toContain("personal skills active here");
  });

  test("personal skills render as a read-only tier that deep-links to the profile", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    // The two personal fixtures are rows in the "You" tier (their descriptions).
    expect(text).toContain("Personal skill A.");
    expect(text).toContain("Personal skill B.");
    // …and the tier points at where they're edited.
    const link = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit in your profile"),
    );
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/profile/skills");
  });

  test("org tier's manage link is hidden from non-org-admins (the guarded route dead-ends)", async () => {
    // Default mount has no session → role "none", so the org deep link, which
    // would bounce off the org-admin route guard, must not render.
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    // The tier still reads correctly without the link.
    expect(text).toContain("Organization · managed in org settings");
    const orgLink = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Manage in org settings"),
    );
    expect(orgLink).toBeUndefined();
  });

  test("org tier deep-links org admins to /org/skills", async () => {
    mounted = await mount(
      withOrgRole(React.createElement(SkillsBrowser, { surface: "workspace" }), "admin"),
    );
    const orgLink = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Manage in org settings"),
    );
    expect(orgLink).toBeDefined();
    expect(orgLink?.getAttribute("href")).toBe("/org/skills");
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

// ── Composition list (Variant C) ─────────────────────────────────────────
//
// One list, one row grammar: every tier — the scope you edit and the read-only
// context around it — sits in a single card. Tiers, the segment filter, and
// each row's editability derive from the data.
describe("SkillsBrowser with surface='workspace' — composition list", () => {
  test("all tiers live in one card, not a card per group", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const cards = Array.from(mounted.container.querySelectorAll("div.bg-card"));
    const holder = cards.find((c) => c.textContent?.includes("System · built in"));
    expect(holder).toBeDefined();
    // One surface carries every tier.
    expect(holder?.textContent).toContain("You · follows you everywhere");
    expect(holder?.textContent).toContain("Organization · managed in org settings");
    // Tier dividers are headings, so they stay reachable by heading navigation.
    const tierHeadings = Array.from(holder?.querySelectorAll("h3") ?? []).map((h) =>
      h.textContent?.trim(),
    );
    expect(tierHeadings).toContain("System · built in");
    expect(tierHeadings.length).toBeGreaterThanOrEqual(4);
  });

  test("a segment chip is derived for every present tier, agency-first", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const chips = Array.from(mounted.container.querySelectorAll("button[aria-pressed]")).map((b) =>
      b.textContent?.trim(),
    );
    expect(chips).toEqual(["All", "Yours", "You", "Org", "System"]);
  });

  test("each row states its loading mechanism at rest, without expanding", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Always on · every conversation");
    // The org tier is visible at rest, so its tool-affinity row renders the
    // mechanism's mono glob branch (`<span className="font-mono">`) too.
    expect(text).toContain("On tool match");
    expect(text).toContain("mpak__*");
  });

  test("scope renders as a token-driven tick, never a ledger label or raw hex", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // The tick references the palette scope token as a CSS var.
    expect(mounted.container.querySelector('[style*="--scope-workspace"]')).not.toBeNull();
    expect(mounted.container.querySelector('[style*="--scope-user"]')).not.toBeNull();
    // The in-chat ledger's label classes never leak into the catalog.
    expect(mounted.container.querySelector(".ledger-scope--workspace")).toBeNull();
  });

  test("only the editable tier can toggle; context tiers are locked", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // The toggle is a sibling of the row's expander, so it's addressed by its
    // accessible name rather than by nesting.
    expect(toggleFor(mounted.container, "bundle-skill")?.disabled).toBe(true);
    expect(toggleFor(mounted.container, "workflow")?.disabled).toBeFalsy();
  });

  test("no control in a row is nested inside another control", async () => {
    // `button` takes no interactive descendants. Nesting left the toggle's
    // exposure to AT undefined and made toggle-vs-expand rest on
    // `stopPropagation`; siblings make the separation structural.
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    expect(mounted.container.querySelectorAll("button button").length).toBe(0);
    expect(mounted.container.querySelectorAll("button a, a button").length).toBe(0);
  });

  test("toggling a skill does not expand its row", async () => {
    // The behavioral half of the nesting fix: with the controls as siblings
    // this holds structurally, so it must stay true without `stopPropagation`.
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const expander = expanderFor(mounted.container, "Workspace-tier rule.");
    expect(expander?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      toggleFor(mounted!.container, "workflow")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The toggle fired...
    const toggleCall = callToolCalls.find(
      (c) => c.server === "skills" && (c.tool === "activate" || c.tool === "deactivate"),
    );
    expect(toggleCall).toBeDefined();
    // ...and the row stayed collapsed.
    expect(
      expanderFor(mounted.container, "Workspace-tier rule.")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("the segment filter narrows the list to a single tier", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    expect(mounted.container.textContent ?? "").toContain("Workspace-tier rule.");
    await act(async () => {
      const sys = Array.from(mounted!.container.querySelectorAll("button[aria-pressed]")).find(
        (b) => b.textContent?.trim() === "System",
      ) as HTMLButtonElement | undefined;
      sys?.click();
    });
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("System · built in");
    // The other tiers' rows drop out of the DOM behind the filter.
    expect(text).not.toContain("Workspace-tier rule.");
    expect(text).not.toContain("Personal skill A.");
  });

  test("creating a skill clears an active filter so the new skill is visible", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // Filter to a tier that holds no workspace skills, so a new one would be
    // hidden without the reset.
    await act(async () => {
      const sys = Array.from(mounted!.container.querySelectorAll("button[aria-pressed]")).find(
        (b) => b.textContent?.trim() === "System",
      ) as HTMLButtonElement | undefined;
      sys?.click();
    });
    expect(mounted.container.textContent ?? "").not.toContain("Workspace-tier rule.");

    await act(async () => {
      clickByText(mounted!.container, "+ Add a skill");
    });
    const nameInput = mounted.container.querySelector("#rule-name") as HTMLInputElement | null;
    const bodyInput = mounted.container.querySelector("#rule-body") as HTMLTextAreaElement | null;
    const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
    await act(async () => {
      const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setVal?.call(nameInput, "brand-new");
      nameInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setTa?.call(bodyInput, "A new workspace skill.");
      bodyInput!.dispatchEvent(new WindowEvent("input", { bubbles: true }));
    });
    await act(async () => {
      clickByText(mounted!.container, "Save");
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The filter reset to All, so the workspace tier is visible again.
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Workspace-tier rule.");
    const allChip = Array.from(mounted.container.querySelectorAll("button[aria-pressed]")).find(
      (b) => b.textContent?.trim() === "All",
    );
    expect(allChip?.getAttribute("aria-pressed")).toBe("true");
  });

  test("deleting the filtered tier's last skill recovers the list to All", async () => {
    const realConfirm = (globalThis as unknown as { window: { confirm?: () => boolean } }).window
      .confirm;
    (globalThis as unknown as { window: { confirm: () => boolean } }).window.confirm = () => true;
    try {
      mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
      // Filter to "Yours" — one deletable skill; deleting it empties the tier.
      await act(async () => {
        const yours = Array.from(mounted!.container.querySelectorAll("button[aria-pressed]")).find(
          (b) => b.textContent?.trim() === "Yours",
        ) as HTMLButtonElement | undefined;
        yours?.click();
      });
      expect(mounted.container.textContent ?? "").not.toContain("Personal skill A.");

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
        clickByText(mounted!.container, "Delete");
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // The workspace tier is gone; the filter must fall back to All rather than
      // strand the user on an empty filtered view.
      const text = mounted.container.textContent ?? "";
      expect(text).not.toContain("Workspace-tier rule.");
      expect(text).toContain("Personal skill A.");
    } finally {
      (globalThis as unknown as { window: { confirm?: () => boolean } }).window.confirm =
        realConfirm;
    }
  });

  test("a row carries a visible focus indicator, not just a background tint", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const row = Array.from(mounted.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Workspace-tier rule."),
    );
    const cls = row?.className ?? "";
    // The focus tint alone is ~1.05:1 against the card — a keyboard user needs a
    // real indicator, so the row must never suppress its outline.
    expect(cls).not.toContain("focus-visible:outline-none");
    expect(cls).toContain("focus-visible:outline-2");
  });

  test("the row button points aria-controls at the region it expands", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const row = Array.from(mounted.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Workspace-tier rule."),
    );
    const controls = row?.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    // The id must resolve — aria-controls pointing at nothing is worse than
    // omitting it, since AT announces a target that isn't there.
    expect(mounted.container.querySelector(`#${CSS.escape(controls as string)}`)).not.toBeNull();
  });

  test("expanded skill body is settings sans, not the chat serif voice", async () => {
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
    expect(mounted.container.querySelector(".streamdown-container")).not.toBeNull();
    expect(mounted.container.querySelector(".presence-assistant-message")).toBeNull();
  });
});
