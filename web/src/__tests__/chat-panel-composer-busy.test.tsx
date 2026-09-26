// ---------------------------------------------------------------------------
// ChatPanel — a running turn gates sending, never composing.
//
// The composer is editable for the whole of a turn, its draft belongs to the
// conversation it was written in, and a turn ending returns the cursor to it
// without taking focus the user put somewhere else. This mounts the real panel
// over the real provider and drives the textarea the way a person does.
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

/** Makes the workspace's `/chat/start` fail, as a network error on the first send would. */
let failStart = false;

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (server: string, tool: string, args?: { id?: string }) => {
    if (server === "conversations" && tool === "get") {
      return {
        isError: false,
        structuredContent: {
          metadata: { id: args?.id ?? "conv_other", ownerId: "u1", workspaceId: "ws_a" },
          messages: [],
        },
        content: [],
      };
    }
    return { structuredContent: null, content: [] };
  }),
  startChatTurn: mock(async () => {
    if (failStart) throw new Error("start failed");
    return { conversationId: "conv_busy" };
  }),
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ChatProvider, useChatContext } = await import("../context/ChatContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { ChatPanel } = await import("../components/ChatPanel");
const { chatStore } = await import("../hooks/chat-store");

import type { ChatContextValue } from "../context/ChatContext";
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
/** The provider's live value, for driving New chat and Recent the way the shell does. */
let chat: ChatContextValue;

function ChatProbe() {
  chat = useChatContext();
  return null;
}

async function render(isStreaming: boolean): Promise<void> {
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
            React.createElement(ChatProbe),
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

async function mountPanel(isStreaming: boolean): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await render(isStreaming);
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
  failStart = false;
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

describe("an unsent chat's draft", () => {
  test("survives New chat, which returns to the same unsent chat", async () => {
    await mountPanel(false);
    await type("typed, never sent");
    await act(async () => chat.newConversation());
    expect(textarea().value).toBe("typed, never sent");
  });

  test("waits in its own chat while a Recent conversation is open", async () => {
    await mountPanel(false);
    await type("typed, never sent");

    await act(async () => chat.loadConversation("conv_other"));
    expect(textarea().value).toBe("");

    await act(async () => chat.newConversation());
    expect(textarea().value).toBe("typed, never sent");
  });

  test("stops being the chat New chat returns to once its first send fails", async () => {
    await mountPanel(false);
    failStart = true;
    await act(async () => chat.sendMessage("hello"));
    expect(chat.canRetry).toBe(true);
    const failed = chat.conversationKey;

    await act(async () => chat.newConversation());
    expect(chat.conversationKey).not.toBe(failed);
    expect(chat.error).toBeNull();
    expect(chat.canRetry).toBe(false);
  });
});

describe("focus when a turn ends", () => {
  test("returns to the textarea from the composer's own Stop button", async () => {
    await mountPanel(true);
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]');
    act(() => stop?.focus());
    expect(document.activeElement).toBe(stop);

    await render(false);
    expect(document.activeElement).toBe(textarea());
  });

  test("stays on a field the user moved to outside the composer", async () => {
    await mountPanel(true);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    act(() => outside.focus());

    await render(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
