// ---------------------------------------------------------------------------
// Skills on Plugins — the Installed tab's Skills group, a skill's page, and
// writing a new one from Browse.
//
// The group lists the skills people wrote (the workspace's, the viewer's own,
// the org's) with whose each is, and never one that came with a plugin. A
// skill's page edits under the server's write rules: a workspace skill needs
// workspace write, the viewer's own is theirs, an org skill is read-only here.
// A new skill asks whom it is for, and only a writer may pick everyone.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { SkillSummary } from "../_generated/platform-schemas/skills";
import type * as ApiClient from "../api/client";
import type { ToolCallResponse } from "../types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";

function summary(over: Partial<SkillSummary> & Pick<SkillSummary, "name" | "scope">): SkillSummary {
  return {
    id: `/work/${over.scope}/${over.name}/SKILL.md`,
    layer: 3,
    status: "active",
    tokens: 40,
    source: { path: `/work/${over.scope}/${over.name}/SKILL.md` },
    loadingStrategy: "always",
    loading: { mechanism: "always" },
    ...over,
  };
}

const WORKSPACE_SKILL = summary({
  name: "house-style",
  scope: "workspace",
  description: "How we write",
});
const USER_SKILL = summary({
  name: "my-voice",
  scope: "user",
  description: "My voice",
  loadingStrategy: "dynamic",
  toolAffinity: ["docs__*"],
  loading: { mechanism: "tool_affinity" },
});
const ORG_SKILL = summary({ name: "policy", scope: "org", description: "Org policy" });
const PROVIDED_SKILL = summary({ name: "authoring-guide", scope: "provided" });
const CONNECTOR_SKILL = summary({
  name: "connector:github:usage",
  scope: "provided",
  source: { connector: "github", uri: "skill://github/usage" },
});

let skills: SkillSummary[] = [];

function ok(structuredContent: Record<string, unknown>): ToolCallResponse {
  return { content: [{ type: "text", text: "" }], structuredContent, isError: false };
}

function answer(tool: string, args: Record<string, unknown> | undefined): ToolCallResponse {
  if (tool === "list") return ok({ skills });
  if (tool === "read") {
    const s = skills.find((k) => k.id === args?.id)!;
    return ok({
      id: s.id,
      content: `Body of ${s.name}`,
      layer: 3,
      scope: s.scope,
      source: s.source,
      metadata: { name: s.name, description: s.description, loadingStrategy: s.loadingStrategy },
    });
  }
  if (tool === "create") {
    const manifest = args?.manifest as { name: string };
    return ok({ id: "/new", name: manifest.name, scope: String(args?.scope) });
  }
  return ok({ id: String(args?.id ?? ""), name: "x", scope: "x" });
}

const callTool = mock<typeof ApiClient.callTool>(async (_server, tool, args) =>
  answer(tool, args as Record<string, unknown> | undefined),
);
const callToolWithoutWorkspace = mock<typeof ApiClient.callToolWithoutWorkspace>(
  async (_server, tool, args) => answer(tool, args as Record<string, unknown> | undefined),
);
const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins: [] }));
const listDirectory = mock(async () => ({ entries: [], errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed: [] }));

mock.module("../api/client", () => ({
  ...realClient,
  callTool,
  callToolWithoutWorkspace,
  listPlugins,
  listDirectory,
  getInstalledConnectors,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { NoticeProvider } = await import("../components/notices");
const { toSlug } = await import("../lib/workspace-slug");
const { PluginsPage } = await import("../pages/PluginsPage");
const { NewSkillPage, SkillPage } = await import("../pages/SkillPage");

const SLUG = toSlug(WS_ID);

let location = "";
function LocationProbe() {
  const loc = useLocation();
  location = loc.pathname + loc.search;
  return null;
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  skills = [WORKSPACE_SKILL, USER_SKILL, ORG_SKILL, PROVIDED_SKILL, CONNECTOR_SKILL];
  callTool.mockClear();
  callToolWithoutWorkspace.mockClear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function mount(path: string, role: "admin" | "member" = "admin"): Promise<Mounted> {
  const workspace = { id: WS_ID, name: "Helix", memberCount: 2, connectorCount: 0, userRole: role };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <NoticeProvider>
        <WorkspaceProvider initialWorkspaces={[workspace]} initialActiveId={WS_ID}>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
            <Routes>
              <Route path="/w/:slug/plugins" element={<PluginsPage />} />
              <Route path="/w/:slug/plugins/skills/new" element={<NewSkillPage />} />
              <Route path="/w/:slug/plugins/skills/:scope/:name" element={<SkillPage />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </NoticeProvider>,
    );
  });
  await settle();
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function rows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="skill-row"]')].map(
    (r) => `${r.getAttribute("data-skill-scope")}/${r.getAttribute("data-skill-name")}`,
  );
}

function rowFor(container: HTMLElement, name: string): HTMLElement | null {
  return container.querySelector(`[data-skill-name="${name}"]`);
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function fillNewSkill(container: HTMLElement): Promise<void> {
  await type(container.querySelector<HTMLInputElement>("#rule-name")!, "Release notes");
  await type(container.querySelector<HTMLTextAreaElement>("#rule-body")!, "Lead with the change.");
}

function calls(fn: typeof callTool | typeof callToolWithoutWorkspace, tool: string) {
  return fn.mock.calls.filter((c) => c[1] === tool);
}

describe("Installed — the Skills group", () => {
  test("lists the workspace's, the viewer's, and the org's skills, and none from a plugin", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    expect(rows(mounted.container)).toEqual([
      "workspace/house-style",
      "user/my-voice",
      "org/policy",
    ]);
    expect(calls(callTool, "list")[0]?.[3]).toEqual({ workspaceId: WS_ID });
    expect(mounted.container.textContent).toContain(
      "Skills that come with a plugin are on that plugin's page.",
    );
  });

  test("each row says whose it is and how it loads", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    const badge = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector('[data-testid="skill-scope-badge"]')
        ?.textContent;
    expect(badge("house-style")).toBe("Workspace");
    expect(badge("my-voice")).toBe("Yours");
    expect(badge("policy")).toBe("Org");
    const facts = rowFor(mounted.container, "my-voice")?.querySelector(
      '[data-testid="skill-facts"]',
    )?.textContent;
    expect(facts).toBe("My voice · On tool match docs__*");
  });

  test("rows link to each skill's page by scope and name", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    const href = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector("a")?.getAttribute("href");
    expect(href("house-style")).toBe(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    expect(href("my-voice")).toBe(`/w/${SLUG}/plugins/skills/user/my-voice`);
  });
});

describe("A skill's page", () => {
  test("a workspace admin edits a workspace skill, saving in this workspace", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    const body = mounted.container.querySelector<HTMLTextAreaElement>("#rule-body");
    expect(body?.value).toBe("Body of house-style");
    expect(button(mounted.container, "Delete skill")).toBeDefined();

    await click(mounted.container.querySelector('button[aria-label="Turn off house-style"]'));
    const status = calls(callTool, "set_status")[0];
    expect(status?.[2]).toEqual({ id: WORKSPACE_SKILL.id, status: "disabled" });
    expect(status?.[3]).toEqual({ workspaceId: WS_ID });
  });

  test("a member reads a workspace skill without editing it", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`, "member");
    expect(mounted.container.querySelector("#rule-body")).toBeNull();
    expect(mounted.container.querySelector('[data-testid="skill-read-only"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain("Workspace admins can change it.");
    expect(button(mounted.container, "Delete skill")).toBeUndefined();
  });

  test("a member edits their own skill, which is written with no workspace", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/user/my-voice`, "member");
    expect(mounted.container.querySelector("#rule-body")).not.toBeNull();
    await click(mounted.container.querySelector('button[aria-label="Turn off my-voice"]'));
    expect(calls(callToolWithoutWorkspace, "set_status")).toHaveLength(1);
    expect(calls(callTool, "set_status")).toHaveLength(0);
  });

  test("an org skill is read-only here, even for a workspace admin", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/org/policy`, "admin");
    expect(mounted.container.querySelector("#rule-body")).toBeNull();
    expect(mounted.container.textContent).toContain("Body of policy");
    expect(mounted.container.textContent).toContain("Org admins change it in org settings.");
  });

  test("a skill that came with a plugin has no page here", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/provided/authoring-guide`);
    expect(mounted.container.textContent).toContain("This skill is not in this workspace.");
  });
});

describe("Writing a skill", () => {
  test("Browse offers Write a skill, which opens the new skill page", async () => {
    mounted = await mount(`/w/${SLUG}/plugins?tab=browse`);
    await click(button(mounted.container, "Write a skill"));
    expect(location).toBe(`/w/${SLUG}/plugins/skills/new`);
  });

  test("Just me writes a skill of the viewer's own, with no workspace", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/new`, "admin");
    await fillNewSkill(mounted.container);
    await click(button(mounted.container, "Create"));
    const create = calls(callToolWithoutWorkspace, "create")[0];
    expect((create?.[2] as { scope: string } | undefined)?.scope).toBe("user");
    expect(calls(callTool, "create")).toHaveLength(0);
    expect(location).toBe(`/w/${SLUG}/plugins/skills/user/release-notes`);
  });

  test("Everyone here writes a workspace skill in this workspace", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/new`, "admin");
    await click(mounted.container.querySelector('input[value="workspace"]'));
    await fillNewSkill(mounted.container);
    await click(button(mounted.container, "Create"));
    const create = calls(callTool, "create")[0];
    expect((create?.[2] as { scope: string } | undefined)?.scope).toBe("workspace");
    expect(create?.[3]).toEqual({ workspaceId: WS_ID });
    expect(location).toBe(`/w/${SLUG}/plugins/skills/workspace/release-notes`);
  });

  test("a member is not offered Everyone here", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/new`, "member");
    expect(mounted.container.querySelector('input[value="workspace"]')).toBeNull();
    expect(mounted.container.textContent).toContain(
      "A workspace admin can write a skill for everyone in Helix.",
    );
  });
});
