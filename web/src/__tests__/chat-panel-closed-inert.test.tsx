// ---------------------------------------------------------------------------
// ChatChrome — a closed panel is absent to input and assistive tech.
//
// The panel stays mounted when closed so its slide plays and the chat keeps
// its state, which means its controls are still in the DOM. It must be inert
// and aria-hidden then, so nothing in it takes focus or is announced; opening
// it clears both and puts the cursor in the composer, and closing it with
// focus inside moves focus out. This mounts the real chrome over the real
// providers and drives it the way a person does.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ChatProvider } = await import("../context/ChatContext");
const { ChatPanelProvider } = await import("../context/ChatPanelContext");
const { FocusedAppProvider } = await import("../context/FocusedAppContext");
const { SidebarProvider } = await import("../context/SidebarContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { ChatChrome } = await import("../components/ChatChrome");
const { chatStore } = await import("../hooks/chat-store");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

const WS_A: WorkspaceInfo = {
  id: "ws_a",
  name: "Alpha",
  connectorCount: 0,
  memberCount: 1,
  userRole: "admin",
};

const FOCUSABLE =
  'button, textarea, input, select, a[href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function mountChrome(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/w/a/overview"] },
        React.createElement(WorkspaceProvider, {
          initialWorkspaces: [WS_A],
          initialActiveId: "ws_a",
          children: React.createElement(ChatProvider, {
            currentUserId: "u1",
            initialConfig: { configuredProviders: ["anthropic"] },
            children: React.createElement(
              ChatPanelProvider,
              null,
              React.createElement(
                SidebarProvider,
                null,
                React.createElement(FocusedAppProvider, null, React.createElement(ChatChrome)),
              ),
            ),
          }),
        }),
      ),
    );
  });
}

function panel(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="chat-chrome-panel"]');
  if (!el) throw new Error("chat panel not rendered");
  return el;
}

function textarea(): HTMLTextAreaElement {
  const el = panel().querySelector("textarea");
  if (!el) throw new Error("composer textarea not rendered");
  return el;
}

function toggleButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="chat-chrome-open-button"]');
}

// happy-dom's `dispatchEvent` accepts only its own window's event classes, not
// the runtime's globals.
const win = window as unknown as { KeyboardEvent: typeof KeyboardEvent };

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

function expectClosed(): void {
  const el = panel();
  expect(el.hasAttribute("inert")).toBe(true);
  expect(el.getAttribute("aria-hidden")).toBe("true");
}

function expectOpen(): void {
  const el = panel();
  expect(el.hasAttribute("inert")).toBe(false);
  expect(el.getAttribute("aria-hidden")).toBe("false");
}

beforeEach(() => {
  chatStore.reset();
  localStorage.setItem("nb:chatPanelState", "closed");
  (document.activeElement as HTMLElement | null)?.blur?.();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem("nb:chatPanelState");
});

describe("the closed chat panel", () => {
  test("is inert and aria-hidden, and none of its controls take focus", async () => {
    await mountChrome();
    expectClosed();

    const controls = Array.from(panel().querySelectorAll<HTMLElement>(FOCUSABLE));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      act(() => control.focus());
      expect(document.activeElement).not.toBe(control);
    }
  });

  test("does not hand the composer focus on load", async () => {
    await mountChrome();
    expect(document.activeElement).not.toBe(textarea());
    expect(panel().contains(document.activeElement)).toBe(false);
  });
});

describe("opening the chat panel", () => {
  test("from the floating toggle clears inert and focuses the composer", async () => {
    await mountChrome();
    await act(async () => toggleButton()?.click());
    expectOpen();
    expect(document.activeElement).toBe(textarea());
  });

  test("with ⌘K clears inert and focuses the composer", async () => {
    await mountChrome();
    await press("k", { metaKey: true });
    expectOpen();
    expect(document.activeElement).toBe(textarea());
  });

  test("on the phone layout clears inert but leaves the composer unfocused", async () => {
    const viewport = window as unknown as {
      innerWidth: number;
      innerHeight: number;
      happyDOM: { setViewport(v: { width: number; height: number }): void };
    };
    const desktop = { width: viewport.innerWidth, height: viewport.innerHeight };
    viewport.happyDOM.setViewport({ width: 390, height: 844 });
    try {
      await mountChrome();
      await act(async () => toggleButton()?.click());
      expectOpen();
      expect(document.activeElement).not.toBe(textarea());
    } finally {
      viewport.happyDOM.setViewport(desktop);
    }
  });
});

describe("closing the chat panel with focus inside it", () => {
  test("with Esc moves focus to the floating toggle", async () => {
    await mountChrome();
    await press("k", { metaKey: true });
    expect(document.activeElement).toBe(textarea());

    await press("Escape");
    expectClosed();
    expect(panel().contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(toggleButton());
  });

  test("with the Close button moves focus to the floating toggle", async () => {
    await mountChrome();
    await press("k", { metaKey: true });
    const close = panel().querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    if (!close) throw new Error("Close button not rendered");
    act(() => close.focus());

    await act(async () => close.click());
    expectClosed();
    expect(panel().contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(toggleButton());
  });
});

describe("closing the chat panel with focus outside it", () => {
  test("leaves focus where the user put it", async () => {
    await mountChrome();
    await press("k", { metaKey: true });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      act(() => outside.focus());
      expect(document.activeElement).toBe(outside);

      await press("Escape");
      expectClosed();
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});
