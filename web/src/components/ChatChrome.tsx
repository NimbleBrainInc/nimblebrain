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
import { useIsMobile } from "../lib/hooks/use-is-mobile";
import type { ChatPanelRef } from "./ChatPanel";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";

const DEFAULT_WIDTH = 380;
const TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const TRANSITION_FULLSCREEN = "350ms cubic-bezier(0.4, 0, 0.2, 1)";

/** Fullscreen panel width: it fills the viewport minus the room the sidebar currently occupies. */
function fullscreenPanelWidth(sidebarState: "expanded" | "collapsed" | "hidden"): string {
  if (sidebarState === "hidden") return "100%";
  if (sidebarState === "collapsed") return "calc(100% - var(--sidebar-width-collapsed))";
  return "calc(100% - var(--sidebar-width))";
}

/** Resolve the chat panel's rendered width from device, panel, and sidebar state. */
function resolvePanelWidth({
  isMobile,
  isFullscreen,
  sidebarState,
  panelWidth,
}: {
  isMobile: boolean;
  isFullscreen: boolean;
  sidebarState: "expanded" | "collapsed" | "hidden";
  panelWidth: number;
}): string | number {
  if (isMobile) return "100%";
  if (isFullscreen) return fullscreenPanelWidth(sidebarState);
  return panelWidth;
}

/** Floating chat toggle shown when the panel is closed; badges the unread assistant-message count. */
function ChatToggleButton({
  visible,
  unreadCount,
  onOpen,
}: {
  visible: boolean;
  unreadCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fixed bottom-6 right-6 z-40 flex items-center justify-center w-12 h-12 rounded-full bg-warm text-warm-foreground shadow-lg hover:bg-warm-hover transition-all duration-200"
      style={{
        opacity: visible ? 1 : 0,
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
  );
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

  // The effect above only fires on a route *change*. A full-page main-content
  // view like the context inspector, entered by a direct load / refresh /
  // shared link while the chat was left fullscreen, would be covered — so
  // collapse fullscreen once on mount when we land directly on such a route.
  const mountCollapseHandled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount
  useEffect(() => {
    if (mountCollapseHandled.current) return;
    mountCollapseHandled.current = true;
    if (panelState === "fullscreen" && /^\/w\/[^/]+\/context\//.test(location.pathname)) {
      toggleFullscreen();
    }
  }, []);

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
    // Esc — close the panel when it's open; left to the browser when already closed.
    function handleEscape(e: KeyboardEvent) {
      if (panelState === "closed") return;
      e.preventDefault();
      closePanel();
    }

    // ⌘⇧K — toggle fullscreen, opening the panel first when it's closed, then focus the composer.
    function toggleFullscreenShortcut() {
      if (panelState === "closed") {
        openPanel();
        toggleFullscreen();
        setTimeout(() => panelRef.current?.requestInputFocus(), 350);
      } else {
        toggleFullscreen();
        setTimeout(() => panelRef.current?.requestInputFocus(), 100);
      }
    }

    // ⌘K — open the panel (focusing the composer once it settles) or close it.
    function togglePanelShortcut() {
      if (panelState === "closed") {
        openPanel();
        setTimeout(() => panelRef.current?.requestInputFocus(), 350);
      } else {
        closePanel();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        handleEscape(e);
        return;
      }

      if (mod && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        toggleFullscreenShortcut();
        return;
      }

      if (mod && e.key === "k") {
        e.preventDefault();
        togglePanelShortcut();
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
  const transitionTiming = isFullscreen ? TRANSITION_FULLSCREEN : TRANSITION_STANDARD;
  const panelWidthValue = resolvePanelWidth({
    isMobile,
    isFullscreen,
    sidebarState: sidebar.state,
    panelWidth,
  });

  return (
    <>
      {/* Floating chat toggle — visible when panel is closed */}
      {panelState === "closed" && (
        <ChatToggleButton
          visible={buttonVisible}
          unreadCount={unreadCount}
          onOpen={() => openPanel()}
        />
      )}

      {/* Chat panel — full-width on mobile, fixed sidebar on desktop */}
      <div
        className="fixed top-0 right-0 h-full z-10 bg-background"
        data-testid="chat-chrome-panel"
        style={{
          width: panelWidthValue,
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: `transform ${transitionTiming}, width ${transitionTiming}`,
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
          the InContextPopover, z-50 trapped inside the panel's z-10 stacking
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
