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
import { useLocation, useNavigate } from "react-router-dom";
import { callTool } from "../api/client";
import { chatStore } from "../hooks/chat-store";
import type { UseChatReturn } from "../hooks/useChat";
import { useChat } from "../hooks/useChat";
import { toSlug, toWsId } from "../lib/workspace-slug";
import type { AppContext, ConfigInfo, ToolCallResult } from "../types";
import { useWorkspaceContext } from "./WorkspaceContext";

// ---------------------------------------------------------------------------
// ChatConfigContext — stable values that change rarely (config, preferences)
// ---------------------------------------------------------------------------

export interface ChatConfigContextValue {
  configuredProviders: string[];
  newConversationModel?: string;
  availableModels?: ConfigInfo["availableModels"];
  refreshConfig: () => void;
  preferences: ConfigInfo["preferences"];
  currentUserId?: string;
}

const ChatConfigContext = createContext<ChatConfigContextValue | null>(null);

// ---------------------------------------------------------------------------
// ChatContext — streaming/conversation state that changes per-tick
// ---------------------------------------------------------------------------

export interface ChatContextValue extends Omit<UseChatReturn, "sendMessage"> {
  sendMessage: (
    text: string,
    appContext?: AppContext,
    files?: File[],
    model?: string,
  ) => Promise<void>;
  /**
   * Open a conversation the user chose (a deep link, a list, an app's open
   * action). Unlike `loadConversation`, which restores quietly, a conversation
   * opened here takes the user to its own workspace's path once that workspace
   * is known, because a chat runs in the workspace its URL names.
   */
  openConversation: (id: string) => Promise<void>;
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

/**
 * What the panel does when the focused workspace or its conversation's
 * workspace moves (see the comment above the effect in `ChatProvider`):
 * `keep` it, `clear` it, `follow` it to its workspace's path, or note that it
 * has `arrived` in its own workspace.
 */
function scopeAction(s: {
  prevFocus: string | null;
  focus: string;
  conversationId: string | null;
  conversationWorkspaceId: string | null;
  followed: boolean;
  isMember: (wsId: string) => boolean;
}): "keep" | "clear" | "follow" | "arrived" {
  // (1) Transition.
  if (s.prevFocus !== null && s.prevFocus !== s.focus) {
    return s.followed && s.conversationWorkspaceId === s.focus ? "arrived" : "clear";
  }
  // (2) Reconcile, once the conversation's own workspace is known.
  if (s.conversationId === null || s.conversationWorkspaceId === null) return "keep";
  if (s.conversationWorkspaceId === s.focus) return "arrived";
  return s.followed && s.isMember(s.conversationWorkspaceId) ? "follow" : "clear";
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
    newConversationModel?: string;
    availableModels?: ConfigInfo["availableModels"];
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
  const navigate = useNavigate();
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

  // Keep the panel's conversation and the URL's workspace the same. A chat runs
  // in the workspace its URL names, and the server refuses a conversation that
  // lives anywhere else, so the panel never holds a conversation from a
  // workspace other than the one focused. When they disagree, one of two
  // things gives:
  //
  //  - The URL, when the user CHOSE the conversation (`openConversation`: a
  //    `?chat=` deep link, a list, an app's open action). The user asked for
  //    that conversation, so they go to its workspace's path — `/w/<its slug>` —
  //    and every request the panel makes from then on names that workspace.
  //    Only for a workspace they belong to; otherwise the next case applies.
  //
  //  - The conversation, otherwise. The panel returns to its unsent chat, or a
  //    fresh one once a send has been attempted in it. An unsent chat belongs
  //    to no workspace until its first send creates the conversation in the
  //    focused one, so its text can follow the switch without carrying anything
  //    across. The panel stays open.
  //
  // Narrow on purpose: this moves off only the OPEN conversation
  // (`newConversation()`), unlike the identity reset above which nukes every
  // cached slice. Other workspaces' cached slices stay intact.
  //
  // Two complementary triggers:
  //
  //  (1) In-session workspace→workspace TRANSITION, tracked off the focus value.
  //      The open conversation belongs to the workspace we just left, so clear
  //      it — unless this transition is the one `openConversation` asked for,
  //      arriving at the chosen conversation's own workspace. This fires even
  //      before the conversation's own workspace has loaded — the transition
  //      itself is the signal. `null` focus (home / identity routes, or focus
  //      not yet resolved) is held, not tracked: A→home→B still re-scopes on
  //      arrival at B, while A→home→A does not.
  //
  //  (2) Mount / async-focus / open RECONCILE. After a reload (per-tab restore),
  //      on a `null → workspace` async resolve, and when a conversation is
  //      opened, there is no transition for (1) to observe. Compare the
  //      conversation's OWN workspace to the focus — but ONLY once that
  //      workspace is KNOWN (`conversationMeta.workspaceId`, loaded from the
  //      server). A conversation whose workspace hasn't loaded is left alone, so
  //      opening one from within its own workspace never briefly self-clears.
  //
  // Both triggers depend on focus being route-derived (above): only a real
  // navigation moves it, so (1) sees a transition when — and only when — the URL
  // changes workspace, and (2) never compares against an intermediate value.
  const lastWorkspaceFocusRef = useRef(focusWorkspaceId);
  /** The conversation the user chose to open, followed to its workspace's path. */
  const followRef = useRef<string | null>(null);
  const { newConversation, conversationId, conversationMeta, loadConversation } = chat;
  const conversationWorkspaceId = conversationMeta?.workspaceId ?? null;
  const openConversation = useCallback(
    (id: string) => {
      followRef.current = id;
      return loadConversation(id);
    },
    [loadConversation],
  );
  useEffect(() => {
    if (focusWorkspaceId === null) return; // home / identity, or not-yet-resolved — hold
    const prevFocus = lastWorkspaceFocusRef.current;
    lastWorkspaceFocusRef.current = focusWorkspaceId;
    const followed = conversationId !== null && followRef.current === conversationId;
    const action = scopeAction({
      prevFocus,
      focus: focusWorkspaceId,
      conversationId,
      conversationWorkspaceId,
      followed,
      isMember: (wsId) => workspaces.some((w) => w.id === wsId),
    });
    if (action === "arrived" && followed) followRef.current = null;
    else if (action === "follow" && conversationWorkspaceId) {
      navigate(`/w/${toSlug(conversationWorkspaceId)}`);
    } else if (action === "clear") newConversation();
  }, [
    focusWorkspaceId,
    conversationId,
    conversationWorkspaceId,
    newConversation,
    navigate,
    workspaces,
  ]);

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
  // Seeded from the bootstrap: `fetchConfig` only runs when there is none,
  // so a field this provider reads has to arrive by both routes.
  const [newConversationModel, setNewConversationModel] = useState<string | undefined>(
    initialConfig?.newConversationModel,
  );
  const [availableModels, setAvailableModels] = useState<ConfigInfo["availableModels"]>(
    initialConfig?.availableModels,
  );
  const [preferences, setPreferences] = useState<ConfigInfo["preferences"]>(
    initialConfig?.preferences,
  );

  const fetchConfig = useCallback(() => {
    callTool("nb", "get_config")
      .then((result) => {
        const data = extractConfigPayload(result) as ConfigInfo;
        setConfiguredProviders(data.configuredProviders);
        setNewConversationModel(data.newConversationModel);
        setAvailableModels(data.availableModels);
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

  // A model may be passed only where it can still mean something: at create,
  // where it becomes the conversation's binding. The pin outranks it on an
  // existing thread, so there is no per-turn override — the composer offers
  // the choice before the first message and states it after. Nothing about a
  // model is stored in the browser; the choice goes to the server and comes
  // back as the pin.
  const wrappedSendMessage = useCallback(
    (text: string, appContext?: AppContext, files?: File[], model?: string) => {
      return chat.sendMessage(text, appContext, model, files);
    },
    [chat.sendMessage],
  );

  // -- Config context value (changes rarely) --
  const configValue = useMemo<ChatConfigContextValue>(
    () => ({
      configuredProviders,
      newConversationModel,
      availableModels,
      refreshConfig: fetchConfig,
      preferences,
      currentUserId,
    }),
    [
      configuredProviders,
      newConversationModel,
      availableModels,
      fetchConfig,
      preferences,
      currentUserId,
    ],
  );

  // -- Chat context value (changes per streaming tick) --
  const chatValue = useMemo<ChatContextValue>(
    () => ({
      ...chat,
      sendMessage: wrappedSendMessage,
      openConversation,
    }),
    [chat, wrappedSendMessage, openConversation],
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
