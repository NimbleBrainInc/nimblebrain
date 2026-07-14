import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { captureEvent } from "../telemetry";
import type { AppContext } from "../types";
import type {
  ChatMessage,
  LoadedConversationMeta,
  PreparingTool,
  StreamingState,
} from "./chat-store";
import { chatStore, freshDraftKey } from "./chat-store";

// Re-export the display types so existing `from "../hooks/useChat"` imports
// keep working — the slice store now owns the definitions.
export type {
  ChatMessage,
  ContentBlock,
  IterationProgress,
  LoadedConversationMeta,
  MessageFileAttachment,
  PreparingTool,
  StreamingState,
  ToolCallDisplay,
  ToolResultForUI,
} from "./chat-store";

export interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingState: StreamingState;
  /** Set while streamingState === "preparing"; null otherwise. */
  preparingTool: PreparingTool | null;
  conversationId: string | null;
  /** Server-generated title; null until generated/loaded. */
  title: string | null;
  conversationMeta: LoadedConversationMeta | null;
  error: string | null;
  sendMessage: (
    text: string,
    appContext?: AppContext,
    model?: string,
    files?: File[],
  ) => Promise<void>;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  /** Stop the in-flight turn (the only thing that aborts generation). */
  stop: () => void;
  /** Retry the last failed message (removes errored pair and re-sends). */
  retryLastMessage: () => void;
  /** Inject a synthetic error for demoing the error UX (dev only). */
  simulateError: (message: string) => void;
}

/**
 * Per-conversation chat state, backed by the module-singleton {@link chatStore}.
 *
 * `activeKey` selects which conversation's slice this hook renders. A stream
 * started for one conversation writes only into that conversation's slice
 * (captured at send time), so switching conversations mid-turn never bleeds
 * the in-flight response into the destination chat (issue #254). Switching
 * back shows the still-arriving response because the background stream kept
 * filling its origin slice.
 *
 * `focusWorkspaceId` is the workspace the chat is FOCUSED on (the `/w/:slug`
 * the user is viewing). It backstops the send path: before resuming an open
 * conversation, `sendMessage` checks the conversation's own workspace against
 * this focus, and — if they differ — starts a fresh draft in the focused
 * workspace instead of resuming into the other one. This closes the
 * cross-workspace mis-target window that survives a refresh + re-navigation
 * (the runtime always binds a resumed turn to the conversation's own workspace,
 * so the panel could otherwise land a message in a workspace the user isn't
 * viewing). `null` (home/identity route, or focus not yet resolved) disables
 * the check — there's nothing to reconcile against.
 */
export function useChat(
  initialConversationId?: string,
  currentUserId?: string,
  focusWorkspaceId?: string | null,
): UseChatReturn {
  const [activeKey, setActiveKey] = useState(() => {
    const key = initialConversationId ?? freshDraftKey();
    chatStore.ensureSlice(
      key,
      initialConversationId ? { conversationId: initialConversationId } : undefined,
    );
    return key;
  });

  const subscribe = useCallback(
    (cb: () => void) => chatStore.subscribeSlice(activeKey, cb),
    [activeKey],
  );
  const getSnapshot = useCallback(() => chatStore.getSnapshot(activeKey), [activeKey]);
  const snap = useSyncExternalStore(subscribe, getSnapshot);

  // Mark the active slice so the LRU never evicts what the user is viewing.
  useEffect(() => {
    chatStore.markActive(activeKey);
    return () => chatStore.markInactive(activeKey);
  }, [activeKey]);

  const sendMessage = useCallback(
    async (text: string, appContext?: AppContext, model?: string, files?: File[]) => {
      // Enrich appContext with the latest app state from the bridge
      // (Synapse Feature 2). Kept here — the store stays bridge-agnostic.
      let enrichedContext = appContext;
      if (appContext) {
        const { getAppState } = await import("../bridge/bridge");
        const appStateEntry = getAppState(appContext.serverName);
        if (appStateEntry) enrichedContext = { ...appContext, appState: appStateEntry };
      }

      // Mis-target backstop (client twin of ChatProvider's re-scope effect and
      // of the server's resume mismatch guard). Never RESUME a conversation
      // sealed to a workspace other than the one currently focused: after a
      // refresh + re-navigation the panel can still hold a conversation from
      // workspace A while the user is viewing workspace B, and resuming it would
      // land the message in A. Start a fresh draft in the focused workspace
      // instead. Acts only when BOTH the focus and the conversation's own
      // workspace are known and differ — an unknown workspace (draft, or meta
      // not loaded yet) is left alone, the same open-in-progress race guard the
      // reconcile effect uses.
      let key = activeKey;
      const snap = chatStore.getSnapshot(activeKey);
      const convWs = snap.meta?.workspaceId ?? null;
      if (
        snap.conversationId &&
        convWs !== null &&
        focusWorkspaceId != null &&
        convWs !== focusWorkspaceId
      ) {
        key = freshDraftKey();
        chatStore.ensureSlice(key);
        setActiveKey(key);
      }

      const hadConversation = !!chatStore.getSnapshot(key).conversationId;
      await chatStore.sendTurn(
        key,
        { text, appContext: enrichedContext, model, files, currentUserId },
        { onConversationId: (id) => setActiveKey(id) },
      );
      captureEvent("web.chat_sent", {
        is_resume: hadConversation,
        has_app_context: !!appContext,
      });
    },
    [activeKey, currentUserId, focusWorkspaceId],
  );

  const newConversation = useCallback(() => {
    const key = freshDraftKey();
    chatStore.ensureSlice(key);
    setActiveKey(key);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setActiveKey(id);
    await chatStore.loadConversation(id);
  }, []);

  const stop = useCallback(() => {
    chatStore.cancelTurn(activeKey);
  }, [activeKey]);

  const retryLastMessage = useCallback(() => {
    // The store replays the original send (text + model + appContext) itself —
    // no re-routing through sendMessage, which dropped the model selection.
    chatStore.retryLastMessage(activeKey);
  }, [activeKey]);

  const simulateError = useCallback(
    (message: string) => {
      chatStore.simulateError(activeKey, message);
    },
    [activeKey],
  );

  return useMemo<UseChatReturn>(
    () => ({
      messages: snap.messages,
      isStreaming: snap.isStreaming,
      streamingState: snap.streamingState,
      preparingTool: snap.preparingTool,
      // Drafts carry a null conversationId on the slice, so this is null until
      // the server assigns a real id on chat.start.
      conversationId: snap.conversationId,
      title: snap.title,
      conversationMeta: snap.meta,
      error: snap.error,
      sendMessage,
      newConversation,
      loadConversation,
      stop,
      retryLastMessage,
      simulateError,
    }),
    [snap, sendMessage, newConversation, loadConversation, stop, retryLastMessage, simulateError],
  );
}
