// ---------------------------------------------------------------------------
// Skills — the Skills page, a skill's page, and writing a new one.
//
// Skills lists the skills people wrote, split Workspace (the workspace's and
// the org's, an org skill tagged) | Personal (the viewer's own, each with On
// here), and beneath them, muted, the skills that came with the segment's
// plugins, each opening its plugin. A skill's page edits under the server's
// write rules: a workspace skill needs workspace write, the viewer's own is
// theirs, an org skill is read-only here. A new skill asks whom it is for, and
// only a writer may pick everyone. Skill pages under Plugins' old addresses
// land on the same page under Skills.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
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
/** A write tool the server refuses this test, if any. */
let refuse: string | null = null;

const PRECEDENCE: Record<string, number> = { provided: 0, org: 0, workspace: 1, user: 2 };

/**
 * `skills__list` as the server answers it: a scope filter lists that tier
 * whole; with none, tiers merge by name, the viewer's own winning.
 */
function listed(scope: unknown): SkillSummary[] {
  if (typeof scope === "string") return skills.filter((s) => s.scope === scope);
  const byName = new Map<string, SkillSummary>();
  for (const s of [...skills].sort((a, b) => PRECEDENCE[a.scope]! - PRECEDENCE[b.scope]!)) {
    byName.set(s.name, s);
  }
  return [...byName.values()];
}

function ok(structuredContent: Record<string, unknown>): ToolCallResponse {
  return { content: [{ type: "text", text: "" }], structuredContent, isError: false };
}

function answer(tool: string, args: Record<string, unknown> | undefined): ToolCallResponse {
  if (tool === "list") return ok({ skills: listed(args?.scope) });
  if (tool === refuse) {
    return { content: [{ type: "text", text: `Refused ${tool}` }], isError: true };
  }
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
let plugins: Plugin[] = [];
const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins }));
const listConnectorSkills = mock<typeof ApiClient.listConnectorSkills>(async () => ({
  overlays: [],
  published: [],
}));
const listDirectory = mock(async () => ({ entries: [], errors: [] }));
const listPersonalConnectors = mock<typeof ApiClient.listPersonalConnectors>(async () => ({
  connectors: [],
}));
const getInstalledConnectors = mock(async () => ({ installed: [] }));
/** How `skills__set_here` answers this test; it saves what it is sent by default. */
const setSkillOnHere = mock<typeof ApiClient.setSkillOnHere>(async (workspaceId, id, on) => ({
  id,
  name: skills.find((s) => s.id === id)?.name ?? "",
  workspaceId,
  onHere: on,
}));

mock.module("../api/client", () => ({
  ...realClient,
  callTool,
  callToolWithoutWorkspace,
  listPlugins,
  listConnectorSkills,
  listDirectory,
  listPersonalConnectors,
  getInstalledConnectors,
  setSkillOnHere,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { NoticeProvider, NoticeViewport } = await import("../components/notices");
const { toSlug } = await import("../lib/workspace-slug");
const { SkillsPage } = await import("../pages/SkillsPage");
const { NewSkillPage, SkillPage } = await import("../pages/SkillPage");
const { OldSkillAddressRedirect } = await import("../pages/PluginsRedirects");

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
  setSkillOnHere.mockClear();
  setSkillOnHere.mockImplementation(async (workspaceId, id, on) => ({
    id,
    name: skills.find((s) => s.id === id)?.name ?? "",
    workspaceId,
    onHere: on,
  }));
  refuse = null;
  plugins = [];
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
              <Route path="/w/:slug/skills" element={<SkillsPage />} />
              <Route path="/w/:slug/skills/new" element={<NewSkillPage />} />
              <Route path="/w/:slug/skills/:scope/:name" element={<SkillPage />} />
              <Route path="/w/:slug/plugins/skills/*" element={<OldSkillAddressRedirect />} />
              <Route path="/w/:slug/plugins/:pluginRef" element={<p>plugin page</p>} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
        <NoticeViewport />
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

async function blur(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  await settle();
}

async function editBody(container: HTMLElement, value: string): Promise<void> {
  const body = container.querySelector<HTMLTextAreaElement>("#rule-body")!;
  await type(body, value);
  await blur(body);
}

/** Answer the delete confirmation with `answer` for the rest of the test. */
function confirmWith(answer: boolean): void {
  window.confirm = () => answer;
}

function calls(fn: typeof callTool | typeof callToolWithoutWorkspace, tool: string) {
  return fn.mock.calls.filter((c) => c[1] === tool);
}

function segment(container: HTMLElement, id: "workspace" | "personal"): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-segment="${id}"]`)!;
}

/** Skills, on the Personal segment. */
async function mountPersonal(): Promise<Mounted> {
  const m = await mount(`/w/${SLUG}/skills`);
  await click(segment(m.container, "personal"));
  return m;
}

function plugin(over: Partial<Plugin> & Pick<Plugin, "id" | "displayName" | "owner">): Plugin {
  const serverName = over.id.split(":")[1] ?? over.id;
  return {
    granted: true,
    servers: [{ serverName, status: "ready", account: null }],
    skills: [],
    apps: [],
    ...over,
  };
}

describe("Skills page", () => {
  test("is titled Skills, with New skill as its one action", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    expect(mounted.container.querySelector("h1")?.textContent).toBe("Skills");
    const header = mounted.container.querySelector('[data-testid="list-page-header"]')!;
    expect([...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(
      ["New skill"],
    );
    await click(header.querySelector("button"));
    expect(location).toBe(`/w/${SLUG}/skills/new`);
  });

  test("Workspace lists the workspace's and the org's; Personal the viewer's; none from a plugin", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    expect(segment(mounted.container, "workspace").textContent).toBe("Workspace2");
    expect(segment(mounted.container, "personal").textContent).toBe("Personal1");
    expect(rows(mounted.container)).toEqual(["workspace/house-style", "org/policy"]);
    expect(calls(callTool, "list")[0]?.[3]).toEqual({ workspaceId: WS_ID });
    await click(segment(mounted.container, "personal"));
    expect(rows(mounted.container)).toEqual(["user/my-voice"]);
    expect(mounted.container.textContent).not.toContain("plugin's page");
  });

  test("each row says how it loads, and an org skill is tagged", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    const tag = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector('[data-testid="skill-org-tag"]')?.textContent;
    expect(tag("policy")).toBe("Org");
    expect(tag("house-style")).toBeUndefined();
    await click(segment(mounted.container, "personal"));
    expect(tag("my-voice")).toBeUndefined();
    const facts = rowFor(mounted.container, "my-voice")?.querySelector(
      '[data-testid="skill-facts"]',
    )?.textContent;
    // No plugin answers docs__*, and the pattern itself is never listed.
    expect(facts).toBe("When a matching tool is used");
  });

  test("a tool pattern is named by the plugin it reaches, personal or the workspace's", async () => {
    plugins = [
      plugin({
        id: "person:com-google-calendar-mcp",
        displayName: "Google Calendar",
        owner: { kind: "person" },
      }),
      plugin({ id: "workspace:gmail", displayName: "Gmail", owner: { kind: "workspace" } }),
      plugin({ id: "workspace:slack", displayName: "Slack", owner: { kind: "workspace" } }),
    ];
    skills = [
      summary({
        name: "calendar",
        scope: "user",
        loadingStrategy: "dynamic",
        toolAffinity: ["my_com-google-calendar-mcp__*"],
        loading: { mechanism: "tool_affinity" },
      }),
      summary({
        name: "mail-and-chat",
        scope: "user",
        loadingStrategy: "dynamic",
        toolAffinity: ["gmail__send", "slack__*"],
        loading: { mechanism: "tool_affinity" },
      }),
    ];
    mounted = await mountPersonal();
    const facts = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector('[data-testid="skill-facts"]')?.textContent;
    expect(facts("calendar")).toBe("When Google Calendar is used");
    expect(facts("mail-and-chat")).toBe("When Gmail or Slack is used");
    expect(mounted.container.textContent).not.toContain("__");
  });

  test("a skill loaded only when the agent asks says nothing about loading; always and triggers do", async () => {
    skills = [
      summary({
        name: "asked",
        scope: "workspace",
        loadingStrategy: "dynamic",
        loading: { mechanism: "on_request" },
      }),
      summary({
        name: "deployer",
        scope: "workspace",
        loadingStrategy: "dynamic",
        triggers: ["deploy"],
        loading: { mechanism: "trigger" },
      }),
      WORKSPACE_SKILL,
    ];
    mounted = await mount(`/w/${SLUG}/skills`);
    const facts = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector('[data-testid="skill-facts"]')?.textContent;
    expect(facts("asked")).toBeUndefined();
    expect(mounted.container.textContent).not.toContain("When the agent asks for it");
    expect(facts("deployer")).toBe('On trigger "deploy"');
    expect(facts("house-style")).toBe("Always on");
  });

  test("rows link to each skill's page by scope and name", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    const href = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector("a")?.getAttribute("href");
    expect(href("house-style")).toBe(`/w/${SLUG}/skills/workspace/house-style`);
    await click(segment(mounted.container, "personal"));
    expect(href("my-voice")).toBe(`/w/${SLUG}/skills/user/my-voice`);
  });

  test("a row has no menu: its link opens the skill, and its › is decorative", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    const r = rowFor(mounted.container, "house-style")!;
    expect(r.querySelectorAll("button")).toHaveLength(0);
    expect(r.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(r.querySelector("svg:last-child")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("a workspace skill named like one of the viewer's own is listed in each segment", async () => {
    skills = [WORKSPACE_SKILL, summary({ name: "house-style", scope: "user" })];
    mounted = await mount(`/w/${SLUG}/skills`);
    expect(rows(mounted.container)).toEqual(["workspace/house-style"]);
    await click(segment(mounted.container, "personal"));
    expect(rows(mounted.container)).toEqual(["user/house-style"]);
  });

  test("search narrows the segment, and says when nothing matches", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="list-search"]')!;
    await type(input, "org policy");
    await settle();
    expect(rows(mounted.container)).toEqual(["org/policy"]);
    await type(input, "zzz");
    await settle();
    expect(mounted.container.querySelector('[data-testid="list-empty"]')?.textContent).toBe(
      'No skills match "zzz".',
    );
  });

  test("From your plugins lists each plugin's skills with when it loads, opening the plugin", async () => {
    plugins = [
      plugin({
        id: "workspace:notion",
        displayName: "Notion",
        owner: { kind: "workspace" },
        skills: [{ name: "notion-pages", kind: "overlay", serverName: "notion" }],
      }),
      plugin({
        id: "person:slack",
        displayName: "Slack",
        owner: { kind: "person" },
        skills: [{ name: "slack-threads", kind: "published", serverName: "slack" }],
      }),
      plugin({
        id: "person:granola",
        displayName: "Granola",
        owner: { kind: "person" },
        granted: false,
        skills: [{ name: "granola-notes", kind: "overlay", serverName: "granola" }],
      }),
    ];
    listConnectorSkills.mockImplementation(async () => ({
      overlays: [],
      published: [
        {
          server: "slack",
          name: "slack-threads",
          description: "Threads",
          uri: "skill://slack/threads",
          priority: 50,
          loadingStrategy: "dynamic",
          mechanism: "tool_affinity",
          toolAffinity: ["slack__*"],
        } as Awaited<ReturnType<typeof ApiClient.listConnectorSkills>>["published"][number],
      ],
    }));
    mounted = await mount(`/w/${SLUG}/skills`);
    const group = () =>
      mounted!.container.querySelector<HTMLElement>('[data-testid="skills-from-plugins"]');
    expect(group()?.querySelector("h2")?.textContent).toBe("From your plugins");
    const names = () =>
      [...(group()?.querySelectorAll('[data-testid="plugin-skill-row"]') ?? [])].map((r) =>
        r.getAttribute("data-skill-name"),
      );
    expect(names()).toEqual(["notion-pages"]);
    const notion = group()!.querySelector('[data-skill-name="notion-pages"]')!;
    const line = (row: Element) =>
      row.querySelector('[data-testid="plugin-skill-line"]')?.textContent;
    // The plugin is named once: the line that says when it loads names it.
    expect(line(notion)).toBe("When Notion is used");
    expect(notion.querySelector("a")?.getAttribute("href")).toBe(
      `/w/${SLUG}/plugins/workspace%3Anotion`,
    );

    await click(segment(mounted.container, "personal"));
    // A plugin not on here brings nothing here.
    expect(names()).toEqual(["slack-threads"]);
    expect(line(group()!.querySelector('[data-skill-name="slack-threads"]')!)).toBe(
      "When Slack is used",
    );
    // The group is no skill people wrote, so it carries no On here.
    expect(group()!.querySelector('[data-testid="skill-on-here"]')).toBeNull();
  });

  test("with no plugin skills, the group is absent", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    expect(mounted.container.querySelector('[data-testid="skills-from-plugins"]')).toBeNull();
  });

  test("on a narrow column the header action is an icon and rows stack their name and facts", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    const action = mounted.container.querySelector('[data-testid="skills-new"]')!;
    expect(action.getAttribute("aria-label")).toBe("New skill");
    expect(action.querySelector("span")?.className).toContain("@max-[40rem]/main:sr-only");
    const row = rowFor(mounted.container, "house-style")!;
    expect(row.className).toContain("min-h-11");
    expect(row.firstElementChild?.className).toContain("flex-col");
  });
});

describe("Old skill addresses", () => {
  test("a skill's page under Plugins opens under Skills", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    expect(location).toBe(`/w/${SLUG}/skills/workspace/house-style`);
    expect(mounted.container.textContent).toContain("house-style");
  });

  test("the new skill page under Plugins opens under Skills", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/new`);
    expect(location).toBe(`/w/${SLUG}/skills/new`);
  });
});

describe("A skill's page", () => {
  test("a workspace admin edits a workspace skill, saving in this workspace", async () => {
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    const body = mounted.container.querySelector<HTMLTextAreaElement>("#rule-body");
    expect(body?.value).toBe("Body of house-style");
    expect(button(mounted.container, "Delete skill")).toBeDefined();

    await click(mounted.container.querySelector('button[aria-label="Turn off house-style"]'));
    const status = calls(callTool, "set_status")[0];
    expect(status?.[2]).toEqual({ id: WORKSPACE_SKILL.id, status: "disabled" });
    expect(status?.[3]).toEqual({ workspaceId: WS_ID });
  });

  test("a member reads a workspace skill without editing it", async () => {
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`, "member");
    expect(mounted.container.querySelector("#rule-body")).toBeNull();
    expect(mounted.container.querySelector('[data-testid="skill-read-only"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain("Workspace admins can change it.");
    expect(button(mounted.container, "Delete skill")).toBeUndefined();
    expect(
      mounted.container.querySelector(
        '[aria-label="house-style — on, managed by workspace admins"]',
      ),
    ).not.toBeNull();
  });

  test("a member edits their own skill, which is written with no workspace", async () => {
    mounted = await mount(`/w/${SLUG}/skills/user/my-voice`, "member");
    expect(mounted.container.querySelector("#rule-body")).not.toBeNull();
    await click(mounted.container.querySelector('button[aria-label="Turn off my-voice"]'));
    expect(calls(callToolWithoutWorkspace, "set_status")).toHaveLength(1);
    expect(calls(callTool, "set_status")).toHaveLength(0);
  });

  test("an org skill is read-only here, even for a workspace admin", async () => {
    mounted = await mount(`/w/${SLUG}/skills/org/policy`, "admin");
    expect(mounted.container.querySelector("#rule-body")).toBeNull();
    expect(mounted.container.textContent).toContain("Body of policy");
    expect(mounted.container.textContent).toContain("Org admins change it in org settings.");
  });

  test("a workspace skill named like one of the viewer's own opens as itself", async () => {
    const mine = summary({ name: "house-style", scope: "user" });
    skills = [WORKSPACE_SKILL, mine];
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    expect(mounted.container.querySelector<HTMLTextAreaElement>("#rule-body")?.value).toBe(
      "Body of house-style",
    );
    expect(calls(callTool, "read")[0]?.[2]).toEqual({ id: WORKSPACE_SKILL.id });
  });

  test("an edited workspace skill body saves in this workspace when the field is left", async () => {
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    await editBody(mounted.container, "Write plainly.");
    const update = calls(callTool, "update")[0];
    expect(update?.[2]).toMatchObject({ id: WORKSPACE_SKILL.id, body: "Write plainly." });
    expect(update?.[3]).toEqual({ workspaceId: WS_ID });
    expect(calls(callToolWithoutWorkspace, "update")).toHaveLength(0);
  });

  test("an edited body of the viewer's own skill saves with no workspace", async () => {
    mounted = await mount(`/w/${SLUG}/skills/user/my-voice`, "member");
    await editBody(mounted.container, "Sound like me.");
    const update = calls(callToolWithoutWorkspace, "update")[0];
    expect(update?.[2]).toMatchObject({ id: USER_SKILL.id, body: "Sound like me." });
    expect(calls(callTool, "update")).toHaveLength(0);
  });

  test("a refused body save shows the refusal on the field", async () => {
    refuse = "update";
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    await editBody(mounted.container, "Write plainly.");
    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Refused update");
  });

  test("deleting a workspace skill writes in this workspace and returns to Skills", async () => {
    confirmWith(true);
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    await click(button(mounted.container, "Delete skill"));
    const del = calls(callTool, "delete")[0];
    expect(del?.[2]).toEqual({ id: WORKSPACE_SKILL.id });
    expect(del?.[3]).toEqual({ workspaceId: WS_ID });
    expect(location).toBe(`/w/${SLUG}/skills`);
  });

  test("deleting the viewer's own skill writes with no workspace", async () => {
    confirmWith(true);
    mounted = await mount(`/w/${SLUG}/skills/user/my-voice`, "member");
    await click(button(mounted.container, "Delete skill"));
    expect(calls(callToolWithoutWorkspace, "delete")[0]?.[2]).toEqual({ id: USER_SKILL.id });
    expect(calls(callTool, "delete")).toHaveLength(0);
    expect(location).toBe(`/w/${SLUG}/skills`);
  });

  test("a refused delete stays on the skill and says why", async () => {
    confirmWith(true);
    refuse = "delete";
    const path = `/w/${SLUG}/skills/workspace/house-style`;
    mounted = await mount(path);
    await click(button(mounted.container, "Delete skill"));
    expect(location).toBe(path);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Refused delete",
    );
  });

  test("a delete not confirmed writes nothing", async () => {
    confirmWith(false);
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    await click(button(mounted.container, "Delete skill"));
    expect(calls(callTool, "delete")).toHaveLength(0);
  });

  test("a skill that came with a plugin has no page here", async () => {
    mounted = await mount(`/w/${SLUG}/skills/provided/authoring-guide`);
    expect(mounted.container.textContent).toContain("This skill is not in this workspace.");
  });
});

describe("Writing a skill", () => {
  test("Cancel returns to Skills", async () => {
    mounted = await mount(`/w/${SLUG}/skills/new`);
    await click(button(mounted.container, "Cancel"));
    expect(location).toBe(`/w/${SLUG}/skills`);
  });

  test("Just me writes a skill of the viewer's own, with no workspace", async () => {
    mounted = await mount(`/w/${SLUG}/skills/new`, "admin");
    await fillNewSkill(mounted.container);
    await click(button(mounted.container, "Create"));
    const create = calls(callToolWithoutWorkspace, "create")[0];
    expect((create?.[2] as { scope: string } | undefined)?.scope).toBe("user");
    expect(calls(callTool, "create")).toHaveLength(0);
    expect(location).toBe(`/w/${SLUG}/skills/user/release-notes`);
  });

  test("Everyone here writes a workspace skill in this workspace", async () => {
    mounted = await mount(`/w/${SLUG}/skills/new`, "admin");
    await click(mounted.container.querySelector('input[value="workspace"]'));
    await fillNewSkill(mounted.container);
    await click(button(mounted.container, "Create"));
    const create = calls(callTool, "create")[0];
    expect((create?.[2] as { scope: string } | undefined)?.scope).toBe("workspace");
    expect(create?.[3]).toEqual({ workspaceId: WS_ID });
    expect(location).toBe(`/w/${SLUG}/skills/workspace/release-notes`);
  });

  test("a member is not offered Everyone here", async () => {
    mounted = await mount(`/w/${SLUG}/skills/new`, "member");
    expect(mounted.container.querySelector('input[value="workspace"]')).toBeNull();
    expect(mounted.container.textContent).toContain(
      "A workspace admin can write a skill for everyone in Helix.",
    );
  });
});

describe("On here", () => {
  const onHere = (scope: ParentNode, name: string) =>
    (name ? rowFor(scope as HTMLElement, name) : scope)?.querySelector<HTMLElement>(
      '[data-testid="skill-on-here"]',
    ) ?? null;
  const switchIn = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[role="switch"]');
  const state = (scope: HTMLElement, name: string) =>
    rowFor(scope, name)?.querySelector('[data-testid="skill-state"]')?.textContent;

  test("only the viewer's own skills carry it, named for the skill", async () => {
    mounted = await mount(`/w/${SLUG}/skills`);
    expect(onHere(mounted.container, "house-style")).toBeNull();
    expect(onHere(mounted.container, "policy")).toBeNull();
    await click(segment(mounted.container, "personal"));
    const mine = onHere(mounted.container, "my-voice");
    // No visible label: the switch's name says what it switches.
    expect(mine?.textContent).toBe("");
    expect(switchIn(mine)?.getAttribute("aria-label")).toBe("On here: my-voice");
    expect(switchIn(mine)?.getAttribute("aria-checked")).toBe("true");
    expect(rowFor(mounted.container, "my-voice")?.textContent).not.toContain("On here");
    expect(state(mounted.container, "my-voice")).toBeUndefined();
  });

  test("a skill turned off here lists as Off here", async () => {
    skills = [{ ...USER_SKILL, onHere: false }];
    mounted = await mountPersonal();
    const mine = onHere(mounted.container, "my-voice");
    expect(state(mounted.container, "my-voice")).toBe("Off here");
    expect(switchIn(mine)?.getAttribute("aria-checked")).toBe("false");
    expect(rowFor(mounted.container, "my-voice")?.querySelector("a")?.className).toContain(
      "text-muted-foreground",
    );
  });

  test("a disabled skill says only Disabled, with no switch", async () => {
    skills = [{ ...USER_SKILL, status: "disabled", onHere: false }];
    mounted = await mountPersonal();
    expect(state(mounted.container, "my-voice")).toBe("Disabled");
    expect(onHere(mounted.container, "my-voice")).toBeNull();
    expect(rowFor(mounted.container, "my-voice")?.textContent).not.toContain("Off here");
  });

  test("flipping it reads Off here at once, holds while the save runs, and saves in this workspace", async () => {
    let release: () => void = () => {};
    setSkillOnHere.mockImplementation(
      (workspaceId, id, on) =>
        new Promise((resolve) => {
          release = () => resolve({ id, name: "my-voice", workspaceId, onHere: on });
        }),
    );
    mounted = await mountPersonal();
    await click(switchIn(onHere(mounted.container, "my-voice")));
    const mine = onHere(mounted.container, "my-voice");
    expect(state(mounted.container, "my-voice")).toBe("Off here");
    expect(switchIn(mine)?.hasAttribute("data-disabled")).toBe(true);
    // A second flip while the first is in flight sends nothing.
    await click(switchIn(mine));
    expect(setSkillOnHere).toHaveBeenCalledTimes(1);
    expect(setSkillOnHere).toHaveBeenCalledWith(WS_ID, USER_SKILL.id, false);

    await act(async () => release());
    await settle();
    const saved = onHere(mounted.container, "my-voice");
    expect(state(mounted.container, "my-voice")).toBe("Off here");
    expect(switchIn(saved)?.hasAttribute("data-disabled")).toBe(false);
  });

  test("a refused save puts it back and says why in a notice", async () => {
    setSkillOnHere.mockImplementation(async () => {
      throw new Error("Not yours to change");
    });
    mounted = await mountPersonal();
    await click(switchIn(onHere(mounted.container, "my-voice")));
    const mine = onHere(mounted.container, "my-voice");
    expect(state(mounted.container, "my-voice")).toBeUndefined();
    expect(switchIn(mine)?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Couldn't turn my-voice off here");
    expect(document.body.textContent).toContain("Not yours to change");
  });

  test("the viewer's own skill's page offers it, with the hint", async () => {
    mounted = await mount(`/w/${SLUG}/skills/user/my-voice`);
    const here = mounted.container.querySelector<HTMLElement>('[data-testid="skill-here"]')!;
    expect(here.textContent).toContain(
      "Your skills apply in every workspace unless you turn one off here.",
    );
    await click(switchIn(onHere(here, "")));
    expect(setSkillOnHere).toHaveBeenCalledWith(WS_ID, USER_SKILL.id, false);
    expect(switchIn(onHere(here, ""))?.getAttribute("aria-checked")).toBe("false");
  });

  test("a disabled skill's page says Disabled where the switch would be", async () => {
    skills = [{ ...USER_SKILL, status: "disabled" }];
    mounted = await mount(`/w/${SLUG}/skills/user/my-voice`);
    const here = mounted.container.querySelector<HTMLElement>('[data-testid="skill-here"]')!;
    expect(here.querySelector('[data-testid="skill-state"]')?.textContent).toBe("Disabled");
    expect(here.textContent).toContain("Turn the skill on first.");
    expect(onHere(here, "")).toBeNull();
  });

  test("a skill's page names the plugin a pattern reaches, and keeps the default sentence", async () => {
    plugins = [plugin({ id: "workspace:docs", displayName: "Docs", owner: { kind: "workspace" } })];
    mounted = await mount(`/w/${SLUG}/skills/user/my-voice`);
    const line = () =>
      mounted!.container.querySelector('[data-testid="skill-mechanism"]')?.textContent;
    expect(line()).toBe("When Docs is used");
    mounted.unmount();
    skills = [
      summary({
        name: "asked",
        scope: "user",
        loadingStrategy: "dynamic",
        loading: { mechanism: "on_request" },
      }),
    ];
    mounted = await mount(`/w/${SLUG}/skills/user/asked`);
    expect(line()).toBe("When the agent asks for it");
  });

  test("a workspace or org skill's page does not", async () => {
    mounted = await mount(`/w/${SLUG}/skills/workspace/house-style`);
    expect(mounted.container.querySelector('[data-testid="skill-here"]')).toBeNull();
    mounted.unmount();
    mounted = await mount(`/w/${SLUG}/skills/org/policy`);
    expect(mounted.container.querySelector('[data-testid="skill-here"]')).toBeNull();
  });
});
