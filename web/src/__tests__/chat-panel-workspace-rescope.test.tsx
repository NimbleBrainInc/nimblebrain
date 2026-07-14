// ---------------------------------------------------------------------------
// ChatProvider — workspace re-scope (the panel follows the focused workspace).
//
// A conversation lives in exactly one workspace. When the panel holds a
// conversation from a DIFFERENT workspace than the one focused, it clears and
// resets to a fresh draft in the focused workspace. It does NOT clear when the
// focus is unchanged (e.g. navigating within the same workspace or opening a
// conversation from its own workspace's list).
//
// Two trigger paths, both covered here:
//   1. In-session workspace→workspace transition (the original re-scope).
//   2. Mount / async-focus reconcile — the refresh hole: after a reload the
//      panel restores a conversation (per-tab storage) that may belong to a
//      workspace other than the URL's, and there's no transition to catch it.
//      Reconcile once the conversation's own workspace is known. Plus a
//      send-time backstop in `useChat` so a stray send can't mis-target either.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MockWorkspace {
  id: string;
  name: string;
}

// The focused workspace, driven by the test. `useWorkspaceContext` is mocked to
// return it; changing it + re-rendering simulates a workspace switch.
let mockActiveWorkspace: MockWorkspace | null = { id: "ws_a", name: "Alpha" };

// The workspace the mocked `conversations__get` reports for a loaded
// conversation — how a test says "this conversation lives in workspace X".
let mockConversationWorkspaceId: string = "ws_a";
// Captured `startChatTurn` calls — asserts which conversation (if any) a send
// resumes. A fresh draft carries no `conversationId`.
let startCalls: Array<{ conversationId?: string }> = [];

mock.module("../api/client", () => ({
  ...realClient,
  // `conversations__get` reports the conversation's own workspace (what the
  // panel reconciles against); every other incidental call stubs empty.
  callTool: mock(async (server: string, tool: string, args?: { id?: string }) => {
    if (server === "conversations" && tool === "get") {
      return {
        isError: false,
        structuredContent: {
          metadata: {
            id: args?.id ?? "conv_existing",
            ownerId: "u1",
            workspaceId: mockConversationWorkspaceId,
            title: null,
          },
          messages: [],
        },
        content: [],
      };
    }
    return { structuredContent: null, content: [] };
  }),
  // Capture the resumed conversation id (undefined ⇒ a fresh turn).
  startChatTurn: mock(async (req: { conversationId?: string }) => {
    startCalls.push({ conversationId: req.conversationId });
    return { conversationId: req.conversationId ?? "conv_new" };
  }),
}));

// No real SSE — `loadConversation` sets the slice meta then opens a stream; the
// no-op connection keeps the reconcile logic under test without a network.
mock.module("../api/conversation-stream", () => ({
  connectConversationStream: () => ({ close() {} }),
}));

mock.module("../context/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ activeWorkspace: mockActiveWorkspace }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { renderHook } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { ChatProvider, useChatContext } = await import("../context/ChatContext");
const { useChat } = await import("../hooks/useChat");
const { chatStore } = await import("../hooks/chat-store");

// Probe that publishes the live conversationId out of the context.
let observedConversationId: string | null | undefined;
function Probe(): null {
  observedConversationId = useChatContext().conversationId;
  return null;
}

// A persistent harness: ChatProvider stays mounted across re-renders (so its
// useState/useRef survive a workspace switch), and `rerender` forces a re-read
// of the mocked workspace focus.
let forceRerender: (() => void) | null = null;
function Harness(): React.ReactElement {
  const [, setN] = React.useState(0);
  forceRerender = () => setN((n) => n + 1);
  return React.createElement(
    MemoryRouter,
    { initialEntries: ["/w/alpha/overview"] },
    React.createElement(
      ChatProvider,
      {
        initialConversationId: "conv_existing",
        currentUserId: "u1",
        // Provide config so the provider skips the get_config tool call.
        initialConfig: { configuredProviders: [], defaultModel: "anthropic:claude-sonnet-4-6" },
      },
      React.createElement(Probe),
    ),
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

function mountHarness(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(React.createElement(Harness));
  });
}

beforeEach(() => {
  chatStore.reset();
  mockActiveWorkspace = { id: "ws_a", name: "Alpha" };
  mockConversationWorkspaceId = "ws_a";
  startCalls = [];
  observedConversationId = undefined;
});

describe("ChatProvider re-scopes the panel on a workspace switch", () => {
  test("switching to a different workspace clears the open conversation", () => {
    mountHarness();
    // Mounted in workspace A with a conversation open — not cleared on mount.
    expect(observedConversationId).toBe("conv_existing");

    // Switch the focused workspace A → B.
    act(() => {
      mockActiveWorkspace = { id: "ws_b", name: "Bravo" };
      forceRerender?.();
    });

    // The conversation (which belongs to A) is gone; the panel is a fresh draft
    // scoped to B (drafts carry a null conversationId).
    expect(observedConversationId).toBeNull();

    act(() => root.unmount());
  });

  test("a re-render with the SAME focused workspace does not clear the conversation", () => {
    mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Re-render without changing the focused workspace (e.g. an unrelated state
    // tick, or navigating within the same workspace). Must NOT re-scope.
    act(() => {
      forceRerender?.();
    });

    expect(observedConversationId).toBe("conv_existing");

    act(() => root.unmount());
  });

  test("returning to the original workspace starts fresh, not resurrecting the prior chat", () => {
    mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // A → B clears.
    act(() => {
      mockActiveWorkspace = { id: "ws_b", name: "Bravo" };
      forceRerender?.();
    });
    expect(observedConversationId).toBeNull();

    // B → A re-scopes again to a fresh draft — the prior A conversation is NOT
    // resurrected into the panel (it lives in A's conversation list).
    act(() => {
      mockActiveWorkspace = { id: "ws_a", name: "Alpha" };
      forceRerender?.();
    });
    expect(observedConversationId).toBeNull();

    act(() => root.unmount());
  });

  test("A → home (null focus) → A keeps the conversation (null is held, not reset)", () => {
    mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Home / identity route — no focused workspace. Nulling the active workspace
    // is a faithful proxy for navigating off `/w/:slug`: `ChatProvider` derives
    // `focusWorkspaceId = pathname.startsWith("/w/") ? activeWorkspace?.id ?? null : null`,
    // so both a non-`/w/` route and a null active workspace yield the same
    // `focusWorkspaceId === null` the effect branches on. Must NOT clear (and must
    // NOT update the tracked focus), so returning re-scopes correctly.
    act(() => {
      mockActiveWorkspace = null;
      forceRerender?.();
    });
    expect(observedConversationId).toBe("conv_existing");

    // Back to the SAME workspace A — still the same conversation, untouched.
    act(() => {
      mockActiveWorkspace = { id: "ws_a", name: "Alpha" };
      forceRerender?.();
    });
    expect(observedConversationId).toBe("conv_existing");

    act(() => root.unmount());
  });

  test("A → home (null focus) → B re-scopes (the held focus is A, B differs)", () => {
    mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Through home (null) — held.
    act(() => {
      mockActiveWorkspace = null;
      forceRerender?.();
    });
    expect(observedConversationId).toBe("conv_existing");

    // Arrive at a DIFFERENT workspace B — re-scopes against the held focus (A).
    act(() => {
      mockActiveWorkspace = { id: "ws_b", name: "Bravo" };
      forceRerender?.();
    });
    expect(observedConversationId).toBeNull();

    act(() => root.unmount());
  });
});

describe("ChatProvider reconciles a foreign-workspace conversation after a refresh", () => {
  // The refresh hole: on a fresh page load the panel restores the last
  // conversation (per-tab storage) while the URL points at another workspace.
  // There's no in-session transition to catch it, so the panel would leave the
  // restored conversation active — and a send would RESUME it in its own
  // workspace, landing the message in a workspace the user isn't viewing. Once
  // the conversation's workspace is known, the panel must re-scope to a fresh
  // draft in the focused workspace.

  test("mounts a workspace-A conversation while focused on B, then re-scopes once A's workspace is known", async () => {
    // Focused on B at mount (as after refreshing on /w/B); the restored
    // conversation belongs to A (mockConversationWorkspaceId default = ws_a).
    mockActiveWorkspace = { id: "ws_b", name: "Bravo" };
    mountHarness();

    // Desync: the panel holds A's conversation while displaying B, because the
    // conversation's own workspace isn't known yet (no transition fired).
    expect(observedConversationId).toBe("conv_existing");

    // The conversation's workspace loads (ws_a ≠ focused ws_b) → reconcile to a
    // fresh draft in the focused workspace (drafts carry a null conversationId).
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBeNull();

    act(() => root.unmount());
  });

  test("null → B async focus resolves after the conversation loads, then re-scopes", async () => {
    // Focus not yet resolved at mount (activeWorkspace still loading).
    mockActiveWorkspace = null;
    mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Conversation's workspace loads (ws_a) while focus is still null — held,
    // not reconciled (can't reconcile against an unresolved focus).
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBe("conv_existing");

    // Focus resolves to B (≠ the conversation's ws_a) → reconcile now fires.
    act(() => {
      mockActiveWorkspace = { id: "ws_b", name: "Bravo" };
      forceRerender?.();
    });
    expect(observedConversationId).toBeNull();

    act(() => root.unmount());
  });

  test("a matching focus (conversation's own workspace) is NOT reconciled away", async () => {
    // Focused on A, conversation lives in A — the normal in-workspace resume.
    mockActiveWorkspace = { id: "ws_a", name: "Alpha" };
    mockConversationWorkspaceId = "ws_a";
    mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    // Workspace matches focus → the conversation stays open.
    expect(observedConversationId).toBe("conv_existing");

    act(() => root.unmount());
  });
});

describe("useChat send backstop — never resumes a foreign-workspace conversation", () => {
  // The send-time twin of the reconcile effect: even if a foreign-workspace
  // conversation is still active at send time, `sendMessage` must start a fresh
  // draft in the focused workspace instead of resuming the other conversation.

  test("sending while focused on B does not resume a conversation that lives in A", async () => {
    // Conversation lives in ws_a; the hook is focused on ws_b.
    mockConversationWorkspaceId = "ws_a";
    const { result } = renderHook(() => useChat("conv_existing", "u1", "ws_b"));

    // Load so the slice knows its workspace (ws_a). useChat has no reconcile
    // effect, so the conversation stays active — the backstop is the only guard.
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(result.current.conversationId).toBe("conv_existing");

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    // The send started a FRESH turn (no conversationId) rather than resuming
    // conv_existing — the message can't land in ws_a while viewing ws_b.
    expect(startCalls.length).toBe(1);
    expect(startCalls[0].conversationId).toBeUndefined();
  });

  test("sending while focused on the conversation's own workspace resumes it normally", async () => {
    // Conversation lives in ws_a; the hook is focused on ws_a — a normal resume.
    mockConversationWorkspaceId = "ws_a";
    const { result } = renderHook(() => useChat("conv_existing", "u1", "ws_a"));

    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    // Focus matches the conversation's workspace → resume conv_existing.
    expect(startCalls.length).toBe(1);
    expect(startCalls[0].conversationId).toBe("conv_existing");
  });
});
