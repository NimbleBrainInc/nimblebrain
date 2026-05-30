/**
 * Behavioral tests for `<SkillsBrowser surface="workspace" />` — the
 * grouped workspace-tab layout (Phase 2 of SKILLS_SURFACE.md).
 *
 * What this surface owes its user:
 *
 *   1. Scope filter is hidden (sections are the partition; no filter UI).
 *   2. The list groups by scope in the order: workspace, inherited org,
 *      inherited bundles. User-tier skills are NOT a section — they
 *      surface only as a count in the personal footer.
 *   3. The create form is locked to scope="workspace" (Phase 2's key
 *      regression risk — the spec calls this out as the load-bearing
 *      assertion for the workspace surface, mirror of Phase 1's same
 *      assertion for the org surface).
 *   4. A personal-skills footer renders with the user-tier count and a
 *      deep-link to `/profile` (Phase 3 promotes to `/profile/skills`).
 *
 * The role-gate test (orgRoleGate.test.ts) and the org-surface test
 * (SkillsBrowser.org.test.tsx) cover the org-admin surface separately.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Patch globals happy-dom forgets on its Window stub. See
// SkillsBrowser.org.test.tsx for the rationale; same fix.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

type CallToolArgs = {
  server: string;
  tool: string;
  args: Record<string, unknown>;
};
const callToolCalls: CallToolArgs[] = [];

// Skills list fixture spanning all four scopes — the workspace surface
// has to partition them in the renderer rather than fetch-filter, so the
// test catalog has to include every scope at once.
const SKILLS_FIXTURE = [
  {
    id: "/tmp/skills/ws/workflow.md",
    name: "workflow",
    description: "Workspace-tier rule",
    scope: "workspace",
    layer: 3,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 100,
  },
  {
    id: "/tmp/skills/org/voice.md",
    name: "voice",
    description: "Org-tier voice rules",
    scope: "org",
    layer: 3,
    status: "active",
    type: "context",
    priority: 30,
    tokens: 50,
  },
  {
    id: "skill://bundle/usage",
    name: "bundle-skill",
    description: "Bundle (Layer 1)",
    scope: "bundle",
    layer: 1,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 80,
  },
  {
    id: "/tmp/skills/user/personal-1.md",
    name: "personal-1",
    description: "Personal skill A",
    scope: "user",
    layer: 3,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 25,
  },
  {
    id: "/tmp/skills/user/personal-2.md",
    name: "personal-2",
    description: "Personal skill B",
    scope: "user",
    layer: 3,
    status: "active",
    type: "skill",
    priority: 50,
    tokens: 35,
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
      return {
        structuredContent: { id: "/tmp/skills/ws/test-skill.md" },
        isError: false,
      };
    }
    if (server === "skills" && tool === "read") {
      // Return the org-tier skill body for any read — tests assert
      // the read-only treatment for inherited rows, not the body itself.
      return {
        structuredContent: {
          id: args.id,
          content: "## Org voice rules\n\nUse plain English.",
          layer: 3,
          scope: "org",
          source: { path: "/tmp/skills/org/voice.md" },
          metadata: {
            name: "voice",
            description: "Org-tier voice rules",
            type: "context",
            priority: 30,
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

function clickButtonByText(container: HTMLElement, text: string): boolean {
  for (const el of Array.from(container.querySelectorAll("button"))) {
    if (el.textContent?.includes(text)) {
      el.click();
      return true;
    }
  }
  return false;
}

function sectionHeaders(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("h3")).map((el) => el.textContent?.trim() ?? "");
}

describe("SkillsBrowser with surface='workspace' (the /w/:slug/settings/skills surface)", () => {
  test("does not render the scope filter selector", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const filterSelect = mounted.container.querySelector('select[aria-label="Filter by scope"]');
    expect(filterSelect).toBeNull();
    // Status filter still renders — it's orthogonal.
    const statusSelect = mounted.container.querySelector('select[aria-label="Filter by status"]');
    expect(statusSelect).not.toBeNull();
  });

  test("renders workspace, inherited-org, and inherited-bundles sections (no user section)", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const headers = sectionHeaders(mounted.container);
    const joined = headers.join(" | ");
    expect(joined).toContain("Workspace");
    expect(joined).toContain("Inherited from organization");
    expect(joined).toContain("Inherited from bundles");
    // User-tier section MUST NOT render — personal skills surface only
    // as the footer count, not as an editable section.
    expect(joined).not.toContain("User");
    // Section order: workspace before inherited-org before inherited-bundles.
    const wsIdx = headers.findIndex((h) => h.startsWith("Workspace"));
    const orgIdx = headers.findIndex((h) => h.startsWith("Inherited from organization"));
    const bundleIdx = headers.findIndex((h) => h.startsWith("Inherited from bundles"));
    expect(wsIdx).toBeGreaterThan(-1);
    expect(orgIdx).toBeGreaterThan(wsIdx);
    expect(bundleIdx).toBeGreaterThan(orgIdx);
  });

  test("personal-skills footer shows the correct count and links to /profile", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    // Fixture has 2 user-tier skills.
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("2 personal skills active here");
    const link = Array.from(mounted.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Edit in profile"),
    );
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/profile");
  });

  test("create form is locked to scope='workspace'", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    await act(async () => {
      clickButtonByText(mounted!.container, "New skill");
    });
    // Scope picker MUST NOT render.
    expect(mounted.container.querySelector("#skill-scope")).toBeNull();
    // Fill name + submit.
    const nameInput = mounted.container.querySelector("#skill-name") as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(nameInput, "new-ws-skill");
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
    // THE load-bearing assertion: regardless of internal form state, the
    // workspace surface submits scope: "workspace". If a future edit
    // drops the lock-default in `useState<WritableScope>(lockedScope ??
    // "workspace")`, the server's checkPathAccess can't catch an admin
    // authoring into the wrong scope. Test pins what the gate can't.
    expect(createCall!.args.scope).toBe("workspace");
    expect((createCall!.args.manifest as { name?: string }).name).toBe("new-ws-skill");
  });

  test("initial skills.list fetch is unfiltered (the renderer partitions)", async () => {
    mounted = await mount(React.createElement(SkillsBrowser, { surface: "workspace" }));
    const listCall = callToolCalls.find((c) => c.server === "skills" && c.tool === "list");
    expect(listCall).toBeDefined();
    // No scope on the args — the workspace surface needs every scope in
    // one fetch so the inherited sections and the personal-footer count
    // are accurate. Status filter still applies ("active" default).
    expect(listCall!.args.scope).toBeUndefined();
    expect(listCall!.args.status).toBe("active");
  });
});
