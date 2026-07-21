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

mock.module("../api/client", () => ({
  ...realClient,
  // Stub any incidental tool call ChatProvider makes on mount.
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
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

// Probe that publishes the live conversationId out of the context.
let observedConversationId: string | null | undefined;
function Probe(): null {
  observedConversationId = useChatContext().conversationId;
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

async function mountHarness(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/w/alpha/overview"] },
        React.createElement(
          WorkspaceProvider,
          { initialWorkspaces: [WS_A, WS_B], initialActiveId: "ws_a" },
          React.createElement(Drivers),
          React.createElement(
            ChatProvider,
            {
              initialConversationId: "conv_existing",
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
  setActiveWorkspace = null;
  navigate = null;
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

    // Switch the focused workspace A → B.
    await act(async () => setActiveWorkspace?.(WS_B));

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
    await act(async () => setActiveWorkspace?.(WS_B));
    expect(observedConversationId).toBeNull();

    // B → A re-scopes again to a fresh draft — the prior A conversation is NOT
    // resurrected into the panel (it lives in A's conversation list).
    await act(async () => setActiveWorkspace?.(WS_A));
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
    await act(async () => navigate?.("/w/alpha/overview"));
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
      navigate?.("/w/bravo/overview");
    });
    expect(observedConversationId).toBeNull();
  });
});
