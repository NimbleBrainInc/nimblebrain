// ---------------------------------------------------------------------------
// ChatChrome — the chat panel chrome: floating toggle, sliding
// sidebar/fullscreen panel, resize handle, keyboard shortcuts, unread
// tracking, and deep-link open.
//
// INVARIANT: mounted exactly once, globally, by ShellLayout. A second
// mount renders a second panel. Nothing else may render it — every route
// gets chat through this single instance via ChatPanelContext, which is
// why the panel is identical on home, workspace overview, and app views.
//
// A global mount can't know the focused app on its own, so the active
// app view publishes itself to FocusedAppContext (AppWithChat) and this
// panel reads it to stamp `AppContext` on messages typed into the main
// composer. Without it, the backend resolves no focused app and the
// agent can't see the app's visible state (e.g. the open document).
// The inline "[App Context: …]" text prefix is a separate concern and
// still lives in AppWithChat's in-app channel.
// ---------------------------------------------------------------------------

import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useFocusedApp } from "../context/FocusedAppContext";
import { useSidebar } from "../context/SidebarContext";
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

export function ChatChrome() {
  const { panelState, panelWidth, setPanelWidth, openPanel, closePanel, toggleFullscreen } =
    useChatPanelContext();
  const panelRef = useRef<ChatPanelRef>(null);
  const chat = useChatContext();
  const sidebar = useSidebar();
  const isMobile = useIsMobile();
  const location = useLocation();
  const { focusedApp } = useFocusedApp();

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
    // Stamp the focused app (published by the active AppWithChat) so the
    // backend resolves it and injects its visible state. `null` on
    // non-app routes → no appContext, same as before. useChat enriches
    // appContext with the app's latest visible state from the bridge.
    (text: string, files?: File[]) => chat.sendMessage(text, focusedApp ?? undefined, files),
    [chat, focusedApp],
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
          the single panel mount point so EVERY route gets a resizable
          sidebar, not just app views. ResizeHandle is self-contained: while
          dragging it renders a full-viewport overlay that captures the mouse
          over app iframes, so no shared drag flag crosses components.

          z-[9] keeps the handle BELOW the chat panel (z-10). The handle sits
          just outside the panel's left edge (right: panelWidth), so the panel
          never covers it — but in-panel overlays that overflow leftward (e.g.
          the SkillsPopover, z-50 trapped inside the panel's z-10 stacking
          context) now render ABOVE the handle instead of having the handle's
          hover/active bar (bg-ring / bg-primary) paint a blue stripe over them.
          The drag overlay (ResizeHandle, z-[60]) is unaffected. */}
      {isSidebar && !isMobile && (
        <div className="fixed top-0 h-full z-[9] hidden sm:block" style={{ right: panelWidth }}>
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
