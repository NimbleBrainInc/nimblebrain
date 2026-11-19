// ---------------------------------------------------------------------------
// Skills on Plugins — the Installed tab's skills, a skill's page, and writing a
// new one from Browse.
//
// Installed lists the skills people wrote under who they act for (the
// workspace's and the org's under Shared, the viewer's own under Just you),
// and never one that came with a plugin. A
// skill's page edits under the server's write rules: a workspace skill needs
// workspace write, the viewer's own is theirs, an org skill is read-only here.
// A new skill asks whom it is for, and only a writer may pick everyone. The
// viewer's own skills, and only theirs, carry On here, on their row and page.
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
const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins: [] }));
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
  setSkillOnHere.mockClear();
  setSkillOnHere.mockImplementation(async (workspaceId, id, on) => ({
    id,
    name: skills.find((s) => s.id === id)?.name ?? "",
    workspaceId,
    onHere: on,
  }));
  refuse = null;
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

describe("Installed — skills", () => {
  test("lists the workspace's and the org's under Shared, the viewer's under Just you, none from a plugin", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    const inSection = (id: string) =>
      rows(mounted!.container.querySelector(`[data-testid="installed-section-${id}"]`)!);
    expect(inSection("shared")).toEqual(["workspace/house-style", "org/policy"]);
    expect(inSection("you")).toEqual(["user/my-voice"]);
    expect(calls(callTool, "list")[0]?.[3]).toEqual({ workspaceId: WS_ID });
    expect(mounted.container.textContent).toContain(
      "Skills that come with a plugin are on that plugin's page.",
    );
  });

  test("each row says how it loads, and an org skill is tagged", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    const tag = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector('[data-testid="skill-org-tag"]')?.textContent;
    expect(tag("policy")).toBe("Org");
    expect(tag("house-style")).toBeUndefined();
    expect(tag("my-voice")).toBeUndefined();
    const facts = rowFor(mounted.container, "my-voice")?.querySelector(
      '[data-testid="skill-facts"]',
    )?.textContent;
    expect(facts).toBe("On tool match docs__*");
  });

  test("rows link to each skill's page by scope and name", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    const href = (name: string) =>
      rowFor(mounted!.container, name)?.querySelector("a")?.getAttribute("href");
    expect(href("house-style")).toBe(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    expect(href("my-voice")).toBe(`/w/${SLUG}/plugins/skills/user/my-voice`);
  });

  test("a workspace skill named like one of the viewer's own is listed beside it", async () => {
    skills = [WORKSPACE_SKILL, summary({ name: "house-style", scope: "user" })];
    mounted = await mount(`/w/${SLUG}/plugins`);
    expect(rows(mounted.container)).toEqual(["workspace/house-style", "user/house-style"]);
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

  test("a workspace skill named like one of the viewer's own opens as itself", async () => {
    const mine = summary({ name: "house-style", scope: "user" });
    skills = [WORKSPACE_SKILL, mine];
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    expect(mounted.container.querySelector<HTMLTextAreaElement>("#rule-body")?.value).toBe(
      "Body of house-style",
    );
    expect(calls(callTool, "read")[0]?.[2]).toEqual({ id: WORKSPACE_SKILL.id });
  });

  test("an edited workspace skill body saves in this workspace when the field is left", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    await editBody(mounted.container, "Write plainly.");
    const update = calls(callTool, "update")[0];
    expect(update?.[2]).toMatchObject({ id: WORKSPACE_SKILL.id, body: "Write plainly." });
    expect(update?.[3]).toEqual({ workspaceId: WS_ID });
    expect(calls(callToolWithoutWorkspace, "update")).toHaveLength(0);
  });

  test("an edited body of the viewer's own skill saves with no workspace", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/user/my-voice`, "member");
    await editBody(mounted.container, "Sound like me.");
    const update = calls(callToolWithoutWorkspace, "update")[0];
    expect(update?.[2]).toMatchObject({ id: USER_SKILL.id, body: "Sound like me." });
    expect(calls(callTool, "update")).toHaveLength(0);
  });

  test("a refused body save shows the refusal on the field", async () => {
    refuse = "update";
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    await editBody(mounted.container, "Write plainly.");
    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Refused update");
  });

  test("deleting a workspace skill writes in this workspace and returns to Plugins", async () => {
    confirmWith(true);
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    await click(button(mounted.container, "Delete skill"));
    const del = calls(callTool, "delete")[0];
    expect(del?.[2]).toEqual({ id: WORKSPACE_SKILL.id });
    expect(del?.[3]).toEqual({ workspaceId: WS_ID });
    expect(location).toBe(`/w/${SLUG}/plugins`);
  });

  test("deleting the viewer's own skill writes with no workspace", async () => {
    confirmWith(true);
    mounted = await mount(`/w/${SLUG}/plugins/skills/user/my-voice`, "member");
    await click(button(mounted.container, "Delete skill"));
    expect(calls(callToolWithoutWorkspace, "delete")[0]?.[2]).toEqual({ id: USER_SKILL.id });
    expect(calls(callTool, "delete")).toHaveLength(0);
    expect(location).toBe(`/w/${SLUG}/plugins`);
  });

  test("a refused delete stays on the skill and says why", async () => {
    confirmWith(true);
    refuse = "delete";
    const path = `/w/${SLUG}/plugins/skills/workspace/house-style`;
    mounted = await mount(path);
    await click(button(mounted.container, "Delete skill"));
    expect(location).toBe(path);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Refused delete",
    );
  });

  test("a delete not confirmed writes nothing", async () => {
    confirmWith(false);
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    await click(button(mounted.container, "Delete skill"));
    expect(calls(callTool, "delete")).toHaveLength(0);
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

describe("On here", () => {
  const onHere = (scope: ParentNode, name: string) =>
    (name ? rowFor(scope as HTMLElement, name) : scope)?.querySelector<HTMLElement>(
      '[data-testid="skill-on-here"]',
    ) ?? null;
  const switchIn = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[role="switch"]');

  test("only the viewer's own skills carry it, named for the skill", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    const mine = onHere(mounted.container, "my-voice");
    expect(mine?.textContent).toBe("On here");
    expect(switchIn(mine)?.getAttribute("aria-label")).toBe("On here: my-voice");
    expect(switchIn(mine)?.getAttribute("aria-checked")).toBe("true");
    expect(onHere(mounted.container, "house-style")).toBeNull();
    expect(onHere(mounted.container, "policy")).toBeNull();
  });

  test("Just you says the viewer's skills apply everywhere unless turned off here", async () => {
    mounted = await mount(`/w/${SLUG}/plugins`);
    expect(
      mounted.container.querySelector('[data-testid="installed-section-you"]')?.textContent,
    ).toContain("your skills apply in every workspace unless you turn one off here.");
  });

  test("a skill turned off here lists as Off here", async () => {
    skills = [{ ...USER_SKILL, onHere: false }];
    mounted = await mount(`/w/${SLUG}/plugins`);
    const mine = onHere(mounted.container, "my-voice");
    expect(mine?.textContent).toBe("Off here");
    expect(switchIn(mine)?.getAttribute("aria-checked")).toBe("false");
  });

  test("flipping it reads Off here at once, holds while the save runs, and saves in this workspace", async () => {
    let release: () => void = () => {};
    setSkillOnHere.mockImplementation(
      (workspaceId, id, on) =>
        new Promise((resolve) => {
          release = () => resolve({ id, name: "my-voice", workspaceId, onHere: on });
        }),
    );
    mounted = await mount(`/w/${SLUG}/plugins`);
    await click(switchIn(onHere(mounted.container, "my-voice")));
    const mine = onHere(mounted.container, "my-voice");
    expect(mine?.textContent).toBe("Off here");
    expect(switchIn(mine)?.hasAttribute("data-disabled")).toBe(true);
    // A second flip while the first is in flight sends nothing.
    await click(switchIn(mine));
    expect(setSkillOnHere).toHaveBeenCalledTimes(1);
    expect(setSkillOnHere).toHaveBeenCalledWith(WS_ID, USER_SKILL.id, false);

    await act(async () => release());
    await settle();
    const saved = onHere(mounted.container, "my-voice");
    expect(saved?.textContent).toBe("Off here");
    expect(switchIn(saved)?.hasAttribute("data-disabled")).toBe(false);
  });

  test("a refused save puts it back and says why in a notice", async () => {
    setSkillOnHere.mockImplementation(async () => {
      throw new Error("Not yours to change");
    });
    mounted = await mount(`/w/${SLUG}/plugins`);
    await click(switchIn(onHere(mounted.container, "my-voice")));
    const mine = onHere(mounted.container, "my-voice");
    expect(mine?.textContent).toBe("On here");
    expect(switchIn(mine)?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Couldn't turn my-voice off here");
    expect(document.body.textContent).toContain("Not yours to change");
  });

  test("the viewer's own skill's page offers it, with the hint", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/user/my-voice`);
    const here = mounted.container.querySelector<HTMLElement>('[data-testid="skill-here"]')!;
    expect(here.textContent).toContain(
      "Your skills apply in every workspace unless you turn one off here.",
    );
    await click(switchIn(onHere(here, "")));
    expect(setSkillOnHere).toHaveBeenCalledWith(WS_ID, USER_SKILL.id, false);
    expect(onHere(here, "")?.textContent).toBe("Off here");
  });

  test("a workspace or org skill's page does not", async () => {
    mounted = await mount(`/w/${SLUG}/plugins/skills/workspace/house-style`);
    expect(mounted.container.querySelector('[data-testid="skill-here"]')).toBeNull();
    mounted.unmount();
    mounted = await mount(`/w/${SLUG}/plugins/skills/org/policy`);
    expect(mounted.container.querySelector('[data-testid="skill-here"]')).toBeNull();
  });
});
