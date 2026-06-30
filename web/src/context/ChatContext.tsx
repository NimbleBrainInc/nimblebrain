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
import type { AppContext, ConfigInfo } from "../types";
import { useWorkspaceContext } from "./WorkspaceContext";

// ---------------------------------------------------------------------------
// ChatConfigContext — stable values that change rarely (config, preferences)
// ---------------------------------------------------------------------------

export interface ChatConfigContextValue {
  selectedModel: string | null;
  setSelectedModel: (model: string | null) => void;
  configuredProviders: string[];
  defaultModel: string;
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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ChatProviderProps {
  initialConversationId?: string;
  children: ReactNode;
  /** Pre-fetched config from bootstrap. Skips the tool call when provided. */
  initialConfig?: {
    configuredProviders: string[];
    defaultModel: string;
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
  const location = useLocation();
  const { activeWorkspace } = useWorkspaceContext();
  const focusWorkspaceId = location.pathname.startsWith("/w/")
    ? (activeWorkspace?.id ?? null)
    : null;
  const chat = useChat(initialConversationId, currentUserId, focusWorkspaceId);

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

  // Re-scope the panel on a real workspace switch. The chat panel is
  // workspace-scoped: a conversation lives in exactly one workspace, so when
  // the focused workspace changes from one workspace to a DIFFERENT one, the
  // open conversation (which belongs to the workspace you just left) clears and
  // the panel resets to a fresh, empty draft in the newly-focused workspace.
  // The panel stays open — the assistant is still there; it just no longer shows
  // a conversation from the workspace you left.
  //
  // Narrow on purpose: this clears only the OPEN conversation
  // (`newConversation()` → a fresh draft slice), unlike the identity reset above
  // which nukes every cached slice. Other workspaces' cached slices stay intact.
  //
  // Triggers ONLY on a workspace→workspace transition, tracked off the focus
  // value (not by comparing the open conversation's workspace, which would race
  // with opening one). `null` focus (home / identity routes) is ignored: we hold
  // the last real workspace, so A→home→B still re-scopes on arrival at B, while
  // A→home→A does not. Opening a conversation from within its own workspace
  // doesn't change the focus, so it never trips this.
  //
  // Corollary of triggering off the transition (not the open conversation):
  // arriving INTO a workspace always yields a fresh draft. If a B-conversation
  // was opened from a home/identity route (focus null) and the user then
  // navigates into B, the held focus (A) → B transition re-scopes and clears it.
  // Acceptable: with the conversation list now workspace-scoped, opening a chat
  // from outside its workspace is unusual, and a fresh draft on arrival is the
  // consistent, race-free behavior.
  const lastWorkspaceFocusRef = useRef(focusWorkspaceId);
  const { newConversation } = chat;
  useEffect(() => {
    if (focusWorkspaceId === null) return;
    if (
      lastWorkspaceFocusRef.current !== null &&
      lastWorkspaceFocusRef.current !== focusWorkspaceId
    ) {
      newConversation();
    }
    lastWorkspaceFocusRef.current = focusWorkspaceId;
  }, [focusWorkspaceId, newConversation]);

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
  const [selectedModel, setSelectedModelState] = useState<string | null>(() =>
    localStorage.getItem("nb:selectedModel"),
  );
  const [configuredProviders, setConfiguredProviders] = useState<string[]>(
    initialConfig?.configuredProviders ?? [],
  );
  const [defaultModel, setDefaultModel] = useState<string>(initialConfig?.defaultModel ?? "");
  const [preferences, setPreferences] = useState<ConfigInfo["preferences"]>(
    initialConfig?.preferences,
  );

  const fetchConfig = useCallback(() => {
    callTool("nb", "get_config")
      .then((result) => {
        // Prefer structuredContent; fall back to parsing first text block
        let raw: unknown = result.structuredContent;
        if (!raw && result.content?.[0]) {
          const block = result.content[0];
          if (block.text) {
            try {
              raw = JSON.parse(block.text);
            } catch {
              raw = block;
            }
          } else {
            raw = block;
          }
        }
        const data = raw as ConfigInfo;
        setConfiguredProviders(data.configuredProviders);
        setDefaultModel(data.defaultModel);
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

  const setSelectedModel = useCallback((model: string | null) => {
    setSelectedModelState(model);
    if (model) {
      localStorage.setItem("nb:selectedModel", model);
    } else {
      localStorage.removeItem("nb:selectedModel");
    }
  }, []);

  // Cross-tab / refresh sync is now handled by the per-conversation turn
  // stream itself (server-authoritative): every viewer attaches to
  // GET /v1/conversations/:id/events, which replays the in-flight turn and
  // tails live. No separate remote-event bridge needed.

  const wrappedSendMessage = useCallback(
    (text: string, appContext?: AppContext, files?: File[]) => {
      return chat.sendMessage(text, appContext, selectedModel ?? undefined, files);
    },
    [chat.sendMessage, selectedModel],
  );

  // -- Config context value (changes rarely) --
  const configValue = useMemo<ChatConfigContextValue>(
    () => ({
      selectedModel,
      setSelectedModel,
      configuredProviders,
      defaultModel,
      refreshConfig: fetchConfig,
      preferences,
      currentUserId,
    }),
    [
      selectedModel,
      setSelectedModel,
      configuredProviders,
      defaultModel,
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

/** Consume stable config values (preferences, providers, model selection). */
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
