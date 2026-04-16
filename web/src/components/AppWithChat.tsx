import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { UiChatContext } from "../bridge/types";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSidebar } from "../context/SidebarContext";
import type { AppContext, PlacementEntry } from "../types";
import type { ChatPanelRef } from "./ChatPanel";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";
import { SlotRenderer } from "./SlotRenderer";

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

interface AppWithChatProps {
  placement: PlacementEntry;
  onNavigate: (route: string) => void;
}

const DEFAULT_WIDTH = 380;
const RESIZE_HANDLE_WIDTH = 4; // px — matches ResizeHandle's w-1 at 16px root
const TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const TRANSITION_FULLSCREEN = "350ms cubic-bezier(0.4, 0, 0.2, 1)";

export function AppWithChat({ placement, onNavigate }: AppWithChatProps) {
  const { panelState, panelWidth, setPanelWidth, openPanel, closePanel, toggleFullscreen } =
    useChatPanelContext();
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<ChatPanelRef>(null);

  const chat = useChatContext();
  const sidebar = useSidebar();
  const isMobile = useIsMobile();
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

  // Deep-link: open chat from ?chat=<conversationId> on mount
  const deepLinkHandled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
  useEffect(() => {
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const chatId = params.get("chat");
    if (chatId) {
      openPanel(chatId);
    }
  }, []);

  // Unread tracking: count assistant messages added while panel is closed
  const lastSeenAssistantCount = useRef(0);
  const [buttonVisible, setButtonVisible] = useState(() => panelState === "closed");

  const assistantMessageCount = useMemo(
    () => chat.messages.filter((m) => m.role === "assistant").length,
    [chat.messages],
  );

  // Update lastSeen when panel is open
  useEffect(() => {
    if (panelState !== "closed") {
      lastSeenAssistantCount.current = assistantMessageCount;
    }
  }, [panelState, assistantMessageCount]);

  const unreadCount =
    panelState === "closed"
      ? Math.max(0, assistantMessageCount - lastSeenAssistantCount.current)
      : 0;

  // Delayed entrance animation: fade in the button 300ms after panel closes
  useEffect(() => {
    if (panelState === "closed") {
      const timer = setTimeout(() => setButtonVisible(true), 300);
      return () => clearTimeout(timer);
    }
    setButtonVisible(false);
  }, [panelState]);

  const appContext = useMemo<AppContext>(
    () => ({
      appName: placement.label || placement.serverName,
      serverName: placement.serverName,
    }),
    [placement.label, placement.serverName],
  );

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Esc: close panel from any state (always, even in inputs)
      if (e.key === "Escape") {
        if (panelState !== "closed") {
          e.preventDefault();
          closePanel();
        }
        return;
      }

      // Cmd/Ctrl+Shift+K : toggle sidebar ↔ fullscreen (or open to fullscreen)
      if (mod && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        if (panelState === "closed") {
          // Open directly to fullscreen — context doesn't have openFullscreen,
          // so open first then toggle to fullscreen
          openPanel();
          toggleFullscreen();
          setTimeout(() => panelRef.current?.requestInputFocus(), 350);
        } else {
          toggleFullscreen();
          setTimeout(() => panelRef.current?.requestInputFocus(), 100);
        }
        return;
      }

      // Cmd/Ctrl+K : toggle closed ↔ sidebar
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

  const handleClose = useCallback(() => {
    closePanel();
  }, [closePanel]);

  const handleBack = useCallback(() => {
    closePanel();
  }, [closePanel]);

  const handleFullscreen = useCallback(() => {
    toggleFullscreen();
  }, [toggleFullscreen]);

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
      // Focus the input after opening
      requestAnimationFrame(() => {
        panelRef.current?.requestInputFocus();
      });
    },
    [panelState, openPanel, chat, appContext],
  );

  const handlePromptAction = useCallback(
    (prompt: string) => {
      if (panelState === "closed") {
        openPanel();
      }
      window.dispatchEvent(new CustomEvent("nb:prompt", { detail: { prompt } }));
      // Focus the input after opening
      setTimeout(() => {
        panelRef.current?.requestInputFocus();
      }, 350);
    },
    [panelState, openPanel],
  );

  const handleSendMessage = useCallback(
    (text: string, files?: File[]) => {
      return chat.sendMessage(text, appContext, files);
    },
    [chat, appContext],
  );

  const handleResizeDoubleClick = useCallback(() => {
    setPanelWidth(DEFAULT_WIDTH);
  }, [setPanelWidth]);

  const isSidebar = panelState === "sidebar";
  const isFullscreen = panelState === "fullscreen";
  const isOpen = isSidebar || isFullscreen;
  const hideMobileApp = isMobile && isSidebar;

  return (
    <div className="relative flex h-dvh w-full overflow-hidden">
      {/* App area — hidden on mobile when sidebar is open */}
      {!hideMobileApp && (
        <div
          className="flex-1 h-full min-w-0"
          style={{
            marginRight: isSidebar && !isMobile ? panelWidth + RESIZE_HANDLE_WIDTH : 0,
          }}
        >
          <div
            className={
              isFullscreen
                ? "h-full w-full opacity-30 scale-[0.98] blur-sm pointer-events-none transition-all duration-350 ease-out"
                : isDragging
                  ? "h-full w-full pointer-events-none"
                  : "h-full w-full"
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
            />
          </div>
        </div>
      )}

      {/* Resize handle — sidebar only, hidden on mobile */}
      {isSidebar && !isMobile && (
        <div className="fixed top-0 h-full z-20 hidden sm:block" style={{ right: panelWidth }}>
          <ResizeHandle
            initialWidth={panelWidth}
            onWidthChange={setPanelWidth}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={() => setIsDragging(false)}
            onDoubleClick={handleResizeDoubleClick}
            className="h-full"
          />
        </div>
      )}

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
          transition: isDragging
            ? `transform ${TRANSITION_STANDARD}`
            : isFullscreen
              ? `transform ${TRANSITION_FULLSCREEN}, width ${TRANSITION_FULLSCREEN}`
              : `transform ${TRANSITION_STANDARD}, width ${TRANSITION_STANDARD}`,
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
        />
      </div>
    </div>
  );
}
