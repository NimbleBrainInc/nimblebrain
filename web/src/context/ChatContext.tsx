import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { callTool } from "../api/client";
import type { UseChatReturn } from "../hooks/useChat";
import { useChat } from "../hooks/useChat";
import { useConversationEvents } from "../hooks/useConversationEvents";
import type { AppContext, ConfigInfo } from "../types";

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
  participantMap: Map<string, string>;
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
  const chat = useChat(initialConversationId, currentUserId);

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
  const [participantMap, setParticipantMap] = useState<Map<string, string>>(new Map());

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

  // Fetch workspace users once on mount to build participantMap (userId → displayName)
  useEffect(() => {
    callTool("nb", "manage_users", { action: "list" })
      .then((result) => {
        let raw: unknown = result.structuredContent;
        if (!raw && result.content?.[0]?.text) {
          try {
            raw = JSON.parse(result.content[0].text);
          } catch {
            raw = {};
          }
        }
        const data = raw as { users?: Array<{ id: string; displayName: string }> };
        if (data.users) {
          const map = new Map<string, string>();
          for (const u of data.users) {
            map.set(u.id, u.displayName);
          }
          setParticipantMap(map);
        }
      })
      .catch(() => {
        // Non-critical — speaker labels will fall back to userId
      });
  }, []);

  const setSelectedModel = useCallback((model: string | null) => {
    setSelectedModelState(model);
    if (model) {
      localStorage.setItem("nb:selectedModel", model);
    } else {
      localStorage.removeItem("nb:selectedModel");
    }
  }, []);

  // Subscribe to conversation events for shared conversations
  const isShared = chat.conversationMeta?.visibility === "shared";
  useConversationEvents(chat.conversationId, isShared, {
    onRemoteUserMessage: (data) => {
      chat.injectRemoteUserMessage(data.userId, data.displayName, data.content);
    },
    onRemoteStreamEvent: (type, data) => {
      chat.processRemoteStreamEvent(type, data);
    },
    onReconnect: () => {
      if (chat.conversationId) {
        chat.loadConversation(chat.conversationId);
      }
    },
  });

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
      participantMap,
    }),
    [
      selectedModel,
      setSelectedModel,
      configuredProviders,
      defaultModel,
      fetchConfig,
      preferences,
      currentUserId,
      participantMap,
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
