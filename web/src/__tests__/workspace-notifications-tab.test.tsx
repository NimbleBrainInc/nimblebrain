// ---------------------------------------------------------------------------
// WorkspaceNotificationsTab — the three things this page must never get wrong.
//
// Pins:
//   1. It says routes are saved but NOT executed while the dispatch half is
//      unbuilt. A stored rule that silently does nothing is worse than no
//      rule: an admin writes one, sees it listed, and stops watching.
//   2. It never sends `createdBy`. The principal a route dispatches under is
//      stamped from the authenticated identity; a body that carried one would
//      be refused, and offering the field at all invites the impersonation the
//      design forbids.
//   3. A malformed tool input is reported, not swallowed. Sending `{}` for
//      unparseable JSON would store a route that delivers an empty message.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { WorkspaceInfo } from "../context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom doesn't expose SyntaxError/TypeError on its Window stub; any
// querySelectorAll trips it. Same patch the other component tests carry.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

let calls: ToolCall[] = [];
let current = settings();

function settings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sources: [
      {
        source: "acme",
        label: "Acme",
        description: "Domain lifecycle.",
        maxLevel: "info",
        configured: false,
      },
    ],
    routes: [],
    deliverableTools: ["slack__send_message"],
    automations: [{ id: "auto_triage", name: "Triage" }],
    placeholders: ["title", "body", "subject", "link.resource"],
    routesExecuted: true,
    ...over,
  };
}

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (_source: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return { content: [{ type: "text", text: JSON.stringify(current) }] };
  }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { WorkspaceNotificationsTab } = await import("../pages/settings/WorkspaceNotificationsTab");

const WS: WorkspaceInfo = {
  id: "ws_outbound",
  name: "Outbound",
  bundles: [],
  memberCount: 1,
  isPersonal: false,
  userRole: "admin",
};

let unmount: (() => void) | null = null;

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        WorkspaceProvider,
        { initialWorkspaces: [WS], initialActiveId: WS.id },
        React.createElement(WorkspaceNotificationsTab),
      ),
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.getElementsByTagName("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`no button labelled ${label}`);
  return button;
}

function selectLabelled(container: HTMLElement, label: string): HTMLSelectElement {
  const el = Array.from(container.getElementsByTagName("select")).find(
    (s) => s.getAttribute("aria-label") === label,
  );
  if (!el) throw new Error(`no select labelled ${label}`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

/** The shim's own Event constructor — a global `Event` is a different class to it. */
const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;

/**
 * Set a form control's value the way React's onChange sees it.
 *
 * Two details, both load-bearing. React tracks the last value it wrote on the
 * DOM node, so assigning `el.value` directly makes the change invisible to it —
 * the prototype's own setter is what updates the tracker. And React binds a
 * `<select>`'s onChange to `change` and a `<textarea>`'s to `input`, so the
 * wrong event leaves the component's state untouched, which reads as "the page
 * ignored my edit".
 */
async function setValue(el: HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto =
    el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
  const setVal = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const type = el.tagName === "SELECT" ? "change" : "input";
  await act(async () => {
    setVal?.call(el, value);
    el.dispatchEvent(new WindowEvent(type, { bubbles: true }));
  });
}

afterEach(() => {
  unmount?.();
  unmount = null;
  calls = [];
  current = settings();
});

describe("what the page tells an admin about routes", () => {
  test("says tool targets run and automation targets do not", async () => {
    const container = await mount();
    const notice = container.querySelector(
      '[data-testid="agent-routes-not-executed"]',
    ) as HTMLElement | null;
    expect(notice?.textContent).toContain("run");
    expect(notice?.textContent).toContain("automation");
    // The blanket "nothing dispatches" notice is gone: it would be false now,
    // and a warning that is false is worse than none.
    expect(container.querySelector('[data-testid="routes-not-executed"]')).toBeNull();
  });

  test("falls back to the blanket notice when nothing executes at all", async () => {
    current = settings({ routesExecuted: false });
    const container = await mount();
    const notice = container.querySelector(
      '[data-testid="routes-not-executed"]',
    ) as HTMLElement | null;
    expect(notice?.textContent).toContain("not yet executed");
    expect(container.querySelector('[data-testid="agent-routes-not-executed"]')).toBeNull();
  });

  test("a route the runtime disabled says so, with the reason, where it is edited", async () => {
    current = settings({
      routes: [
        {
          id: "rt_slack",
          createdBy: "usr_gone",
          match: {},
          deliver: [{ kind: "tool", tool: "slack__send_message" }],
          disabled: { reason: "Its author is no longer a member.", at: "2026-09-04T00:00:00Z" },
        },
      ],
    });
    const container = await mount();
    const badge = container.querySelector('[data-testid="route-disabled"]') as HTMLElement | null;
    expect(badge?.textContent).toContain("Not dispatching");
    expect(badge?.textContent).toContain("no longer a member");
  });

  test("a healthy route shows no such badge", async () => {
    current = settings({
      routes: [
        {
          id: "rt_slack",
          createdBy: "usr_admin",
          match: {},
          deliver: [{ kind: "tool", tool: "slack__send_message" }],
        },
      ],
    });
    const container = await mount();
    expect(container.querySelector('[data-testid="route-disabled"]')).toBeNull();
  });
});

describe("the ceiling", () => {
  test("a source at the default says so, and changing it writes just that source", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Default");

    await setValue(selectLabelled(container, "Level ceiling for Acme"), "urgent");

    const write = calls.find((c) => c.tool === "set_source_level");
    expect(write?.args).toEqual({ source: "acme", maxLevel: "urgent" });
  });
});

describe("saving routes", () => {
  test("never sends createdBy — the principal is stamped, not offered", async () => {
    current = settings({
      routes: [
        {
          id: "rt_1",
          createdBy: "usr_admin",
          match: { source: "acme" },
          deliver: [{ kind: "tool", tool: "slack__send_message", input: { text: "{{title}}" } }],
        },
      ],
    });
    const container = await mount();
    // The author is shown, because an admin needs to know whose identity a
    // route would spend. It is display only.
    expect(container.textContent).toContain("usr_admin");

    await click(buttonLabelled(container, "Save routes"));

    const write = calls.find((c) => c.tool === "set_routes");
    const sent = (write?.args.routes as Array<Record<string, unknown>>)[0];
    expect(sent).toEqual({
      id: "rt_1",
      match: { source: "acme" },
      deliver: [{ kind: "tool", tool: "slack__send_message", input: { text: "{{title}}" } }],
    });
    expect(sent).not.toHaveProperty("createdBy");
  });

  test("a malformed input is reported rather than sent as an empty object", async () => {
    current = settings({
      routes: [
        {
          id: "rt_1",
          createdBy: "usr_admin",
          match: {},
          deliver: [{ kind: "tool", tool: "slack__send_message" }],
        },
      ],
    });
    const container = await mount();

    const textarea = Array.from(container.getElementsByTagName("textarea"))[0]!;
    await setValue(textarea, "{ not json");
    await click(buttonLabelled(container, "Save routes"));

    expect(container.textContent).toContain("not valid JSON");
    expect(calls.some((c) => c.tool === "set_routes")).toBe(false);
  });
});
