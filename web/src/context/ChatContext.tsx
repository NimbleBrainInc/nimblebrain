import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import { callTool } from "../api/client";
import { chatStore } from "../hooks/chat-store";
import type { UseChatReturn } from "../hooks/useChat";
import { useChat } from "../hooks/useChat";
import { toWsId } from "../lib/workspace-slug";
import type { AppContext, ConfigInfo, ToolCallResult } from "../types";
import { useWorkspaceContext } from "./WorkspaceContext";

// ---------------------------------------------------------------------------
// ChatConfigContext — stable values that change rarely (config, preferences)
// ---------------------------------------------------------------------------

export interface ChatConfigContextValue {
  configuredProviders: string[];
  refreshConfig: () => void;
  preferences: ConfigInfo["preferences"];
  currentUserId?: string;
}

const ChatConfigContext = createContext<ChatConfigContextValue | null>(null);

// ---------------------------------------------------------------------------
// ChatContext — streaming/conversation state that changes per-tick
// ---------------------------------------------------------------------------

export interface ChatContextValue extends Omit<UseChatReturn, "sendMessage"> {
  sendMessage: (text: string, appContext?: AppContext, files?: File[]) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** Extract the config payload from a get_config result, preferring structuredContent over the first text block (parsed as JSON, else the raw block). */
function extractConfigPayload(result: ToolCallResult): unknown {
  const raw = result.structuredContent;
  if (raw) return raw;
  const block = result.content?.[0];
  if (!block) return raw;
  if (!block.text) return block;
  try {
    return JSON.parse(block.text);
  } catch {
    return block;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ChatProviderProps {
  initialConversationId?: string;
  children: ReactNode;
  /** Pre-fetched config from bootstrap. Skips the tool call when provided. */
  initialConfig?: {
    configuredProviders: string[];
    preferences?: ConfigInfo["preferences"];
  };
  /** Current user's ID (from bootstrap). */
  currentUserId?: string;
}

/** Provider that wraps useChat and exposes its state via context. */
export function ChatProvider({
  initialConversationId,
  children,
  initialConfig,
  currentUserId,
}: ChatProviderProps) {
  // The chat is FOCUSED on the workspace the user is currently VIEWING — the
  // `/w/:slug` route. This is situational context for the agent (which
  // workspace/app is on screen) and the source of the workspace briefing. On
  // home / identity routes (`/`, `/conversations`) there's no focus, so the
  // chat is identity-level (no "current workspace"). Route-derived, NOT the
  // persisted global active workspace.
  //
  // Read straight off the URL, never from the React-state `activeWorkspace`.
  // The slug is the single source of truth (see `WorkspaceRouteGuard`), so a
  // route-derived focus is correct on the FIRST frame. `activeWorkspace` is not:
  // it is seeded from bootstrap's default and only reconciled to the route a
  // render later, and that intermediate value is indistinguishable from a real
  // workspace switch — which is what trigger (1) below keys off.
  //
  // Membership-gated so an unknown or non-member slug yields `null` (hold, same
  // as home) rather than a phantom id; `WorkspaceRouteGuard` bounces that route
  // anyway. While the workspace list is still loading, `workspaces` is empty and
  // focus holds at `null` — the panel waits rather than guessing.
  const location = useLocation();
  const { workspaces } = useWorkspaceContext();
  const routeSlug = location.pathname.startsWith("/w/")
    ? (location.pathname.split("/")[2] ?? null)
    : null;
  const routeWsId = routeSlug ? toWsId(routeSlug) : null;
  const focusWorkspaceId =
    routeWsId && workspaces.some((w) => w.id === routeWsId) ? routeWsId : null;
  const chat = useChat(initialConversationId, currentUserId);

  // Drop every cached conversation slice when the signed-in user changes
  // (logout → login as someone else in the same tab). The store is a module
  // singleton that outlives this provider's remounts, so stale slices would
  // otherwise leak across users. This is the BROAD reset (nuke all slices);
  // a workspace switch uses the narrow per-conversation clear below.
  const prevUserRef = useRef(currentUserId);
  useEffect(() => {
    if (prevUserRef.current !== currentUserId) {
      chatStore.reset();
      prevUserRef.current = currentUserId;
    }
  }, [currentUserId]);

  // Re-scope the panel to the focused workspace. The chat panel is
  // workspace-scoped: a conversation lives in exactly one workspace, so when the
  // panel holds a conversation from a DIFFERENT workspace than the one focused,
  // it clears and resets to a fresh, empty draft in the focused workspace. The
  // panel stays open — the assistant is still there; it just no longer shows a
  // conversation from a workspace you aren't viewing.
  //
  // Narrow on purpose: this clears only the OPEN conversation
  // (`newConversation()` → a fresh draft slice), unlike the identity reset above
  // which nukes every cached slice. Other workspaces' cached slices stay intact.
  //
  // Two complementary triggers:
  //
  //  (1) In-session workspace→workspace TRANSITION, tracked off the focus value.
  //      The open conversation belongs to the workspace we just left, so clear
  //      it. This fires even before the conversation's own workspace has loaded
  //      — the transition itself is the signal. `null` focus (home / identity
  //      routes, or focus not yet resolved) is held, not tracked: A→home→B still
  //      re-scopes on arrival at B, while A→home→A does not.
  //
  //  (2) Mount / async-focus RECONCILE — the refresh hole. On the first render
  //      after a reload (and on a `null → workspace` async resolve) there is no
  //      transition for (1) to observe, so a conversation restored from another
  //      workspace (e.g. per-tab `getSavedConversationId`) would otherwise stay
  //      active while the URL shows a different workspace, and a send would
  //      resume it there (a cross-workspace mis-target). Fall back to comparing
  //      the conversation's OWN workspace to the focus — but ONLY once that
  //      workspace is KNOWN (`conversationMeta.workspaceId`, loaded from the
  //      server). This is the race guard the transition-only version relied on:
  //      a conversation whose workspace hasn't loaded is left alone, so opening
  //      one from within its own workspace never briefly self-clears.
  //
  // Both triggers depend on focus being route-derived (above): only a real
  // navigation moves it, so (1) sees a transition when — and only when — the URL
  // changes workspace, and (2) never compares against an intermediate value.
  const lastWorkspaceFocusRef = useRef(focusWorkspaceId);
  const { newConversation, conversationId, conversationMeta } = chat;
  const conversationWorkspaceId = conversationMeta?.workspaceId ?? null;
  useEffect(() => {
    if (focusWorkspaceId === null) return; // home / identity, or not-yet-resolved — hold
    const prevFocus = lastWorkspaceFocusRef.current;
    lastWorkspaceFocusRef.current = focusWorkspaceId;

    // (1) Transition: the conversation belongs to the workspace we just left.
    if (prevFocus !== null && prevFocus !== focusWorkspaceId) {
      newConversation();
      return;
    }

    // (2) Reconcile: no transition to catch it (mount / async focus), so compare
    // the conversation's own workspace — once known — to the focus.
    if (
      conversationId !== null &&
      conversationWorkspaceId !== null &&
      conversationWorkspaceId !== focusWorkspaceId
    ) {
      newConversation();
    }
  }, [focusWorkspaceId, conversationId, conversationWorkspaceId, newConversation]);

  // Dev helper: window.__nb.simulateError("some error message")
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!window.__nb) window.__nb = {};
    window.__nb.simulateError = chat.simulateError;
    return () => {
      if (window.__nb) {
        delete window.__nb.simulateError;
        if (Object.keys(window.__nb).length === 0) delete window.__nb;
      }
    };
  }, [chat.simulateError]);

  // -- Config state (stable) --
  const [configuredProviders, setConfiguredProviders] = useState<string[]>(
    initialConfig?.configuredProviders ?? [],
  );
  const [preferences, setPreferences] = useState<ConfigInfo["preferences"]>(
    initialConfig?.preferences,
  );

  const fetchConfig = useCallback(() => {
    callTool("nb", "get_config")
      .then((result) => {
        const data = extractConfigPayload(result) as ConfigInfo;
        setConfiguredProviders(data.configuredProviders);
        if (data.preferences) setPreferences(data.preferences);
      })
      .catch(() => {
        // Config fetch failed — keep defaults
      });
  }, []);

  // Only fetch config on mount if no bootstrap data was provided
  useEffect(() => {
    if (!initialConfig) fetchConfig();
  }, [fetchConfig, initialConfig]);

  // Cross-tab / refresh sync is now handled by the per-conversation turn
  // stream itself (server-authoritative): every viewer attaches to
  // GET /v1/conversations/:id/events, which replays the in-flight turn and
  // tails live. No separate remote-event bridge needed.

  // No model argument: the model a turn runs on is resolved server-side and,
  // for a conversation created since the model pin, fixed at create. A client
  // that chose one per turn would be choosing per browser — scoped to one
  // device, invisible to the API and to scheduled runs.
  const wrappedSendMessage = useCallback(
    (text: string, appContext?: AppContext, files?: File[]) => {
      return chat.sendMessage(text, appContext, undefined, files);
    },
    [chat.sendMessage],
  );

  // -- Config context value (changes rarely) --
  const configValue = useMemo<ChatConfigContextValue>(
    () => ({
      configuredProviders,
      refreshConfig: fetchConfig,
      preferences,
      currentUserId,
    }),
    [configuredProviders, fetchConfig, preferences, currentUserId],
  );

  // -- Chat context value (changes per streaming tick) --
  const chatValue = useMemo<ChatContextValue>(
    () => ({
      ...chat,
      sendMessage: wrappedSendMessage,
    }),
    [chat, wrappedSendMessage],
  );

  return (
    <ChatConfigContext value={configValue}>
      <ChatContext value={chatValue}>{children}</ChatContext>
    </ChatConfigContext>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Consume stable config values (preferences, providers, instance default model). */
export function useChatConfigContext(): ChatConfigContextValue {
  const ctx = useContext(ChatConfigContext);
  if (!ctx) {
    throw new Error("useChatConfigContext must be used within a ChatProvider");
  }
  return ctx;
}

/** Consume streaming/conversation state (messages, streaming, tools). */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return ctx;
}
