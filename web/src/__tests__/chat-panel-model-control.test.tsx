// ---------------------------------------------------------------------------
// ChatPanel — the model control states a binding or says nothing.
//
// A conversation created before the binding existed carries no model, and the
// runtime resolves its turns from current config instead. There is nothing true
// for the control to state, and a pick there would genuinely retarget an
// existing conversation — so the control does not render at all.
//
// This is the seam that has been wrong twice: once because the client could not
// learn a binding it did have, and once because the server announced a binding
// that did not exist. Both times the picker's own tests stayed green, because
// they drive the component with hand-built props. This mounts the real panel
// over the real provider and lets `conversations__get` decide.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap. Same patch the
// RecentConversationsPopover suite uses.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

/** The pin `conversations__get` reports. `null` ⇒ a record with no binding. */
let mockConversationModel: string | null = null;

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (server: string, tool: string, args?: { id?: string }) => {
    if (server === "conversations" && tool === "get") {
      return {
        isError: false,
        structuredContent: {
          metadata: {
            id: args?.id ?? "conv_existing",
            ownerId: "u1",
            workspaceId: "ws_a",
            title: null,
            ...(mockConversationModel ? { model: mockConversationModel } : {}),
          },
          messages: [],
        },
        content: [],
      };
    }
    return { structuredContent: null, content: [] };
  }),
  startChatTurn: mock(async () => ({ conversationId: "conv_existing" })),
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
  bundles: [],
  memberCount: 1,
  isPersonal: false,
  userRole: "admin",
};

/** Two models so the control has something to offer when it does render. */
const AVAILABLE = {
  anthropic: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function mountPanel(convId?: string): Promise<void> {
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
              ...(convId ? { initialConversationId: convId } : {}),
              currentUserId: "u1",
              initialConfig: {
                configuredProviders: ["anthropic"],
                newConversationModel: "anthropic:claude-sonnet-5",
                availableModels: AVAILABLE,
              },
            },
            React.createElement(ChatPanel, {
              messages: [],
              isStreaming: false,
              error: null,
              sendMessage: async () => {},
              newConversation: () => {},
            }),
          ),
        ),
      ),
    );
  });
  // Opening an existing conversation loads its metadata, exactly as the
  // conversation list does — `initialConversationId` alone only sets the id.
  // Without this the control would be absent because nothing had arrived yet,
  // and the no-binding case would pass for the wrong reason.
  if (convId) {
    await act(async () => {
      await chatStore.loadConversation(convId);
    });
  }
}

/** The control is the only listbox trigger in the composer. */
function modelControl(): HTMLElement | null {
  return container.querySelector('button[aria-haspopup="listbox"]');
}

beforeEach(() => {
  chatStore.reset();
  mockConversationModel = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the composer's model control", () => {
  test("offers a choice before there is a conversation to bind", async () => {
    await mountPanel();
    expect(modelControl()?.textContent).toContain("Sonnet 5");
  });

  test("states the binding of a conversation that has one", async () => {
    mockConversationModel = "anthropic:claude-haiku-4-5";
    await mountPanel("conv_existing");
    expect(modelControl()?.textContent).toContain("Haiku 4.5");
  });

  test("renders nothing on a conversation with no binding", async () => {
    // Not "shows the default": naming a model here would assert a binding the
    // conversation does not have, and picking one would really change it.
    mockConversationModel = null;
    await mountPanel("conv_existing");
    // Metadata did arrive — it just carries no model, which is the branch
    // under test rather than "nothing loaded yet".
    expect(chatStore.getSnapshot("conv_existing").meta).not.toBeNull();
    expect(modelControl()).toBeNull();
  });
});
