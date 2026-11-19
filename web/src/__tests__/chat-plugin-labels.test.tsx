// ---------------------------------------------------------------------------
// Chat plugin labels — the timeline names the plugin behind a call or skill.
//
// Pins:
//   1. A workspace connector's call (`gmail__send`) carries its plugin's label.
//   2. A personal connector's call (`my_gmail__send`) carries the caller's own
//      plugin, with the person badge titled "Yours" — never the workspace's
//      same-named plugin.
//   3. A kernel tool (`nb__search`) and a server the listing lacks render with
//      no label, as they did before attribution.
//   4. A plugin request (`nb__manage_tools` `request_plugin`) reads "Asked to
//      use" with the requested plugin's label, not the tool or server name.
//   5. A loaded skill that comes with a plugin is labeled with it: in the
//      ledger line, and on the `nb__use_skill` / `skills__activate` call that
//      loads or un-mutes it. An authored skill is not.
//
// The listing is provided straight through `ChatPluginsContext`, so no fetch
// runs. Rendering goes through react-dom/client and the DOM is walked by tag +
// classList, as the BlockTimeline and LedgerLine suites do (happy-dom's
// selector engine throws on these class names).
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { BlockTimeline } = await import("../components/BlockTimeline");
const { LedgerLine } = await import("../components/LedgerLine");
const { ChatPluginsContext } = await import("../context/ChatPluginsContext");
type ContentBlock = import("../hooks/chat-store").ContentBlock;
type SkillsLoadedContext = import("../hooks/chat-store").SkillsLoadedContext;
type Plugin = import("../_generated/platform-schemas/plugins").Plugin;

function plugin(kind: "workspace" | "person", serverName: string, displayName: string): Plugin {
  return {
    id: `${kind}:${serverName}`,
    displayName,
    owner: { kind },
    granted: true,
    servers: [{ serverName, status: "ready", account: null }],
    skills: [],
    apps: [],
  };
}

const WORKSPACE_GMAIL: Plugin = {
  ...plugin("workspace", "gmail", "Team Gmail"),
  skills: [{ name: "drafting", kind: "published", serverName: "gmail" }],
};
const PERSONAL_GMAIL = plugin("person", "gmail", "My Gmail");
const PLUGINS: Plugin[] = [WORKSPACE_GMAIL, PERSONAL_GMAIL];

function byClass(root: Element, cls: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((el) => el.classList.contains(cls));
}

function call(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return {
    type: "tool",
    toolCalls: [
      {
        id,
        name,
        status: "done",
        input,
        result: { content: [{ type: "text", text: "ok" }], isError: false },
        ms: 5,
      },
    ],
  };
}

interface Label {
  name: string;
  owner: string | null;
  yoursTitle: string | null;
}

/**
 * Render `node` under the listing and read every plugin label it shows, after
 * opening its disclosure when `open` is set.
 */
async function labelsIn(node: React.ReactElement, open = false): Promise<Label[]> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        ChatPluginsContext.Provider,
        { value: PLUGINS },
        React.createElement(MemoryRouter, null, node),
      ),
    );
  });
  if (open) {
    const head = byClass(container, "disclosure__head")[0] as HTMLElement;
    await act(async () => {
      head.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  const labels = byClass(container, "plugin-label").map((el) => ({
    name: byClass(el, "plugin-label__name")[0]?.textContent ?? "",
    owner: el.getAttribute("data-owner"),
    yoursTitle: byClass(el, "plugin-label__yours")[0]?.getAttribute("title") ?? null,
  }));
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return labels;
}

function timeline(blocks: ContentBlock[]) {
  return React.createElement(BlockTimeline, {
    blocks,
    isCurrentMessage: false,
    streamingState: null,
    preparingTool: null,
    displayDetail: "balanced",
  });
}

describe("plugin labels on tool calls", () => {
  test("a workspace connector's call names its workspace plugin", async () => {
    expect(await labelsIn(timeline([call("t1", "gmail__send")]))).toEqual([
      { name: "Team Gmail", owner: "workspace", yoursTitle: null },
    ]);
  });

  test("a personal connector's call names the caller's own plugin, badged Yours", async () => {
    expect(await labelsIn(timeline([call("t1", "my_gmail__send")]))).toEqual([
      { name: "My Gmail", owner: "person", yoursTitle: "Yours" },
    ]);
  });

  test("a kernel tool has no plugin label", async () => {
    expect(await labelsIn(timeline([call("t1", "nb__search", { query: "acme" })]))).toEqual([]);
  });

  test("a server the listing does not have has no plugin label", async () => {
    expect(await labelsIn(timeline([call("t1", "slack__post")]))).toEqual([]);
  });

  test("a phase mixing plugins labels each row, not the chip", async () => {
    const blocks = [call("t1", "gmail__send"), call("t2", "my_gmail__send")];
    // Closed: no one plugin is true of the whole phase, so the chip names none.
    expect(await labelsIn(timeline(blocks))).toEqual([]);
    // Open: each row names its own.
    expect(await labelsIn(timeline(blocks), true)).toEqual([
      { name: "Team Gmail", owner: "workspace", yoursTitle: null },
      { name: "My Gmail", owner: "person", yoursTitle: "Yours" },
    ]);
  });

  test("one group of mixed calls labels each call that has a plugin", async () => {
    const promote = call("t1", "nb__manage_tools", { add: ["gmail__send"] });
    const send = call("t2", "gmail__send");
    if (promote.type !== "tool" || send.type !== "tool") throw new Error("unreachable");
    const group: ContentBlock = {
      type: "tool",
      toolCalls: [...promote.toolCalls, ...send.toolCalls],
    };
    expect(await labelsIn(timeline([group]))).toEqual([]);
    expect(await labelsIn(timeline([group]), true)).toEqual([
      { name: "Team Gmail", owner: "workspace", yoursTitle: null },
    ]);
  });

  test("a plugin request reads as asking to use the plugin, labeled with it, never by server name", async () => {
    const blocks = [call("t1", "nb__manage_tools", { request_plugin: "gmail" })];
    expect(await labelsIn(timeline(blocks))).toEqual([
      { name: "My Gmail", owner: "person", yoursTitle: "Yours" },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          ChatPluginsContext.Provider,
          { value: PLUGINS },
          React.createElement(MemoryRouter, null, timeline(blocks)),
        ),
      );
    });
    const head = byClass(container, "disclosure__head")[0]?.textContent ?? "";
    await act(async () => {
      root.unmount();
    });
    container.remove();
    expect(head).toContain("Asked to use");
    expect(head).not.toContain("manage tools");
    expect(head).not.toContain("· gmail");
  });

  test("a call that loads a plugin's skill is labeled with that plugin", async () => {
    expect(
      await labelsIn(timeline([call("t1", "nb__use_skill", { name: "connector:gmail:drafting" })])),
    ).toEqual([{ name: "Team Gmail", owner: "workspace", yoursTitle: null }]);
  });
});

describe("plugin labels on loaded skills", () => {
  test("un-muting a plugin's skill is labeled with that plugin", async () => {
    expect(
      await labelsIn(
        timeline([call("t1", "skills__activate", { id: "connector:gmail:drafting" })]),
      ),
    ).toEqual([{ name: "Team Gmail", owner: "workspace", yoursTitle: null }]);
  });

  test("a skill that comes with a plugin is labeled with it", async () => {
    const skills: SkillsLoadedContext = {
      skills: [
        {
          id: "skill://gmail/drafting/SKILL.md",
          name: "drafting",
          connector: "gmail",
          scope: "provided",
          tokens: 300,
          loadedBy: "tool_affinity",
          reason: "tool-affinity matched gmail__*",
        },
      ],
      totalTokens: 300,
    };
    expect(await labelsIn(React.createElement(LedgerLine, { skills }))).toEqual([
      { name: "Team Gmail", owner: "workspace", yoursTitle: null },
    ]);
  });

  test("an authored skill has no plugin label", async () => {
    const skills: SkillsLoadedContext = {
      skills: [
        {
          id: "skills/drafting.md",
          name: "drafting",
          scope: "workspace",
          tokens: 300,
          loadedBy: "always",
          reason: "always-on",
        },
      ],
      totalTokens: 300,
    };
    expect(await labelsIn(React.createElement(LedgerLine, { skills }))).toEqual([]);
  });
});
