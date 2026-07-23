import { AlertCircle, Check, ChevronDown, Copy, RotateCcw, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { ChatMessage, PreparingTool, StreamingState } from "../hooks/useChat";
import { linkSafety } from "../lib/streamdown-config";
import type { DisplayDetail } from "../lib/tool-display";
import { BlockTimeline } from "./BlockTimeline";
import { FileAttachment } from "./FileAttachment";
import { LedgerLine } from "./LedgerLine";

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

/**
 * Per-turn usage chip. Shows the *new* work inline — fresh (non-cached) input
 * as "N new", plus the cached re-reads as "Nk cached" when present. The raw
 * input total sums every agentic-loop iteration AND counts cache reads at face
 * value, so a cache-heavy turn reads as a scary number (e.g. "401k") that's
 * almost all re-reads. Output, cache *writes*, model, and latency are
 * deliberately omitted to keep the bar ambient ("new" is noCache only). Inline
 * (not a hover title) so the breakdown is actually visible.
 */
function UsageChip({ usage }: { usage: NonNullable<ChatMessage["usage"]> }) {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const freshIn = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);

  const parts = [`${formatTokens(freshIn)} new`];
  if (cacheRead > 0) parts.push(`${formatTokens(cacheRead)} cached`);

  return (
    <span className="inline-flex items-center gap-1 text-3xs text-muted-foreground tabular-nums">
      <Zap style={{ width: 10, height: 10 }} className="opacity-70" />
      <span>{parts.join(" · ")}</span>
    </span>
  );
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

/**
 * User-facing copy for run-level stop reasons. Only fires when stopReason
 * is not "complete" (the happy path is filtered upstream in useChat).
 * Unknown values fall through to the generic fallback so a future engine
 * change can't break the UI silently.
 */
function stopReasonMessage(stopReason: string): string {
  switch (stopReason) {
    case "max_iterations":
      return "I reached my step limit for this turn. Send another message and I'll pick up where I left off.";
    case "length":
      // The two common causes of `length` are (a) writing a long response
      // and running out of room and (b) extended thinking burning the
      // output budget before any visible content lands. The platform now
      // caps thinking to leave headroom (see resolveThinking), but breaking
      // the task up still helps when the response itself is large.
      return "I ran out of room mid-response (hit the output-token limit). Send another message to continue, or try splitting the task into smaller pieces.";
    case "content_filter":
      return "The response was blocked by content filtering. Try rephrasing your request.";
    case "error":
      return "The model returned an error. Try again, or rephrase if it keeps happening.";
    default:
      return `Run ended: ${stopReason}`;
  }
}

type CopyState = "idle" | "copied" | "failed";

function CopyButton({ content }: { content: string }) {
  const [state, setState] = useState<CopyState>("idle");

  const handleCopy = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API not available");
      }
      await navigator.clipboard.writeText(content);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  }, [content]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 text-muted-foreground hover:text-foreground rounded transition-all"
      aria-label={state === "failed" ? "Copy failed" : "Copy message"}
      title={state === "failed" ? "Copy failed" : undefined}
    >
      {state === "copied" ? (
        <Check className="w-3.5 h-3.5 text-success" />
      ) : state === "failed" ? (
        <AlertCircle className="w-3.5 h-3.5 text-destructive" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingState: StreamingState;
  /** Set while the model is emitting a tool-call block (pre-execution). */
  preparingTool?: PreparingTool | null;
  displayDetail: DisplayDetail;
  compact?: boolean;
  /** Called when the user clicks "Try again" on an errored message. */
  onRetry?: () => void;
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
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Track the conversation identity to detect loads vs sends.
  // We use the first message's timestamp as a fingerprint — it changes when
  // a different conversation is loaded, but stays stable during streaming.
  const prevConversationKeyRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);

  // "Bottom" is the newest message resting at the viewport bottom — NOT the raw
  // scroll end. The list keeps a 60vh trailing spacer (headroom so a fresh
  // question can scroll to the top), and resting in that spacer would show blank
  // space below the content. So both the flag and the scroll key off the last
  // message element, never `scrollHeight`. DOM order is [...messages, spacer], so
  // the last message is at index messages.length - 1.
  const lastMessageEl = useCallback(
    () => scrollRef.current?.firstElementChild?.children[messages.length - 1] as HTMLElement | null,
    [messages.length],
  );

  const checkIsAtBottom = useCallback(() => {
    const el = scrollRef.current;
    const last = lastMessageEl();
    if (!el || !last) return true;
    // At bottom ⇔ none of the newest message sits below the fold.
    return (
      last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom <= BOTTOM_THRESHOLD
    );
  }, [lastMessageEl]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      lastMessageEl()?.scrollIntoView({ behavior, block: "end" });
    },
    [lastMessageEl],
  );

  // Keep isAtBottom accurate so the jump-to-bottom chevron reflects reality.
  // The scroll container renders only once there are messages, so attach when it
  // mounts. A 'scroll' listener catches the user scrolling; a ResizeObserver on
  // the content catches streaming growth, which appends below the fold WITHOUT
  // firing a scroll event. Both only set the flag — neither scrolls, honoring the
  // "don't chase streaming content" rule below.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!hasMessages || !el) return;
    const update = () => setIsAtBottom(checkIsAtBottom());
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [hasMessages, checkIsAtBottom]);

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

    // Conversation loaded (different conversation or first load with history):
    // land at the bottom (most recent turn), like ChatGPT/Claude.
    if (conversationKey !== prevKey && messages.length > 1) {
      // Use double-rAF to ensure the DOM has rendered the messages. Scroll the
      // last real message to the viewport bottom (not the trailing 60vh
      // spacer, which would leave the last turn off-screen).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = scrollRef.current;
          const inner = container?.firstElementChild;
          const lastMsg = inner?.children[messages.length - 1] as HTMLElement | undefined;
          if (lastMsg) lastMsg.scrollIntoView({ behavior: "instant", block: "end" });
          else container?.scrollTo({ top: container.scrollHeight, behavior: "instant" });
        });
      });
      setIsAtBottom(true);
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

  return { scrollRef, isAtBottom, scrollToBottom };
}

/** One user message body: optional app-context disclosure, file chips, and the italic message text. */
function UserMessage({
  contextPrefix,
  files,
  displayContent,
}: {
  contextPrefix: string | null;
  files: ChatMessage["files"];
  displayContent: string;
}) {
  return (
    <div className="pl-4 border-l-2 border-border break-words whitespace-pre-wrap">
      {contextPrefix && (
        <details className="mb-1">
          <summary className="text-3xs opacity-60 cursor-pointer select-none">App Context</summary>
          <span className="block text-3xs opacity-60 mt-0.5">{contextPrefix}</span>
        </details>
      )}
      {files && files.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {files.map((file) => (
            <FileAttachment key={file.id} file={file} />
          ))}
        </div>
      )}
      <span className="presence-user-message italic">{displayContent}</span>
    </div>
  );
}

/** Run-level stop-reason notice shown under an assistant turn. */
function StopReasonNotice({ stopReason }: { stopReason: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-sm bg-muted/50 border border-border text-sm text-muted-foreground">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{stopReasonMessage(stopReason)}</span>
    </div>
  );
}

/** Inline error notice with an optional retry button and a collapsible detail. */
function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="px-3 py-2.5 rounded-sm bg-destructive/10 border border-destructive/20 text-sm">
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 text-destructive" />
        <span className="flex-1 text-foreground">
          Something went wrong. You can try again or continue the conversation.
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-sm border border-border bg-card hover:bg-muted text-foreground transition-colors shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            Try again
          </button>
        )}
      </div>
      <details className="mt-1.5 ml-6">
        <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
          Details
        </summary>
        <p className="text-xs text-muted-foreground mt-1 font-mono break-all">{error}</p>
      </details>
    </div>
  );
}

/** One assistant message body: block timeline (or legacy Streamdown), file chips, and stop/error notices. */
function AssistantMessage({
  msg,
  displayContent,
  isLast,
  isStreaming,
  streamingState,
  preparingTool,
  displayDetail,
  onRetry,
}: {
  msg: ChatMessage;
  displayContent: string;
  isLast: boolean;
  isStreaming: boolean;
  streamingState: StreamingState;
  preparingTool?: PreparingTool | null;
  displayDetail: DisplayDetail;
  onRetry?: () => void;
}) {
  // The newest message is the live one while streaming — it animates and drives
  // the current-message affordances in BlockTimeline.
  const isCurrent = isStreaming && isLast;
  return (
    <div className="w-full break-words min-w-0 overflow-hidden flex flex-col gap-3">
      {/* Context Ledger: which skills equipped this turn. Rendered first —
          above the first activity chip — because selection happens at
          compose time, before any block streams. */}
      <LedgerLine skills={msg.skillsLoaded} />
      {msg.blocks ? (
        <BlockTimeline
          blocks={msg.blocks}
          isCurrentMessage={isCurrent}
          streamingState={streamingState}
          preparingTool={preparingTool ?? null}
          displayDetail={displayDetail}
        />
      ) : (
        // Legacy / pre-block-model conversations: render the serialized message
        // content as one Streamdown block. The block model has been the engine's
        // emission shape for some time, so this branch is essentially
        // history-only; kept for archived JSONLs that don't have `blocks` populated.
        <div className="min-h-[1em]">
          <Streamdown
            className="streamdown-container presence-assistant-message"
            isAnimating={isCurrent}
            linkSafety={linkSafety}
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
      {msg.stopReason && <StopReasonNotice stopReason={msg.stopReason} />}
      {/* Inline error notice */}
      {msg.error && <ErrorNotice error={msg.error} onRetry={onRetry} />}
      {/* Inline app views are rendered within their tool block above */}
    </div>
  );
}

/**
 * Hover chrome — copy button + timestamp + token count. Absolutely positioned so
 * it overlays into the existing gap between messages instead of reserving dead
 * vertical space. Aligned to the same edge as the message bubble.
 * `whitespace-nowrap` keeps the row single-line regardless of how narrow the
 * parent bubble gets (short messages otherwise force text to wrap since the
 * absolute child inherits the parent's shrink-to-fit width).
 */
function MessageFooter({
  msg,
  displayContent,
  showTimestamp,
}: {
  msg: ChatMessage;
  displayContent: string;
  showTimestamp: boolean;
}) {
  return (
    <div
      className={`absolute top-full ${msg.role === "user" ? "right-0" : "left-0"} mt-1 flex items-center gap-2 whitespace-nowrap opacity-0 group-hover:opacity-100 metadata-hover transition-opacity duration-200`}
    >
      <CopyButton content={displayContent} />
      {showTimestamp && msg.timestamp && (
        <span className="text-3xs text-muted-foreground">{formatRelativeTime(msg.timestamp)}</span>
      )}
      {msg.usage && <UsageChip usage={msg.usage} />}
    </div>
  );
}

/** One chat row: derives the app-context slice, then renders the role body and hover footer. */
function MessageItem({
  msg,
  isNew,
  isLast,
  isStreaming,
  streamingState,
  preparingTool,
  displayDetail,
  onRetry,
}: {
  msg: ChatMessage;
  isNew: boolean;
  isLast: boolean;
  isStreaming: boolean;
  streamingState: StreamingState;
  preparingTool?: PreparingTool | null;
  displayDetail: DisplayDetail;
  onRetry?: () => void;
}) {
  const contextMatch = msg.role === "user" ? msg.content.match(APP_CONTEXT_RE) : null;
  const contextPrefix = contextMatch ? contextMatch[0].trim() : null;
  const displayContent = contextMatch ? msg.content.slice(contextMatch[0].length) : msg.content;
  const showTimestamp =
    displayDetail === "verbose" || (displayDetail === "balanced" && !!msg.timestamp);

  return (
    <div
      // scroll-mt-6 leaves room above when a message scrolls to the top
      // (block:start); scroll-mb-10 leaves room below when it scrolls to
      // the bottom (block:end) so the hover footer — timestamp · copy ·
      // tokens, which hangs below the box at `top-full` — stays in view.
      className={`group relative flex flex-col scroll-mt-6 scroll-mb-10 ${isNew ? "presence-message-enter" : ""} ${
        msg.role === "user" ? "max-w-[80%] self-end items-end" : "w-full self-start items-start"
      }`}
    >
      {msg.role === "user" ? (
        <UserMessage
          contextPrefix={contextPrefix}
          files={msg.files}
          displayContent={displayContent}
        />
      ) : (
        <AssistantMessage
          msg={msg}
          displayContent={displayContent}
          isLast={isLast}
          isStreaming={isStreaming}
          streamingState={streamingState}
          preparingTool={preparingTool}
          displayDetail={displayDetail}
          onRetry={onRetry}
        />
      )}
      <MessageFooter msg={msg} displayContent={displayContent} showTimestamp={showTimestamp} />
    </div>
  );
}

export function MessageList({
  messages,
  isStreaming,
  streamingState,
  preparingTool,
  displayDetail,
  compact = false,
  onRetry,
}: MessageListProps) {
  const { scrollRef, isAtBottom, scrollToBottom } = useSmartScroll(messages);

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
      <div ref={scrollRef} className="h-full overflow-y-auto">
        <div className={`py-6 flex flex-col gap-10 ${compact ? "px-4" : "px-8 max-w-4xl mx-auto"}`}>
          {messages.map((msg, idx) => (
            <MessageItem
              // biome-ignore lint/suspicious/noArrayIndexKey: messages lack stable IDs and don't reorder
              key={idx}
              msg={msg}
              isNew={idx >= initialCountRef.current}
              isLast={idx === messages.length - 1}
              isStreaming={isStreaming}
              streamingState={streamingState}
              preparingTool={preparingTool}
              displayDetail={displayDetail}
              onRetry={onRetry}
            />
          ))}
          {/* Spacer: ensures any message can scroll to the top of the viewport */}
          <div className="min-h-[60vh] shrink-0" />
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
