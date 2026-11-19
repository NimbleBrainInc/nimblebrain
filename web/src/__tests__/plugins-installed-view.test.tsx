// ---------------------------------------------------------------------------
// The Installed tab at scale — a long listing of plugins and skills.
//
// What needs the viewer is gathered in a strip at the top, shown only when
// something does. Each section counts what it holds and shows a few rows of
// each kind until asked for all. The toolbar narrows by kind and by owner, and
// a search drops the sections for one list whose rows mark whose each is. A
// section's collapse is remembered in the viewer's browser, and a storage that
// refuses never breaks the page.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type { SkillSummary } from "../_generated/platform-schemas/skills";
import type * as ApiClient from "../api/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";

let plugins: Plugin[] = [];
let skills: SkillSummary[] = [];

const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins }));
const listPersonalConnectors = mock<typeof ApiClient.listPersonalConnectors>(async () => ({
  connectors: [],
}));
const callTool = mock<typeof ApiClient.callTool>(async (_server, _tool, args) => ({
  content: [],
  structuredContent: {
    skills: skills.filter((s) => s.scope === (args as { scope?: string } | undefined)?.scope),
  },
  isError: false,
}));

mock.module("../api/client", () => ({
  ...realClient,
  callTool,
  listPlugins,
  listPersonalConnectors,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { toSlug } = await import("../lib/workspace-slug");
const { PluginsPage } = await import("../pages/PluginsPage");
const { NoticeProvider } = await import("../components/notices");

const SLUG = toSlug(WS_ID);

function plugin(id: string, over: Partial<Plugin> & { owner?: Plugin["owner"] } = {}): Plugin {
  const [kind, name = id] = id.split(":");
  return {
    id,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    owner: { kind: kind === "person" ? "person" : "workspace" },
    granted: true,
    servers: [{ serverName: name, status: "ready", account: null }],
    skills: [],
    apps: [],
    ...over,
  };
}

function skill(name: string, scope: SkillSummary["scope"], description?: string): SkillSummary {
  return {
    id: `/work/${scope}/${name}/SKILL.md`,
    name,
    layer: 3,
    scope,
    status: "active",
    tokens: 40,
    source: { path: `/work/${scope}/${name}/SKILL.md` },
    description,
    loading: { mechanism: "always" },
  };
}

/** `n` workspace plugins named `w01`… and `n` of the viewer's, `p01`…. */
function many(n: number, prefix: "workspace" | "person", letter: string): Plugin[] {
  return Array.from({ length: n }, (_, i) =>
    plugin(`${prefix}:${letter}${String(i + 1).padStart(2, "0")}`),
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
});

beforeEach(() => {
  plugins = [];
  skills = [];
  localStorage.clear();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(opts: { role?: "admin" | "member" } = {}): Promise<Mounted> {
  const workspace = {
    id: WS_ID,
    name: "Helix",
    memberCount: 2,
    connectorCount: 0,
    userRole: opts.role ?? "admin",
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceProvider initialWorkspaces={[workspace]} initialActiveId={WS_ID}>
        <NoticeProvider>
          <MemoryRouter initialEntries={[`/w/${SLUG}/plugins`]}>
            <Routes>
              <Route path="/w/:slug/plugins" element={<PluginsPage />} />
            </Routes>
          </MemoryRouter>
        </NoticeProvider>
      </WorkspaceProvider>,
    );
  });
  await settle();
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

const q = <T extends Element = HTMLElement>(scope: ParentNode, testId: string) =>
  scope.querySelector<T>(`[data-testid="${testId}"]`);

function section(id: string): HTMLElement | null {
  return q(mounted!.container, `installed-section-${id}`);
}

function pluginIds(el: ParentNode | null): string[] {
  return [...(el?.querySelectorAll('[data-testid="plugin-row"]') ?? [])].map(
    (r) => r.getAttribute("data-plugin-id") ?? "",
  );
}

function skillNames(el: ParentNode | null): string[] {
  return [...(el?.querySelectorAll('[data-testid="skill-row"]') ?? [])].map(
    (r) => r.getAttribute("data-skill-name") ?? "",
  );
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function search(text: string): Promise<void> {
  const input = q<HTMLInputElement>(mounted!.container, "installed-search")!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function pickOwner(value: "everyone" | "shared" | "you"): Promise<void> {
  const select = q<HTMLSelectElement>(mounted!.container, "installed-owner")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

async function pickKind(kind: "all" | "plugins" | "skills"): Promise<void> {
  await click(mounted!.container.querySelector(`[data-kind="${kind}"]`));
}

function kindCount(kind: "all" | "plugins" | "skills"): string {
  return mounted!.container.querySelector(`[data-kind="${kind}"] span`)?.textContent ?? "";
}

describe("Needs you", () => {
  test("appears only when a row's next step is an action, and lists just those", async () => {
    plugins = [
      plugin("workspace:github"),
      plugin("person:gmail", {
        servers: [{ serverName: "gmail", status: "not_connected", account: null }],
      }),
      plugin("workspace:hubspot", {
        servers: [{ serverName: "hubspot", status: "needs_auth", account: null }],
      }),
      plugin("workspace:jira", {
        servers: [{ serverName: "jira", status: "failed", account: null }],
      }),
      // Settling asks nothing.
      plugin("workspace:linear", {
        servers: [{ serverName: "linear", status: "starting", account: null }],
      }),
      // Use here lives in its own section.
      plugin("person:granola", { granted: false }),
    ];
    mounted = await mount();
    const strip = q(mounted.container, "installed-needs-you")!;
    expect(pluginIds(strip)).toEqual(["person:gmail", "workspace:hubspot", "workspace:jira"]);
    expect(button(strip, "Connect")).toBeDefined();
    expect(button(strip, "Reconnect")).toBeDefined();
    expect(button(strip, "Open")).toBeDefined();
    // Shown outside its section, each row marks whose it is.
    const marks = [...strip.querySelectorAll('[data-testid="owner-mark"]')].map((m) =>
      m.getAttribute("data-owner"),
    );
    expect(marks).toEqual(["you", "shared", "shared"]);
  });

  test("a long strip shows its first five, then all of them", async () => {
    plugins = Array.from({ length: 7 }, (_, i) =>
      plugin(`workspace:n${i}`, {
        servers: [{ serverName: `n${i}`, status: "failed", account: null }],
      }),
    );
    mounted = await mount();
    const strip = q(mounted.container, "installed-needs-you")!;
    expect(strip.textContent).toContain("Needs you · 7");
    expect(pluginIds(strip)).toHaveLength(5);
    await click(q(strip, "installed-show-all"));
    expect(pluginIds(strip)).toHaveLength(7);
  });

  test("is absent when nothing needs the viewer", async () => {
    plugins = [plugin("workspace:github"), plugin("person:granola", { granted: false })];
    mounted = await mount();
    expect(q(mounted.container, "installed-needs-you")).toBeNull();
  });

  test("a workspace sign-in is not a member's to do, so it is not in their strip", async () => {
    plugins = [
      plugin("workspace:hubspot", {
        servers: [{ serverName: "hubspot", status: "needs_auth", account: null }],
      }),
    ];
    mounted = await mount({ role: "member" });
    expect(q(mounted.container, "installed-needs-you")).toBeNull();
  });

  test("a section lists the rows that need the viewer first, then by name", async () => {
    plugins = [
      plugin("workspace:alpha"),
      plugin("workspace:zeta", {
        servers: [{ serverName: "zeta", status: "failed", account: null }],
      }),
    ];
    mounted = await mount();
    expect(pluginIds(section("shared"))).toEqual(["workspace:zeta", "workspace:alpha"]);
  });
});

describe("Sections", () => {
  test("each header counts the plugins and skills it holds", async () => {
    plugins = [...many(3, "workspace", "w"), ...many(2, "person", "p")];
    skills = [skill("house-style", "workspace"), skill("policy", "org"), skill("voice", "user")];
    mounted = await mount();
    const count = (id: string) => q(section(id)!, "installed-section-count")?.textContent;
    expect(count("shared")).toBe("3 plugins · 2 skills");
    expect(count("you")).toBe("2 plugins · 1 skill");
    expect(section("shared")?.textContent).toContain("Shared in Helix");
  });

  test("a sub-list shows its first five, then all of them in place", async () => {
    plugins = many(8, "workspace", "w");
    mounted = await mount();
    const list = q(section("shared")!, "installed-shared-plugins")!;
    expect(pluginIds(list)).toHaveLength(5);
    const more = q(list, "installed-show-all")!;
    expect(more.textContent).toBe("Show all 8 plugins");
    await click(more);
    expect(pluginIds(list)).toHaveLength(8);
    expect(q(list, "installed-show-all")?.textContent).toBe("Show fewer");
  });

  test("a sub-list of five or fewer has no Show all", async () => {
    plugins = many(5, "workspace", "w");
    mounted = await mount();
    expect(q(section("shared")!, "installed-show-all")).toBeNull();
  });

  test("Yours, not on here starts collapsed and opens on its header", async () => {
    plugins = [plugin("person:granola", { granted: false })];
    mounted = await mount();
    const notHere = section("not-here")!;
    expect(notHere.getAttribute("data-collapsed")).toBe("true");
    expect(pluginIds(notHere)).toEqual([]);
    await click(notHere.querySelector("h2 button"));
    expect(pluginIds(notHere)).toEqual(["person:granola"]);
    expect(button(notHere, "Use here")).toBeDefined();
  });

  test("a section's collapse is remembered for the next visit", async () => {
    plugins = [plugin("workspace:github")];
    mounted = await mount();
    await click(section("shared")!.querySelector("h2 button"));
    expect(section("shared")?.getAttribute("data-collapsed")).toBe("true");
    mounted.unmount();

    mounted = await mount();
    expect(section("shared")?.getAttribute("data-collapsed")).toBe("true");
    expect(pluginIds(section("shared"))).toEqual([]);
  });

  test("a storage that refuses reads and writes leaves the page working", async () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const { getItem, setItem } = proto;
    proto.getItem = () => {
      throw new Error("denied");
    };
    proto.setItem = () => {
      throw new Error("denied");
    };
    try {
      plugins = [plugin("workspace:github")];
      mounted = await mount();
      expect(pluginIds(section("shared"))).toEqual(["workspace:github"]);
      await click(section("shared")!.querySelector("h2 button"));
      expect(section("shared")?.getAttribute("data-collapsed")).toBe("true");
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
    }
  });
});

describe("Toolbar", () => {
  beforeEach(() => {
    plugins = [plugin("workspace:github"), plugin("person:gmail")];
    skills = [skill("house-style", "workspace"), skill("voice", "user")];
  });

  test("the kind control counts each kind and narrows to it", async () => {
    mounted = await mount();
    expect([kindCount("all"), kindCount("plugins"), kindCount("skills")]).toEqual(["4", "2", "2"]);
    await pickKind("skills");
    expect(pluginIds(mounted.container)).toEqual([]);
    expect(skillNames(mounted.container)).toEqual(["house-style", "voice"]);
    await pickKind("plugins");
    expect(pluginIds(mounted.container)).toEqual(["workspace:github", "person:gmail"]);
    expect(skillNames(mounted.container)).toEqual([]);
  });

  test("the owner filter keeps Shared or Just you", async () => {
    mounted = await mount();
    await pickOwner("shared");
    expect(section("you")).toBeNull();
    expect(pluginIds(mounted.container)).toEqual(["workspace:github"]);
    expect(skillNames(mounted.container)).toEqual(["house-style"]);
    expect(kindCount("all")).toBe("2");

    await pickOwner("you");
    expect(section("shared")).toBeNull();
    expect(pluginIds(mounted.container)).toEqual(["person:gmail"]);
    expect(skillNames(mounted.container)).toEqual(["voice"]);
  });

  test("a search drops the sections for one list, each row marked with whose it is", async () => {
    skills = [...skills, skill("github-triage", "user", "Sort GitHub issues")];
    mounted = await mount();
    await search("git");
    expect(section("shared")).toBeNull();
    const results = q(mounted.container, "installed-results")!;
    expect(pluginIds(results)).toEqual(["workspace:github"]);
    expect(skillNames(results)).toEqual(["github-triage"]);
    const marks = [...results.querySelectorAll('[data-testid="owner-mark"]')].map((m) =>
      m.getAttribute("data-owner"),
    );
    expect(marks).toEqual(["shared", "you"]);
    expect(q(mounted.container, "installed-needs-you")).toBeNull();
  });

  test("a search with no match says so", async () => {
    mounted = await mount();
    await search("nothing-is-called-this");
    expect(q(mounted.container, "installed-no-matches")).not.toBeNull();
  });

  test("a filter that leaves nothing says so", async () => {
    plugins = [plugin("workspace:github")];
    skills = [];
    mounted = await mount();
    await pickOwner("you");
    expect(q(mounted.container, "installed-no-matches")).not.toBeNull();
  });
});
