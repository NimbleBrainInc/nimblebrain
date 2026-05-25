// ---------------------------------------------------------------------------
// ChatChrome — the floating chat toggle + sliding chat panel + resize
// handle, lifted out of AppWithChat so it can be mounted globally from
// ShellLayout (chat is always available, not just on app routes).
//
// Two usage modes:
//   1. With `appContext`: AppWithChat passes the active app's context
//      so chats sent from inside an app carry "[App Context: …]"
//      metadata in the message.
//   2. Without `appContext` (global mode): ShellLayout mounts this
//      with no app context; chats sent from non-app routes (Home,
//      workspace overview, settings, …) are workspace-agnostic.
//
// Mounted twice would render two panels — ShellLayout's instance is
// active on every route, so AppWithChat MUST NOT render this directly.
// AppWithChat's `chat-on-app-route` behavior comes from the same shell
// instance through ChatPanelContext, plus app-specific iframe
// coordination (marginRight + resize handle) which stays in AppWithChat.
// ---------------------------------------------------------------------------

import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSidebar } from "../context/SidebarContext";
import type { AppContext } from "../types";
import type { ChatPanelRef } from "./ChatPanel";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";

const DEFAULT_WIDTH = 380;
const TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const TRANSITION_FULLSCREEN = "350ms cubic-bezier(0.4, 0, 0.2, 1)";

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

interface ChatChromeProps {
  /** App context to stamp on messages, if any. Omit for global mode. */
  appContext?: AppContext;
}

export function ChatChrome({ appContext }: ChatChromeProps) {
  const { panelState, panelWidth, setPanelWidth, openPanel, closePanel, toggleFullscreen } =
    useChatPanelContext();
  const panelRef = useRef<ChatPanelRef>(null);
  const chat = useChatContext();
  const sidebar = useSidebar();
  const isMobile = useIsMobile();
  const location = useLocation();

  // Collapse fullscreen when the route changes — same logic AppWithChat
  // had; lifting it here makes it work globally.
  const prevPathnameRef = useRef(location.pathname);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to pathname changes
  useEffect(() => {
    if (location.pathname !== prevPathnameRef.current) {
      prevPathnameRef.current = location.pathname;
      if (panelState === "fullscreen") {
        toggleFullscreen();
      }
    }
  }, [location.pathname]);

  // Deep-link: open chat from ?chat=<conversationId> on mount.
  const deepLinkHandled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount
  useEffect(() => {
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const chatId = params.get("chat");
    if (chatId) {
      openPanel(chatId);
    }
  }, []);

  // Unread tracking: count assistant messages added while panel is closed.
  const lastSeenAssistantCount = useRef(0);
  const [buttonVisible, setButtonVisible] = useState(() => panelState === "closed");

  const assistantMessageCount = useMemo(
    () => chat.messages.filter((m) => m.role === "assistant").length,
    [chat.messages],
  );

  useEffect(() => {
    if (panelState !== "closed") {
      lastSeenAssistantCount.current = assistantMessageCount;
    }
  }, [panelState, assistantMessageCount]);

  const unreadCount =
    panelState === "closed"
      ? Math.max(0, assistantMessageCount - lastSeenAssistantCount.current)
      : 0;

  // Delayed entrance animation: fade in the button 300ms after panel closes.
  useEffect(() => {
    if (panelState === "closed") {
      const timer = setTimeout(() => setButtonVisible(true), 300);
      return () => clearTimeout(timer);
    }
    setButtonVisible(false);
  }, [panelState]);

  // Keyboard shortcuts — Esc closes, ⌘K toggles, ⌘⇧K toggles fullscreen.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        if (panelState !== "closed") {
          e.preventDefault();
          closePanel();
        }
        return;
      }

      if (mod && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        if (panelState === "closed") {
          openPanel();
          toggleFullscreen();
          setTimeout(() => panelRef.current?.requestInputFocus(), 350);
        } else {
          toggleFullscreen();
          setTimeout(() => panelRef.current?.requestInputFocus(), 100);
        }
        return;
      }

      if (mod && e.key === "k") {
        e.preventDefault();
        if (panelState === "closed") {
          openPanel();
          setTimeout(() => panelRef.current?.requestInputFocus(), 350);
        } else {
          closePanel();
        }
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [panelState, openPanel, closePanel, toggleFullscreen]);

  const handleClose = useCallback(() => closePanel(), [closePanel]);
  const handleBack = useCallback(() => closePanel(), [closePanel]);
  const handleFullscreen = useCallback(() => toggleFullscreen(), [toggleFullscreen]);

  const handleSendMessage = useCallback(
    (text: string, files?: File[]) => {
      // App context stamps the message metadata when a chat is sent
      // from inside an app's iframe (AppWithChat). In global mode no
      // app context is attached.
      return chat.sendMessage(text, appContext, files);
    },
    [chat, appContext],
  );

  const isSidebar = panelState === "sidebar";
  const isFullscreen = panelState === "fullscreen";
  const isOpen = isSidebar || isFullscreen;

  return (
    <>
      {/* Floating chat toggle — visible when panel is closed */}
      {panelState === "closed" && (
        <button
          type="button"
          onClick={() => openPanel()}
          className="fixed bottom-6 right-6 z-40 flex items-center justify-center w-12 h-12 rounded-full bg-warm text-warm-foreground shadow-lg hover:bg-warm-hover transition-all duration-200"
          style={{
            opacity: buttonVisible ? 1 : 0,
            transition: "opacity 200ms ease-in, background-color 200ms",
          }}
          title="Chat (⌘K)"
          data-testid="chat-chrome-open-button"
        >
          <MessageSquare className="w-5 h-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center">
              {unreadCount}
            </span>
          )}
        </button>
      )}

      {/* Chat panel — full-width on mobile, fixed sidebar on desktop */}
      <div
        className="fixed top-0 right-0 h-full z-10 bg-background"
        data-testid="chat-chrome-panel"
        style={{
          width: isMobile
            ? "100%"
            : isFullscreen
              ? sidebar.state === "hidden"
                ? "100%"
                : sidebar.state === "collapsed"
                  ? "calc(100% - var(--sidebar-width-collapsed))"
                  : "calc(100% - var(--sidebar-width))"
              : panelWidth,
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: `transform ${
            isFullscreen ? TRANSITION_FULLSCREEN : TRANSITION_STANDARD
          }, width ${isFullscreen ? TRANSITION_FULLSCREEN : TRANSITION_STANDARD}`,
        }}
      >
        <ChatPanel
          ref={panelRef}
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          error={chat.error}
          sendMessage={handleSendMessage}
          newConversation={chat.newConversation}
          compact={isSidebar}
          onClose={handleClose}
          onFullscreen={handleFullscreen}
          onBack={isMobile ? handleBack : undefined}
          isFullscreen={isFullscreen}
          onRetry={chat.retryLastMessage}
        />
      </div>

      {/* Resize handle — anchored to the panel's left edge. Rendered here at
          the single panel mount point so EVERY route gets a resizable,
          collapsible chat sidebar, not just app views. App iframes read
          `isResizing` from ChatPanelContext to drop pointer-events mid-drag. */}
      {isSidebar && !isMobile && (
        <div className="fixed top-0 h-full z-20 hidden sm:block" style={{ right: panelWidth }}>
          <ResizeHandle
            initialWidth={panelWidth}
            onWidthChange={setPanelWidth}
            onDoubleClick={() => setPanelWidth(DEFAULT_WIDTH)}
            className="h-full"
          />
        </div>
      )}
    </>
  );
}

export { DEFAULT_WIDTH as CHAT_CHROME_DEFAULT_WIDTH };
