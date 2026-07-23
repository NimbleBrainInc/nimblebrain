import { ArrowLeft, Check, Maximize2, Minimize2, SquarePen, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useChatContext } from "../context/ChatContext";
import type { ChatMessage } from "../hooks/useChat";
import type { DisplayDetail } from "../lib/tool-display";
import { InContextPopover } from "./InContextPopover";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";
import { RecentConversationsPopover } from "./RecentConversationsPopover";

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

/**
 * Prefer the server-generated title (updates live when it arrives); fall back to
 * the first user message, stripping markdown, capped at 40 chars with an ellipsis.
 */
function deriveDisplayTitle(title: string | null, messages: ChatMessage[]): string | null {
  const rawTitle = title ?? messages.find((m) => m.role === "user")?.content ?? null;
  if (!rawTitle) return null;
  const plainTitle = rawTitle
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/__(.+?)__/g, "$1") // bold alt
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/_(.+?)_/g, "$1") // italic alt
    .replace(/`(.+?)`/g, "$1") // inline code
    .replace(/\[(.+?)\]\(.*?\)/g, "$1") // links
    .replace(/\n/g, " ") // newlines to spaces
    .trim();
  const capped = plainTitle.slice(0, 40);
  if (!capped) return null;
  return plainTitle.length > 40 ? `${capped}…` : capped;
}

/** Resolve the display-detail level: explicit prop wins, else the stored preference, else balanced. */
function resolveDisplayDetail(displayDetailProp?: DisplayDetail): DisplayDetail {
  if (displayDetailProp) return displayDetailProp;
  const stored = localStorage.getItem("nb:displayDetail");
  if (stored === "quiet" || stored === "balanced" || stored === "verbose") {
    return stored;
  }
  return "balanced";
}

/** Chat panel header: back button, click-to-copy title, and the actions / skills / window-controls group. */
function ChatHeader({
  compact,
  onBack,
  conversationId,
  displayTitle,
  copiedId,
  onCopyId,
  isStreaming,
  onNewChat,
  onOpenConversation,
  onFullscreen,
  onClose,
  isFullscreen,
}: {
  compact: boolean;
  onBack?: () => void;
  conversationId: string | null;
  displayTitle: string | null;
  copiedId: boolean;
  onCopyId: () => void;
  isStreaming: boolean;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onFullscreen?: () => void;
  onClose?: () => void;
  isFullscreen: boolean;
}) {
  return (
    <header
      className={`flex items-center justify-between border-b border-border shrink-0 ${compact ? "h-14 px-4" : "h-14 px-6"}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {onBack && (
          <button
            onClick={onBack}
            type="button"
            aria-label="Back"
            className="p-1.5 hover:bg-muted rounded-sm transition-all text-muted-foreground hover:text-foreground sm:hidden shrink-0"
          >
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
        )}
        <button
          type="button"
          onClick={onCopyId}
          disabled={!conversationId}
          className={`font-heading text-base font-medium text-foreground flex items-center gap-1.5 transition-all duration-200 min-w-0 truncate ${
            conversationId ? "cursor-pointer hover:text-primary active:scale-95" : "cursor-default"
          }`}
          title={conversationId ? `Click to copy conversation ID: ${conversationId}` : undefined}
        >
          <span className="truncate">{displayTitle || "New chat"}</span>
          {copiedId && (
            <Check className="shrink-0 text-success" style={{ width: 14, height: 14 }} />
          )}
        </button>
      </div>
      {/* Grouped by altitude: conversation actions · skills · window controls.
          Learn-once shortcuts live on the composer's "?" footer, not here. */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-0.5">
          <RecentConversationsPopover
            activeConversationId={conversationId}
            onOpen={onOpenConversation}
          />
          <button
            onClick={onNewChat}
            type="button"
            disabled={isStreaming}
            aria-label="New chat"
            title="New chat"
            className="p-1.5 hover:bg-muted rounded-sm transition-all text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <SquarePen style={{ width: 16, height: 16 }} />
          </button>
        </div>
        <InContextPopover conversationId={conversationId} />
        {(onFullscreen || onClose) && (
          <div className="flex items-center gap-0.5">
            {onFullscreen && (
              <button
                onClick={onFullscreen}
                type="button"
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="p-1.5 hover:bg-muted rounded-sm transition-all text-muted-foreground hover:text-foreground"
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
                className="p-1.5 hover:bg-muted rounded-sm transition-all text-muted-foreground hover:text-foreground"
              >
                <X style={{ width: 16, height: 16 }} />
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
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
  const { conversationId, title, streamingState, preparingTool, stop, loadConversation } =
    useChatContext();

  const displayTitle = deriveDisplayTitle(title, messages);
  const displayDetail = resolveDisplayDetail(displayDetailProp);

  const handleCopyConversationId = useCallback(() => {
    if (!conversationId) return;
    navigator.clipboard.writeText(conversationId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1500);
  }, [conversationId]);

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
      <ChatHeader
        compact={compact}
        onBack={onBack}
        conversationId={conversationId}
        displayTitle={displayTitle}
        copiedId={copiedId}
        onCopyId={handleCopyConversationId}
        isStreaming={isStreaming}
        onNewChat={handleNewChat}
        onOpenConversation={loadConversation}
        onFullscreen={onFullscreen}
        onClose={onClose}
        isFullscreen={isFullscreen}
      />

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20 shrink-0">
          {error}
        </div>
      )}

      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        streamingState={streamingState}
        preparingTool={preparingTool}
        displayDetail={displayDetail}
        compact={compact}
        onRetry={onRetry}
      />

      <div ref={inputWrapperRef} className={compact ? "px-4" : "max-w-4xl w-full mx-auto px-8"}>
        <MessageInput
          onSend={sendMessage}
          disabled={isStreaming}
          onNewConversation={handleNewChat}
          onShowShortcuts={() => setShowShortcuts(true)}
          onStop={stop}
        />
      </div>

      <KeyboardShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
});
