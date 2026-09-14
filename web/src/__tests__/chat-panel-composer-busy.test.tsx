// ---------------------------------------------------------------------------
// ChatPanel — a running turn gates sending, never composing.
//
// The composer used to be disabled for the whole turn, so the next message
// could not be written until the reply's terminal frame arrived — which can
// land well after the reply looks finished. This mounts the real panel over the
// real provider and drives the textarea the way a person does.
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
  startChatTurn: mock(async () => ({ conversationId: "conv_busy" })),
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ChatProvider } = await import("../context/ChatContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { ChatPanel } = await import("../components/ChatPanel");
const { chatStore } = await import("../hooks/chat-store");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

const WS_A: WorkspaceInfo = {
  id: "ws_a",
  name: "Alpha",
  connectors: [],
  memberCount: 1,
  isPersonal: false,
  userRole: "admin",
};

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;
let sent: Array<{ text: string }>;

async function mountPanel(isStreaming: boolean): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/w/a/overview"] },
        React.createElement(
          WorkspaceProvider,
          { initialWorkspaces: [WS_A], initialActiveId: "ws_a" },
          React.createElement(
            ChatProvider,
            {
              currentUserId: "u1",
              initialConfig: { configuredProviders: ["anthropic"] },
            },
            React.createElement(ChatPanel, {
              messages: [],
              isStreaming,
              error: null,
              sendMessage: async (text: string) => {
                sent.push({ text });
              },
              newConversation: () => {},
            }),
          ),
        ),
      ),
    );
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("composer textarea not rendered");
  return el;
}

// happy-dom's `dispatchEvent` accepts only its own window's event classes, not
// the runtime's globals.
const win = window as unknown as { Event: typeof Event; KeyboardEvent: typeof KeyboardEvent };

/** Type the way a person does: set the value natively, then fire `input`. */
async function type(value: string): Promise<void> {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el) as HTMLTextAreaElement,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  chatStore.reset();
  sent = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the composer during a turn", () => {
  test("stays editable, and Enter waits instead of sending", async () => {
    await mountPanel(true);
    expect(textarea().disabled).toBe(false);

    await type("the next thought");
    await pressEnter();

    expect(sent).toHaveLength(0);
    expect(textarea().value).toBe("the next thought");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Still replying");
  });

  test("sends on Enter once no turn is running", async () => {
    await mountPanel(false);
    await type("go");
    await pressEnter();
    expect(sent).toEqual([{ text: "go" }]);
  });
});
