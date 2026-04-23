import { ArrowLeft, Check, Keyboard, Maximize2, Minimize2, RotateCcw, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useChatConfigContext, useChatContext } from "../context/ChatContext";
import type { ChatMessage } from "../hooks/useChat";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";
import type { DisplayDetail } from "../lib/tool-display";

export interface ChatPanelProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string, files?: File[]) => Promise<void>;
  newConversation: () => void;
  compact?: boolean;
  onClose?: () => void;
  onFullscreen?: () => void;
  onBack?: () => void;
  isFullscreen?: boolean;
  displayDetail?: DisplayDetail;
  /** Called when the user clicks "Try again" on an errored message. */
  onRetry?: () => void;
}

export interface ChatPanelRef {
  requestInputFocus: () => void;
}

export const ChatPanel = forwardRef<ChatPanelRef, ChatPanelProps>(function ChatPanel(
  {
    messages,
    isStreaming,
    error,
    sendMessage,
    newConversation,
    compact = false,
    onClose,
    onFullscreen,
    onBack,
    isFullscreen = false,
    displayDetail: displayDetailProp,
    onRetry,
  },
  ref,
) {
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const { conversationId, streamingState } = useChatContext();
  const { currentUserId, participantMap } = useChatConfigContext();

  // Derive a title from the first user message, stripping markdown syntax
  const rawTitle = messages.find((m) => m.role === "user")?.content || null;
  const plainTitle = rawTitle
    ? rawTitle
        .replace(/^#{1,6}\s+/gm, "") // headings
        .replace(/\*\*(.+?)\*\*/g, "$1") // bold
        .replace(/__(.+?)__/g, "$1") // bold alt
        .replace(/\*(.+?)\*/g, "$1") // italic
        .replace(/_(.+?)_/g, "$1") // italic alt
        .replace(/`(.+?)`/g, "$1") // inline code
        .replace(/\[(.+?)\]\(.*?\)/g, "$1") // links
        .replace(/\n/g, " ") // newlines to spaces
        .trim()
    : null;
  const conversationTitle = plainTitle?.slice(0, 30) || null;
  const displayTitle = conversationTitle
    ? plainTitle && plainTitle.length > 30
      ? `${conversationTitle}…`
      : conversationTitle
    : null;

  const handleCopyConversationId = useCallback(() => {
    if (!conversationId) return;
    navigator.clipboard.writeText(conversationId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1500);
  }, [conversationId]);

  const displayDetail: DisplayDetail =
    displayDetailProp ??
    (() => {
      const stored = localStorage.getItem("nb:displayDetail");
      if (stored === "quiet" || stored === "balanced" || stored === "verbose") {
        return stored;
      }
      return "balanced";
    })();

  useImperativeHandle(ref, () => ({
    requestInputFocus: () => {
      const textarea = inputWrapperRef.current?.querySelector("textarea");
      textarea?.focus();
    },
  }));

  const handleNewChat = useCallback(() => {
    newConversation();
    const textarea = inputWrapperRef.current?.querySelector("textarea");
    if (textarea) {
      textarea.style.transition = "transform 100ms ease-out";
      textarea.style.transform = "scale(1.02)";
      setTimeout(() => {
        textarea.style.transform = "scale(1)";
        setTimeout(() => {
          textarea.style.transition = "";
          textarea.style.transform = "";
        }, 100);
      }, 100);
    }
  }, [newConversation]);

  // ? key opens shortcuts modal (only when not typing in textarea)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.key === "?" &&
        !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
      ) {
        e.preventDefault();
        setShowShortcuts(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex flex-col h-dvh bg-card text-foreground">
      <header
        className={`flex items-center justify-between border-b border-border shrink-0 ${compact ? "h-14 px-4" : "h-14 px-6"}`}
      >
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              type="button"
              aria-label="Back"
              className="p-1.5 hover:bg-muted rounded-lg transition-all text-muted-foreground hover:text-foreground sm:hidden"
            >
              <ArrowLeft style={{ width: 18, height: 18 }} />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopyConversationId}
            disabled={!conversationId}
            className={`font-heading text-base font-medium text-foreground flex items-center gap-1.5 transition-all duration-200 truncate max-w-[200px] ${
              conversationId
                ? "cursor-pointer hover:text-primary active:scale-95"
                : "cursor-default"
            }`}
            title={conversationId ? `Click to copy conversation ID: ${conversationId}` : undefined}
          >
            <span className="truncate">{displayTitle || "New chat"}</span>
            {copiedId && (
              <Check className="shrink-0 text-success" style={{ width: 14, height: 14 }} />
            )}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleNewChat}
            type="button"
            disabled={isStreaming}
            aria-label="New conversation"
            className="p-1.5 hover:bg-muted rounded-lg transition-all text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw style={{ width: 16, height: 16 }} />
          </button>
          <button
            onClick={() => setShowShortcuts(true)}
            type="button"
            aria-label="Keyboard shortcuts"
            className="p-1.5 hover:bg-muted rounded-lg transition-all text-muted-foreground hover:text-foreground"
          >
            <Keyboard style={{ width: 16, height: 16 }} />
          </button>
          {onFullscreen && (
            <button
              onClick={onFullscreen}
              type="button"
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className="p-1.5 hover:bg-muted rounded-lg transition-all text-muted-foreground hover:text-foreground"
            >
              {isFullscreen ? (
                <Minimize2 style={{ width: 16, height: 16 }} />
              ) : (
                <Maximize2 style={{ width: 16, height: 16 }} />
              )}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              type="button"
              aria-label="Close"
              className="p-1.5 hover:bg-muted rounded-lg transition-all text-muted-foreground hover:text-foreground"
            >
              <X style={{ width: 16, height: 16 }} />
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20 shrink-0">
          {error}
        </div>
      )}

      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        streamingState={streamingState}
        displayDetail={displayDetail}
        compact={compact}
        currentUserId={currentUserId}
        participantMap={participantMap}
        onRetry={onRetry}
      />

      <div ref={inputWrapperRef} className={compact ? "px-4" : "max-w-4xl w-full mx-auto px-8"}>
        <MessageInput
          onSend={sendMessage}
          disabled={isStreaming}
          onNewConversation={handleNewChat}
          streamingState={streamingState}
        />
      </div>

      <KeyboardShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
});
