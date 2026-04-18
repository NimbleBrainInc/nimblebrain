import { AlertCircle, Check, ChevronDown, Copy, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { ChatMessage, StreamingState } from "../hooks/useChat";
import { participantColor } from "../lib/participant-colors";
import type { DisplayDetail } from "../lib/tool-display";
import { FileAttachment } from "./FileAttachment";
import { InlineAppView } from "./InlineAppView";
import { ResourceLinkView } from "./ResourceLinkView";
import { ToolAccordion } from "./ToolAccordion";

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

const APP_CONTEXT_RE = /^\[App Context:[^\]]*\]\n/;

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 text-muted-foreground hover:text-foreground rounded transition-all"
      aria-label="Copy message"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

/**
 * Returns true when a speaker label should be shown (Option C: minimal attribution).
 * Only labels messages from other participants, and only on speaker transitions.
 */
function shouldShowSpeaker(
  msg: ChatMessage,
  idx: number,
  messages: ChatMessage[],
  currentUserId?: string,
): boolean {
  if (msg.role !== "user") return false;
  if (!msg.userId) return false;
  if (msg.userId === currentUserId) return false;
  // Find the previous user message to detect speaker change
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].userId !== msg.userId;
    }
  }
  return true; // First user message from someone other than current user
}

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingState: StreamingState;
  displayDetail: DisplayDetail;
  compact?: boolean;
  /** Current user's ID — messages from this user get no speaker label. */
  currentUserId?: string;
  /** Map of userId → display name for participant labels. */
  participantMap?: Map<string, string>;
}

const BOTTOM_THRESHOLD = 50;

/**
 * Scroll behavior:
 * - New message sent: scroll the user message to the top of the viewport, then
 *   let the response flow below naturally. No auto-scroll during streaming.
 * - Conversation loaded: start at the top. Show jump-to-bottom chevron.
 * - Never chase streaming content — the user scrolls when ready.
 */
function useSmartScroll(messages: ChatMessage[]) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Track the conversation identity to detect loads vs sends.
  // We use the first message's timestamp as a fingerprint — it changes when
  // a different conversation is loaded, but stays stable during streaming.
  const prevConversationKeyRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);

  const checkIsAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior });
  }, []);

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => setIsAtBottom(checkIsAtBottom());
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [checkIsAtBottom]);

  // React to message changes
  useEffect(() => {
    if (messages.length === 0) {
      prevConversationKeyRef.current = null;
      prevMessageCountRef.current = 0;
      return;
    }

    const conversationKey = messages[0]?.timestamp ?? "none";
    const prevKey = prevConversationKeyRef.current;
    const prevCount = prevMessageCountRef.current;
    prevConversationKeyRef.current = conversationKey;
    prevMessageCountRef.current = messages.length;

    // Conversation loaded (different conversation or first load with history)
    if (conversationKey !== prevKey && messages.length > 1) {
      // Use double-rAF to ensure DOM has rendered the messages
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
        });
      });
      setIsAtBottom(false);
      return;
    }

    // New user message sent: useChat adds user msg + assistant placeholder (count +2)
    if (
      conversationKey === prevKey &&
      messages.length >= 2 &&
      messages.length - prevCount >= 2 &&
      messages[messages.length - 2]?.role === "user"
    ) {
      const userMsgIndex = messages.length - 2;
      requestAnimationFrame(() => {
        const container = scrollRef.current;
        if (!container) return;
        // Messages are inside the inner padding div (first child of scroll container)
        const inner = container.firstElementChild;
        if (!inner) return;
        const el = inner.children[userMsgIndex] as HTMLElement | undefined;
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [messages]);

  return { scrollRef, bottomRef, isAtBottom, scrollToBottom };
}

export function MessageList({
  messages,
  isStreaming,
  streamingState,
  displayDetail,
  compact = false,
  currentUserId,
  participantMap,
}: MessageListProps) {
  const { scrollRef, bottomRef, isAtBottom, scrollToBottom } = useSmartScroll(messages);

  // Scroll to bottom when streaming ends with a stop reason notice.
  // The `done` event updates the last message in place (no length change),
  // so useSmartScroll's length-based trigger doesn't fire.
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.stopReason) {
        requestAnimationFrame(() => scrollToBottom("smooth"));
      }
    }
  }, [isStreaming, messages, scrollToBottom]);

  // Track which messages existed on mount/load so we don't animate them.
  // Only messages added after the initial render get the entrance animation.
  const initialCountRef = useRef(messages.length);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on conversation identity (first message timestamp)
  useEffect(() => {
    // When conversation changes (messages replaced wholesale), update the baseline
    initialCountRef.current = messages.length;
  }, [messages[0]?.timestamp]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-8 py-6 flex items-center justify-center">
        <p className="font-heading text-lg text-muted-foreground">Ask anything...</p>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        className={`h-full overflow-y-auto transition-colors duration-[2000ms] ${
          isStreaming ? "chat-ambient-warm" : ""
        }`}
      >
        <div className={`py-6 flex flex-col gap-10 ${compact ? "px-4" : "px-8 max-w-4xl mx-auto"}`}>
          {messages.map((msg, idx) => {
            // Assistant placeholder with nothing to show yet — bridge the gap
            // between user send and first output with an inline "Thinking".
            // Tool spinners live on the accordion; this is only for the pre-
            // first-output pause.
            const isEmptyAssistant =
              msg.role === "assistant" &&
              !msg.content &&
              (!msg.toolCalls || msg.toolCalls.length === 0);
            const showThinkingPlaceholder =
              isEmptyAssistant &&
              isStreaming &&
              idx === messages.length - 1 &&
              (streamingState === "thinking" || streamingState === "working");

            const contextMatch = msg.role === "user" ? msg.content.match(APP_CONTEXT_RE) : null;
            const contextPrefix = contextMatch ? contextMatch[0].trim() : null;
            const displayContent = contextMatch
              ? msg.content.slice(contextMatch[0].length)
              : msg.content;

            const showTimestamp =
              displayDetail === "verbose" || (displayDetail === "balanced" && msg.timestamp);

            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: messages lack stable IDs and don't reorder
                key={idx}
                className={`group relative flex flex-col scroll-mt-6 ${idx >= initialCountRef.current ? "presence-message-enter" : ""} ${
                  msg.role === "user"
                    ? "max-w-[80%] self-end items-end"
                    : "w-full self-start items-start"
                }`}
              >
                {msg.role === "user" ? (
                  <div
                    className={`pl-4 border-l-2 break-words whitespace-pre-wrap ${
                      msg.userId && msg.userId !== currentUserId ? "" : "border-border"
                    }`}
                    style={
                      msg.userId && msg.userId !== currentUserId
                        ? { borderLeftColor: participantColor(msg.userId) }
                        : undefined
                    }
                  >
                    {shouldShowSpeaker(msg, idx, messages, currentUserId) && (
                      <div
                        className="flex items-center gap-1.5 mb-1 text-[11px] font-medium"
                        style={{ color: participantColor(msg.userId!) }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full inline-block"
                          style={{ background: participantColor(msg.userId!) }}
                        />
                        {participantMap?.get(msg.userId!) ?? msg.userId}
                      </div>
                    )}
                    {contextPrefix && (
                      <details className="mb-1">
                        <summary className="text-[10px] opacity-60 cursor-pointer select-none">
                          App Context
                        </summary>
                        <span className="block text-[10px] opacity-60 mt-0.5">{contextPrefix}</span>
                      </details>
                    )}
                    {msg.files && msg.files.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {msg.files.map((file) => (
                          <FileAttachment key={file.id} file={file} />
                        ))}
                      </div>
                    )}
                    <span className="presence-user-message italic">{displayContent}</span>
                  </div>
                ) : (
                  <div className="break-words min-w-0 overflow-hidden flex flex-col gap-3">
                    {showThinkingPlaceholder && (
                      <span className="text-xs font-mono text-muted-foreground/60 presence-thinking">
                        Thinking
                      </span>
                    )}
                    {/* Render content blocks in temporal order */}
                    {msg.blocks ? (
                      msg.blocks.map((block, blockIdx) => {
                        if (block.type === "text" && block.text) {
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only and don't reorder
                            <div key={blockIdx} className="min-h-[1em]">
                              <Streamdown
                                className="streamdown-container presence-assistant-message"
                                isAnimating={
                                  isStreaming &&
                                  idx === messages.length - 1 &&
                                  blockIdx === msg.blocks!.length - 1
                                }
                              >
                                {block.text}
                              </Streamdown>
                            </div>
                          );
                        }
                        if (block.type === "tool" && block.toolCalls.length > 0) {
                          const blockWidgets = block.toolCalls.filter(
                            (tc) => tc.resourceUri && tc.status === "done" && tc.appName,
                          );
                          const resourceLinkCalls = block.toolCalls.filter(
                            (tc) =>
                              tc.status === "done" &&
                              tc.appName &&
                              tc.resourceLinks &&
                              tc.resourceLinks.length > 0,
                          );
                          return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only and don't reorder
                            <div key={blockIdx} className="flex flex-col gap-3">
                              <ToolAccordion
                                calls={block.toolCalls}
                                displayDetail={displayDetail}
                              />
                              {blockWidgets.map((tc) => {
                                const match = tc.resourceUri!.match(/^ui:\/\/[^/]+\/(.+)$/);
                                const resourcePath = match ? match[1] : "primary";
                                return (
                                  <InlineAppView
                                    key={tc.id}
                                    appName={tc.appName!}
                                    resourceUri={resourcePath}
                                    toolResult={{ tool: tc.name, result: tc.result }}
                                  />
                                );
                              })}
                              {resourceLinkCalls.flatMap((tc) =>
                                tc.resourceLinks!.map((link) => (
                                  <ResourceLinkView
                                    key={`${tc.id}:${link.uri}`}
                                    appName={tc.appName!}
                                    uri={link.uri}
                                    name={link.name}
                                    mimeType={link.mimeType}
                                    description={link.description}
                                  />
                                )),
                              )}
                            </div>
                          );
                        }
                        return null;
                      })
                    ) : (
                      <div className="min-h-[1em]">
                        <Streamdown
                          className="streamdown-container presence-assistant-message"
                          isAnimating={isStreaming && idx === messages.length - 1}
                        >
                          {displayContent}
                        </Streamdown>
                      </div>
                    )}
                    {/* File attachments */}
                    {msg.files && msg.files.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {msg.files.map((file) => (
                          <FileAttachment key={file.id} file={file} />
                        ))}
                      </div>
                    )}
                    {/* Stop reason notice */}
                    {msg.stopReason && (
                      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-muted/50 border border-border text-sm text-muted-foreground">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>
                          {msg.stopReason === "max_iterations"
                            ? "I reached my step limit for this turn. Send another message and I'll pick up where I left off."
                            : `Run ended: ${msg.stopReason}`}
                        </span>
                      </div>
                    )}
                    {/* Inline app views are rendered within their tool block above */}
                  </div>
                )}
                {/* Hover chrome — copy button + timestamp + token count.
                    Absolutely positioned so it overlays into the existing
                    gap between messages instead of reserving dead vertical
                    space. Aligned to the same edge as the message bubble.
                    `whitespace-nowrap` keeps the row single-line regardless
                    of how narrow the parent bubble gets (short messages
                    otherwise force text to wrap since the absolute child
                    inherits the parent's shrink-to-fit width). */}
                <div
                  className={`absolute top-full ${msg.role === "user" ? "right-0" : "left-0"} mt-1 flex items-center gap-2 whitespace-nowrap opacity-0 group-hover:opacity-100 metadata-hover transition-opacity duration-200`}
                >
                  <CopyButton content={displayContent} />
                  {showTimestamp && msg.timestamp && (
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(msg.timestamp)}
                    </span>
                  )}
                  {msg.usage && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                      title={`${formatTokens(msg.usage.inputTokens)} in, ${formatTokens(msg.usage.outputTokens)} out${msg.usage.cacheReadTokens ? ` (${formatTokens(msg.usage.cacheReadTokens)} cached)` : ""} · ${msg.usage.model} · ${Math.round(msg.usage.llmMs)}ms`}
                    >
                      <Zap style={{ width: 10, height: 10 }} className="opacity-70" />
                      <span className="tabular-nums">
                        {formatTokens(msg.usage.inputTokens + msg.usage.outputTokens)}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {/* Spacer: ensures any message can scroll to the top of the viewport */}
          <div className="min-h-[60vh] shrink-0" />
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Jump to bottom */}
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Jump to bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 p-1.5 rounded-full border border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors cursor-pointer z-10"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
