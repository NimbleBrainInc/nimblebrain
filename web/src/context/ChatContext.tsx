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
import type { PluginRequestAnswer } from "../_generated/platform-schemas/plugins";
import { callToolWithoutWorkspace } from "../api/client";
import { chatStore } from "../hooks/chat-store";
import type { UseChatReturn } from "../hooks/useChat";
import { useChat } from "../hooks/useChat";
import { toWsId } from "../lib/workspace-slug";
import type { AppContext, ConfigInfo, FileLimits, RunsOnInfo, ToolCallResponse } from "../types";
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
  /** Attachment limits from the bootstrap; instance config, fixed at startup. */
  fileLimits?: FileLimits;
  /** The runtime every turn runs on when it brings its own model (bootstrap `runsOn`). */
  runsOn?: RunsOnInfo;
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
    pluginRequestAnswer?: PluginRequestAnswer,
  ) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** Extract the config payload from a get_config result, preferring structuredContent over the first text block (parsed as JSON, else the raw block). */
function extractConfigPayload(result: ToolCallResponse): unknown {
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
 * `keep` the open conversation or `clear` it.
 */
function scopeAction(s: {
  prevFocus: string | null;
  focus: string;
  conversationId: string | null;
  conversationWorkspaceId: string | null;
}): "keep" | "clear" {
  // (1) Transition.
  if (s.prevFocus !== null && s.prevFocus !== s.focus) return "clear";
  // (2) Reconcile, once the conversation's own workspace is known.
  if (s.conversationId === null || s.conversationWorkspaceId === null) return "keep";
  return s.conversationWorkspaceId === s.focus ? "keep" : "clear";
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
    fileLimits?: FileLimits;
    runsOn?: RunsOnInfo;
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
  // anyway.
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

  // Keep the panel's conversation and the URL's workspace the same. A chat runs
  // in the workspace its URL names, and the server finds a conversation only
  // in the workspace a request names, so the panel never holds a conversation
  // from a workspace other than the one focused. A conversation is opened in
  // the focused workspace: a `?chat=` link names its workspace through the
  // `/w/<slug>` route it sits on, and one stored in any other workspace is not
  // found. When the two still disagree, the conversation gives: the panel
  // returns to its unsent chat, or a fresh one once a send has been attempted
  // in it. An unsent chat belongs to no workspace until its first send creates
  // the conversation in the focused one, so its text can follow the switch
  // without carrying anything across. The panel stays open.
  //
  // Narrow on purpose: this moves off only the OPEN conversation
  // (`newConversation()`), unlike the identity reset above which nukes every
  // cached slice. Other workspaces' cached slices stay intact.
  //
  // Two complementary triggers:
  //
  //  (1) In-session workspace→workspace TRANSITION, tracked off the focus value.
  //      The open conversation belongs to the workspace we just left, so clear
  //      it. This fires even before the conversation's own workspace has
  //      loaded — the transition itself is the signal. `null` focus (home /
  //      identity routes, or focus not yet resolved) is held, not tracked:
  //      A→home→B still re-scopes on arrival at B, while A→home→A does not.
  //
  //  (2) Mount / async-focus RECONCILE. After a reload (per-tab restore) and on
  //      a `null → workspace` async resolve, there is no transition for (1) to
  //      observe. Compare the conversation's OWN workspace to the focus — but
  //      ONLY once that workspace is KNOWN (`conversationMeta.workspaceId`). A
  //      conversation whose workspace hasn't loaded is left alone, so opening
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
    const action = scopeAction({
      prevFocus,
      focus: focusWorkspaceId,
      conversationId,
      conversationWorkspaceId,
    });
    if (action === "clear") newConversation();
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

  // Not refreshed by `fetchConfig`: `get_config` does not carry it, and the
  // limits are instance config that does not change while the shell is open.
  const fileLimits = initialConfig?.fileLimits;
  const runsOn = initialConfig?.runsOn;

  // Each `config.changed` starts a fetch, and responses can arrive out of
  // order; only the latest request's answer is applied, so an older read
  // never replaces a newer one.
  const configRequest = useRef(0);
  const fetchConfig = useCallback(() => {
    const request = ++configRequest.current;
    callToolWithoutWorkspace("nb", "get_config")
      .then((result) => {
        if (request !== configRequest.current) return;
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
  // GET /v1/workspaces/:wsId/conversations/:id/events, which replays the in-flight turn and
  // tails live. No separate remote-event bridge needed.

  // A model may be passed only where it can still mean something: at create,
  // where it becomes the conversation's binding. The pin outranks it on an
  // existing thread, so there is no per-turn override — the composer offers
  // the choice before the first message and states it after. Nothing about a
  // model is stored in the browser; the choice goes to the server and comes
  // back as the pin.
  const wrappedSendMessage = useCallback(
    (
      text: string,
      appContext?: AppContext,
      files?: File[],
      model?: string,
      pluginRequestAnswer?: PluginRequestAnswer,
    ) => {
      return chat.sendMessage(text, appContext, model, files, pluginRequestAnswer);
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
      fileLimits,
      runsOn,
    }),
    [
      configuredProviders,
      newConversationModel,
      availableModels,
      fetchConfig,
      preferences,
      currentUserId,
      fileLimits,
      runsOn,
    ],
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

/**
 * The instance's attachment limits, or `undefined` outside a ChatProvider.
 * For code that can render without one (app mounts, their tests), which
 * treats unknown limits as none known rather than an error.
 */
export function useFileLimits(): FileLimits | undefined {
  return useContext(ChatConfigContext)?.fileLimits;
}

/** Consume streaming/conversation state (messages, streaming, tools). */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return ctx;
}
