// ---------------------------------------------------------------------------
// ChatProvider — workspace re-scope (the panel follows the focused workspace).
//
// A conversation lives in exactly one workspace. When the focused workspace
// changes from one workspace to a DIFFERENT one, the open conversation clears
// and the panel resets to a fresh draft in the newly-focused workspace. It does
// NOT clear when the focus is unchanged (e.g. navigating within the same
// workspace or opening a conversation from its own workspace's list).
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

mock.module("../api/client", () => ({
  ...realClient,
  // ChatProvider fetches the participant map (manage_users) on mount.
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

mock.module("../context/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ activeWorkspace: mockActiveWorkspace }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ChatProvider, useChatContext } = await import("../context/ChatContext");
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

    // Navigate to a home / identity route — no focused workspace. Must NOT clear
    // (and must NOT update the tracked focus), so returning re-scopes correctly.
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
