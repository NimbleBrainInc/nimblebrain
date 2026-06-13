// ---------------------------------------------------------------------------
// AppWithChat — iframe renderer for a single app placement.
//
// Scope is deliberately narrow. The chat panel — toggle, sliding
// sidebar/fullscreen, resize handle — and the `marginRight` push-over
// that makes room for it are all shell-level (`ChatChrome` and
// `ShellLayout`), so they behave identically on every route. Don't pull
// any of that back in here; this component renders one app and nothing
// about the panel's own layout.
//
// What stays here, because it needs the focused app:
//   - `SlotRenderer` — renders the placement's iframe
//   - `handleChat` / `handlePromptAction` — iframe→shell channels for
//     "send this from inside the app". These are the one place a focused
//     app is known, so they stamp its `AppContext` on outgoing messages.
//   - publishing the focused app to `FocusedAppContext`, so the globally
//     mounted chat panel can stamp the same `AppContext` on messages
//     typed into the main composer (not just the in-app channel).
//   - First-page-load chat-store restoration. `getSavedConversationId`
//     fires once per module evaluation (= per page load) and re-attaches
//     to the last in-flight conversation so the SSE viewer reconnects.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import type { UiChatContext } from "../bridge/types";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useFocusedApp } from "../context/FocusedAppContext";
import { chatStore } from "../hooks/chat-store";
import {
  getSavedConversationId,
  getSavedStreamingIds,
  setSavedConversationId,
  setSavedStreamingIds,
} from "../lib/active-conversation-storage";
import { useIsMobile } from "../lib/hooks/use-is-mobile";
import type { AppContext, PlacementEntry } from "../types";
import { SlotRenderer } from "./SlotRenderer";

/**
 * Module-once guard: restore conversation state only on a fresh page load, not
 * on every client-side app navigation (which remounts AppWithChat). A page
 * reload resets the module, re-arming the restore.
 */
let restoredLastConversation = false;
/**
 * Snapshot of the persisted streaming-id set captured at module-eval time
 * (page load), before any persist effect overwrites sessionStorage with the
 * post-reload (empty) set.
 */
const initialSavedStreamingIds = getSavedStreamingIds();

interface AppWithChatProps {
  placement: PlacementEntry;
  onNavigate: (route: string) => void;
  /** One-shot `?force=1` cache-bust — only the home route passes this. */
  forceRefresh?: boolean;
}

const TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const TRANSITION_FULLSCREEN = "350ms cubic-bezier(0.4, 0, 0.2, 1)";

export function AppWithChat({ placement, onNavigate, forceRefresh }: AppWithChatProps) {
  const { panelState, openPanel, toggleFullscreen } = useChatPanelContext();

  const chat = useChatContext();
  const isMobile = useIsMobile();
  const { setFocusedApp } = useFocusedApp();
  const location = useLocation();

  // Collapse fullscreen when navigating to a different route
  const prevPathnameRef = useRef(location.pathname);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to pathname changes, panelState/toggleFullscreen are intentionally excluded
  useEffect(() => {
    if (location.pathname !== prevPathnameRef.current) {
      prevPathnameRef.current = location.pathname;
      if (panelState === "fullscreen") {
        toggleFullscreen();
      }
    }
  }, [location.pathname]);

  // Deep-link: open chat from ?chat=<conversationId> on mount. Otherwise, on a
  // fresh page load, reopen the last-viewed conversation (per-tab, via
  // sessionStorage) so an in-flight turn's stream/indicator resumes —
  // loadConversation re-subscribes and the server's `isActive` drives the
  // bubble. Module-once so app-to-app navigation doesn't re-trigger it.
  const deepLinkHandled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
  useEffect(() => {
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const chatId = new URLSearchParams(window.location.search).get("chat");
    if (chatId) {
      openPanel(chatId);
      return;
    }
    if (!restoredLastConversation) {
      restoredLastConversation = true;
      const saved = getSavedConversationId();
      // Hydrate without forcing the panel open — its visibility is restored
      // independently from ChatPanelContext's persisted state. When the panel
      // is (re)opened it shows this conversation.
      if (saved) void chat.loadConversation(saved);
      // Restore background streaming dots: probe each conversation that was
      // generating before reload. Still-active ones light up; finished ones
      // self-heal (probe → not active → no dot).
      for (const id of initialSavedStreamingIds) {
        if (id !== saved) chatStore.probeConversation(id);
      }
    }
  }, []);

  // Persist the active conversation id (per-tab) so a reload can reopen it.
  // Cleared automatically when a new/draft chat is active (conversationId null).
  useEffect(() => {
    setSavedConversationId(chat.conversationId);
  }, [chat.conversationId]);

  // Persist the set of conversations with an in-flight turn so a reload can
  // restore their streaming dots (re-probed against the server above).
  const streamingIds = useSyncExternalStore(
    chatStore.subscribeStreamingIds,
    chatStore.getStreamingIds,
  );
  useEffect(() => {
    setSavedStreamingIds(streamingIds);
  }, [streamingIds]);

  const appContext = useMemo<AppContext>(
    () => ({
      appName: placement.label || placement.serverName,
      serverName: placement.serverName,
    }),
    [placement.label, placement.serverName],
  );

  // Publish this app as the focused one while it's mounted, so messages
  // typed into the global chat panel carry its `AppContext` (the panel
  // can't know the focused app on its own — see ChatChrome's header).
  // Clear on unmount / route change so non-app routes stamp nothing.
  useEffect(() => {
    setFocusedApp(appContext);
    return () => setFocusedApp(null);
  }, [appContext, setFocusedApp]);

  const handleChat = useCallback(
    (message: string, context?: UiChatContext) => {
      if (panelState === "closed") {
        openPanel();
      }
      let formatted = message;
      if (context) {
        const parts: string[] = [appContext.appName];
        if (context.action) parts.push(`action: ${context.action}`);
        if (context.entity) parts.push(`entity: ${context.entity.type}/${context.entity.id}`);
        formatted = `[App Context: ${parts.join(" | ")}]\n${message}`;
      }
      chat.sendMessage(formatted, appContext);
    },
    [panelState, openPanel, chat, appContext],
  );

  const handlePromptAction = useCallback(
    (prompt: string) => {
      if (panelState === "closed") {
        openPanel();
      }
      window.dispatchEvent(new CustomEvent("nb:prompt", { detail: { prompt } }));
    },
    [panelState, openPanel],
  );

  const isSidebar = panelState === "sidebar";
  const isFullscreen = panelState === "fullscreen";
  const hideMobileApp = isMobile && isSidebar;

  return (
    <div className="relative flex h-dvh w-full overflow-hidden">
      {/* App area — hidden on mobile when chat sidebar is open.
          marginRight (chat panel push-over) is handled at the shell
          level on <main> now; AppWithChat keeps only the iframe-
          specific fullscreen styling (opacity/blur when chat
          fullscreen covers the iframe). */}
      {!hideMobileApp && (
        <div
          className={
            isFullscreen
              ? "flex-1 h-full min-w-0 opacity-30 scale-[0.98] blur-sm pointer-events-none transition-all duration-350 ease-out"
              : "flex-1 h-full min-w-0"
          }
          style={{
            transition: isFullscreen
              ? `opacity ${TRANSITION_FULLSCREEN}, transform ${TRANSITION_FULLSCREEN}, filter ${TRANSITION_FULLSCREEN}`
              : `opacity ${TRANSITION_STANDARD}, transform ${TRANSITION_STANDARD}, filter ${TRANSITION_STANDARD}`,
          }}
        >
          <SlotRenderer
            placements={[placement]}
            className="w-full h-full"
            onChat={handleChat}
            onNavigate={onNavigate}
            onPromptAction={handlePromptAction}
            forceRefresh={forceRefresh}
          />
        </div>
      )}
    </div>
  );
}
