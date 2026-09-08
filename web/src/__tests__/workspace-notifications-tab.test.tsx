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
/** What `notifications__send_test` answers with, per test. */
const DELIVERED_NOTHING: Record<string, unknown> = {
  notificationId: "acme:evt",
  source: "acme",
  effectiveLevel: "info",
  matched: true,
  deliveries: [],
};
let testSendResult: Record<string, unknown> | Error = DELIVERED_NOTHING;

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
    if (tool === "send_test") {
      if (testSendResult instanceof Error) throw testSendResult;
      return { content: [{ type: "text", text: JSON.stringify(testSendResult) }] };
    }
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
  connectors: [],
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
  testSendResult = DELIVERED_NOTHING;
});

describe("what the page tells an admin about routes", () => {
  test("says both kinds of target run, and names the one precondition", async () => {
    const container = await mount();
    const notice = container.querySelector('[data-testid="routes-executed"]') as HTMLElement | null;
    expect(notice?.textContent).toContain("tool");
    expect(notice?.textContent).toContain("automation");
    // The precondition an operator has to know: naming an automation is not
    // enough, it has to be one that runs on events.
    expect(notice?.textContent).toContain("runs on events");
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
    expect(container.querySelector('[data-testid="routes-executed"]')).toBeNull();
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

// ---------------------------------------------------------------------------
// Send test — the answer is the feature, so every shape it takes is asserted.
// A button that only ever said "sent" would be the same silence it exists to
// break.
// ---------------------------------------------------------------------------

const SAVED_ROUTE = {
  id: "rt_slack",
  createdBy: "usr_admin",
  match: { source: "acme", level: "attention" },
  deliver: [{ kind: "tool", tool: "slack__send_message", input: { channel: "alerts" } }],
};

function testResultText(container: HTMLElement): string | null {
  const el = container.querySelector('[data-testid="route-test-result"]');
  return el ? (el.textContent ?? "") : null;
}

async function sendTest(container: HTMLElement): Promise<void> {
  await act(async () => {
    buttonLabelled(container, "Send test").click();
  });
}

describe("send test", () => {
  test("a delivered route says so", async () => {
    current = settings({ routes: [SAVED_ROUTE] });
    testSendResult = {
      notificationId: "acme:evt",
      source: "acme",
      effectiveLevel: "attention",
      matched: true,
      deliveries: [
        {
          routeId: "rt_slack",
          target: "slack__send_message",
          index: 0,
          kind: "tool",
          attempts: 1,
          outcome: "delivered",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const container = await mount();
    await sendTest(container);

    expect(calls.some((c) => c.tool === "send_test")).toBe(true);
    expect(testResultText(container)).toContain("Delivered");
  });

  test("a route the ceiling blocks reports the reason, not an empty ledger", async () => {
    current = settings({ routes: [SAVED_ROUTE] });
    testSendResult = {
      notificationId: "acme:evt",
      source: "acme",
      effectiveLevel: "info",
      matched: false,
      reason: 'The ceiling on "acme" is "info" — raise it.',
      deliveries: [],
    };
    const container = await mount();
    await sendTest(container);

    expect(testResultText(container)).toContain('ceiling on "acme"');
  });

  test("a failed target names the target and the error", async () => {
    current = settings({ routes: [SAVED_ROUTE] });
    testSendResult = {
      notificationId: "acme:evt",
      source: "acme",
      effectiveLevel: "attention",
      matched: true,
      deliveries: [
        {
          routeId: "rt_slack",
          target: "slack__send_message",
          index: 0,
          kind: "tool",
          attempts: 1,
          outcome: "denied",
          classification: "tool_not_allowed",
          lastError: "not available to an unattended dispatch",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const container = await mount();
    await sendTest(container);

    const text = testResultText(container) ?? "";
    expect(text).toContain("slack__send_message");
    expect(text).toContain("denied");
  });

  test("a first attempt that failed says it will retry, not just 'pending'", async () => {
    // `pending` reads as neither pass nor fail, and the runtime has the item on
    // its retry ladder — it can reach the real channel minutes later.
    current = settings({ routes: [SAVED_ROUTE] });
    testSendResult = {
      notificationId: "acme:evt",
      source: "acme",
      effectiveLevel: "attention",
      matched: true,
      deliveries: [
        {
          routeId: "rt_slack",
          target: "slack__send_message",
          index: 0,
          kind: "tool",
          attempts: 1,
          outcome: "pending",
          lastError: "connection refused",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const container = await mount();
    await sendTest(container);

    const text = testResultText(container) ?? "";
    expect(text).toContain("attempt failed");
    expect(text).toContain("retries");
    expect(text).not.toBe("slack__send_message: pending");
  });

  test("an agent target still inside its debounce window is not 'delivered'", async () => {
    // `deferred` is non-terminal: the run has not started, there is no channel
    // to check, and the row can still settle `denied` or `skipped`.
    current = settings({ routes: [SAVED_ROUTE] });
    testSendResult = {
      notificationId: "acme:evt",
      source: "acme",
      effectiveLevel: "attention",
      matched: true,
      deliveries: [
        {
          routeId: "rt_slack",
          target: "aut_daily",
          index: 0,
          kind: "agent",
          attempts: 0,
          outcome: "deferred",
          classification: "awaiting_batch",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const container = await mount();
    await sendTest(container);

    const text = testResultText(container) ?? "";
    expect(text).toContain("aut_daily");
    expect(text).toContain("queued");
    expect(text).not.toContain("Delivered");
  });

  test("a call that never reached the server shows the error", async () => {
    current = settings({ routes: [SAVED_ROUTE] });
    testSendResult = new Error("Failed to fetch");
    const container = await mount();
    await sendTest(container);

    expect(testResultText(container)).toBe("Failed to fetch");
  });

  test("an unsaved route offers no test", async () => {
    current = settings({ routes: [] });
    const container = await mount();
    await act(async () => {
      buttonLabelled(container, "Add route").click();
    });

    expect(container.textContent).toContain("Save to test");
    expect(() => buttonLabelled(container, "Send test")).toThrow();
  });
});
