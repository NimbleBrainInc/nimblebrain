// ---------------------------------------------------------------------------
// ChatProvider — workspace re-scope (the panel follows the focused workspace).
//
// A conversation lives in exactly one workspace. When the focused workspace
// changes from one workspace to a DIFFERENT one, the open conversation clears
// and the panel resets to a fresh draft in the newly-focused workspace. It does
// NOT clear when the focus is unchanged (e.g. navigating within the same
// workspace or opening a conversation from its own workspace's list).
//
// Focus is driven through the REAL `WorkspaceProvider` + router, exactly as
// production derives it (`ChatContext`: `pathname.startsWith("/w/") ?
// activeWorkspace?.id ?? null : null`) — a workspace switch is `setActiveWorkspace`,
// and "home / no focus" is navigating off `/w/`. This test deliberately does NOT
// `mock.module("../context/WorkspaceContext", …)`: bun module mocks are
// process-global, and a partial mock here leaks `workspaces === undefined` into
// other files that use the real provider (issue #680).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The workspace the mocked `conversations__get` reports for a loaded
// conversation — how a test says "this conversation lives in workspace X". null
// ⇒ unstamped (a legacy record with no workspaceId), which the panel must leave
// alone (the client's "unknown ⇒ don't reconcile" rule).
let mockConversationWorkspaceId: string | null = "ws_a";
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
            ...(mockConversationWorkspaceId ? { workspaceId: mockConversationWorkspaceId } : {}),
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

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, useNavigate } = await import("react-router-dom");
const { ChatProvider, useChatContext } = await import("../context/ChatContext");
const { WorkspaceProvider, useWorkspaceContext } = await import("../context/WorkspaceContext");
const { chatStore } = await import("../hooks/chat-store");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

function ws(id: string, name: string): WorkspaceInfo {
  return { id, name, bundles: [], memberCount: 1, isPersonal: false, userRole: "admin" };
}
const WS_A = ws("ws_a", "Alpha");
const WS_B = ws("ws_b", "Bravo");

// Probe that publishes the live conversationId (and the send fn) out of the context.
let observedConversationId: string | null | undefined;
let capturedSendMessage: ((text: string) => Promise<void>) | null = null;
function Probe(): null {
  const ctx = useChatContext();
  observedConversationId = ctx.conversationId;
  capturedSendMessage = ctx.sendMessage;
  return null;
}

// Captures the real focus drivers so a test can switch workspace / route
// in-place — ChatProvider stays mounted across the switch (so its
// useState/useRef survive), and both drivers re-render it the way production does.
let setActiveWorkspace: ((next: WorkspaceInfo) => void) | null = null;
let navigate: ((to: string) => void) | null = null;
function Drivers(): null {
  setActiveWorkspace = useWorkspaceContext().setActiveWorkspace;
  navigate = useNavigate();
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function mountHarness(opts?: {
  route?: string;
  activeId?: string;
  convId?: string;
}): Promise<void> {
  const route = opts?.route ?? "/w/a/overview";
  const activeId = opts?.activeId ?? "ws_a";
  const convId = opts?.convId ?? "conv_existing";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [route] },
        React.createElement(
          WorkspaceProvider,
          { initialWorkspaces: [WS_A, WS_B], initialActiveId: activeId },
          React.createElement(Drivers),
          React.createElement(
            ChatProvider,
            {
              initialConversationId: convId,
              currentUserId: "u1",
              // Provide config so the provider skips the get_config tool call.
              initialConfig: {
                configuredProviders: [],
                defaultModel: "anthropic:claude-sonnet-4-6",
              },
            },
            React.createElement(Probe),
          ),
        ),
      ),
    );
  });
}

beforeEach(() => {
  chatStore.reset();
  observedConversationId = undefined;
  capturedSendMessage = null;
  setActiveWorkspace = null;
  navigate = null;
  mockConversationWorkspaceId = "ws_a";
  startCalls = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ChatProvider re-scopes the panel on a workspace switch", () => {
  test("switching to a different workspace clears the open conversation", async () => {
    await mountHarness();
    // Mounted in workspace A with a conversation open — not cleared on mount.
    expect(observedConversationId).toBe("conv_existing");

    // Switch the focused workspace A → B (WorkspaceNav sets focus and navigates).
    await act(async () => {
      setActiveWorkspace?.(WS_B);
      navigate?.("/w/b/overview");
    });

    // The conversation (which belongs to A) is gone; the panel is a fresh draft
    // scoped to B (drafts carry a null conversationId).
    expect(observedConversationId).toBeNull();
  });

  test("a re-render with the SAME focused workspace does not clear the conversation", async () => {
    await mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Re-select the SAME focused workspace (a new object, same id) — the focus
    // is unchanged, so it must NOT re-scope.
    await act(async () => setActiveWorkspace?.(ws("ws_a", "Alpha")));

    expect(observedConversationId).toBe("conv_existing");
  });

  test("returning to the original workspace starts fresh, not resurrecting the prior chat", async () => {
    await mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // A → B clears.
    await act(async () => {
      setActiveWorkspace?.(WS_B);
      navigate?.("/w/b/overview");
    });
    expect(observedConversationId).toBeNull();

    // B → A re-scopes again to a fresh draft — the prior A conversation is NOT
    // resurrected into the panel (it lives in A's conversation list).
    await act(async () => {
      setActiveWorkspace?.(WS_A);
      navigate?.("/w/a/overview");
    });
    expect(observedConversationId).toBeNull();
  });

  test("A → home (null focus) → A keeps the conversation (null is held, not reset)", async () => {
    await mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Home / identity route — no focused workspace. Navigating off `/w/` yields
    // `focusWorkspaceId === null`, which ChatProvider HOLDS (does not clear, does
    // not update the tracked focus), so returning re-scopes correctly.
    await act(async () => navigate?.("/"));
    expect(observedConversationId).toBe("conv_existing");

    // Back to the SAME workspace A — still the same conversation, untouched.
    await act(async () => navigate?.("/w/a/overview"));
    expect(observedConversationId).toBe("conv_existing");
  });

  test("A → home (null focus) → B re-scopes (the held focus is A, B differs)", async () => {
    await mountHarness();
    expect(observedConversationId).toBe("conv_existing");

    // Through home (null) — held.
    await act(async () => navigate?.("/"));
    expect(observedConversationId).toBe("conv_existing");

    // Arrive at a DIFFERENT workspace B — re-scopes against the held focus (A).
    await act(async () => {
      setActiveWorkspace?.(WS_B);
      navigate?.("/w/b/overview");
    });
    expect(observedConversationId).toBeNull();
  });
});

describe("ChatProvider reconciles a foreign-workspace conversation after a refresh", () => {
  // The refresh hole: on a fresh page load the panel restores the last
  // conversation (per-tab storage) while the URL points at another workspace.
  // There's no in-session transition to catch it, so once the conversation's own
  // workspace is known the panel must re-scope to a fresh draft in the focused
  // workspace — otherwise a send would resume it in its own workspace, landing
  // the message where the user isn't looking.

  test("mounts a workspace-A conversation while focused on B, then re-scopes once A's workspace is known", async () => {
    // Focused on B at mount (as after refreshing on /w/B); the restored
    // conversation belongs to A (mockConversationWorkspaceId default = ws_a).
    await mountHarness({ route: "/w/b/overview", activeId: "ws_b" });

    // Desync: the panel holds A's conversation while displaying B, because the
    // conversation's own workspace isn't known yet (no transition fired).
    expect(observedConversationId).toBe("conv_existing");

    // The conversation's workspace loads (ws_a ≠ focused ws_b) → reconcile to a
    // fresh draft in the focused workspace (drafts carry a null conversationId).
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBeNull();
  });

  test("null → B async focus resolves after the conversation loads, then re-scopes", async () => {
    // Focus not yet resolved at mount (home route → focusWorkspaceId null).
    await mountHarness({ route: "/" });
    expect(observedConversationId).toBe("conv_existing");

    // Conversation's workspace loads (ws_a) while focus is still null — held,
    // not reconciled (can't reconcile against an unresolved focus).
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBe("conv_existing");

    // Focus resolves to B (≠ the conversation's ws_a) → reconcile now fires.
    await act(async () => {
      setActiveWorkspace?.(WS_B);
      navigate?.("/w/b/overview");
    });
    expect(observedConversationId).toBeNull();
  });

  test("a matching focus (conversation's own workspace) is NOT reconciled away", async () => {
    // Focused on A, conversation lives in A — the normal in-workspace resume.
    await mountHarness({ route: "/w/a/overview", activeId: "ws_a" });
    expect(observedConversationId).toBe("conv_existing");

    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    // Workspace matches focus → the conversation stays open.
    expect(observedConversationId).toBe("conv_existing");
  });

  test("an unstamped (legacy) conversation is left alone — unknown workspace ⇒ don't reconcile", async () => {
    // A legacy record with no stamped workspaceId: conversations__get omits it,
    // so the panel can't know the conversation's workspace and must NOT clear it.
    // (This is why the fix lives on the client: it fails safe when the workspace
    // is unknown, rather than rejecting a resume the way a server guard would.)
    mockConversationWorkspaceId = null;
    await mountHarness({ route: "/w/b/overview", activeId: "ws_b" });
    expect(observedConversationId).toBe("conv_existing");

    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBe("conv_existing");
  });

  test("a send after the reconcile starts a fresh turn, never resuming the foreign conversation", async () => {
    // The production configuration (ChatProvider), end to end: focused on B with
    // a restored workspace-A conversation, the reconcile re-scopes to a fresh
    // draft, so a send starts a new turn in B rather than resuming A. The
    // reconcile is the single guard — this is the config the app actually builds.
    await mountHarness({ route: "/w/b/overview", activeId: "ws_b" });
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBeNull();

    await act(async () => {
      await capturedSendMessage?.("hello");
    });
    // A fresh turn (no conversationId) — the message can't land in ws_a.
    expect(startCalls.length).toBe(1);
    expect(startCalls[0].conversationId).toBeUndefined();
  });
});

describe("Focus is route-derived, so bootstrap's default is never a phantom switch", () => {
  // A cold load sends no `X-Workspace-Id` (the ambient id is null until bootstrap
  // returns), so the server answers with its default focus — the user's personal
  // workspace — even when the URL is another workspace. `activeWorkspace` therefore
  // starts on that default and only reconciles to the route a render later. Focus
  // must not follow that intermediate value: it is indistinguishable from a real
  // workspace switch, and clearing on it discards the very conversation the
  // per-tab restore just reopened.

  test("a restored conversation survives a reload in its own (non-default) workspace", async () => {
    // Viewing B, restoring B's conversation — the correct one. `activeId` is A,
    // standing in for bootstrap's personal-workspace default.
    mockConversationWorkspaceId = "ws_b";
    await mountHarness({ route: "/w/b/overview", activeId: "ws_a" });
    expect(observedConversationId).toBe("conv_existing");

    // `WorkspaceRouteGuard` reconciles `activeWorkspace` to the route in its mount
    // effect. Route-derived focus was already B, so this moves nothing.
    await act(async () => {
      setActiveWorkspace?.(WS_B);
    });
    expect(observedConversationId).toBe("conv_existing");

    // The conversation's own workspace arrives and matches the focus.
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBe("conv_existing");
  });

  test("a non-member slug holds focus at null rather than inventing one", async () => {
    // `WorkspaceRouteGuard` bounces this route; until it does, focus must read as
    // null (held, like home) so neither trigger fires against a phantom id.
    mockConversationWorkspaceId = "ws_a";
    await mountHarness({ route: "/w/nope/overview", activeId: "ws_a" });
    await act(async () => {
      await chatStore.loadConversation("conv_existing");
    });
    expect(observedConversationId).toBe("conv_existing");
  });
});
