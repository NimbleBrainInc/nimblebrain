import {
  callTool,
  cancelChatTurn,
  getAuthToken,
  startChatTurn,
  startChatTurnMultipart,
} from "../api/client";
import {
  type ConversationStreamConnection,
  connectConversationStream,
} from "../api/conversation-stream";
import { formatSendError } from "../api/format-error";
import { appNameFromToolName } from "../lib/namespaced-tool.ts";
import type {
  AppContext,
  ChatRequest,
  ChatResult,
  LlmDoneEvent,
  ReasoningDeltaEvent,
  StreamErrorEvent,
  TextDeltaEvent,
  ToolDoneEvent,
  ToolPreparingEvent,
  ToolStartEvent,
} from "../types";

// ===========================================================================
// Public display types (shared across the chat UI). These live here — not in
// useChat — because the slice store is the lowest layer that owns them and
// `useChat` re-exports them for backward-compatible imports.
// ===========================================================================

export type StreamingState =
  | null
  | "thinking"
  | "streaming"
  | "preparing"
  | "working"
  | "analyzing";

/** Identifies the tool the model is currently building a call for. */
export interface PreparingTool {
  id: string;
  name: string;
}

/** Typed tool result shape forwarded through the bridge. */
export interface ToolResultForUI {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

/** Tool call with UI state for streaming display. */
export interface ToolCallDisplay {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  ok?: boolean;
  ms?: number;
  resourceUri?: string;
  resourceLinks?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    description?: string;
  }>;
  result?: ToolResultForUI;
  input?: Record<string, unknown>;
  appName?: string;
}

/** A block in the assistant message stream — text, reasoning, or tool group. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; toolCalls: ToolCallDisplay[] };

/** Live iteration progress during streaming. */
export interface IterationProgress {
  n: number;
  inputTokens: number;
  outputTokens: number;
}

/** File metadata attached to a message. */
export interface MessageFileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
}

/** A chat message with ordered content blocks for display. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: ContentBlock[];
  toolCalls?: ToolCallDisplay[];
  iteration?: IterationProgress;
  timestamp?: string;
  userId?: string;
  files?: MessageFileAttachment[];
  stopReason?: string;
  /** Loaded-from-disk turn with no terminal event yet (run still in flight when
   *  read). Drives the resume reconcile — a partial snapshot vs a finished turn. */
  pending?: boolean;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    model: string;
    llmMs: number;
  };
}

/** Conversation-level metadata (Stage 1: single-owner only). */
export interface LoadedConversationMeta {
  ownerId?: string;
}

// ===========================================================================
// Snapshot — the immutable view a React component renders for one conversation.
// ===========================================================================

export interface ChatSnapshot {
  conversationId: string | null;
  /** Server-generated conversation title (null until generated/loaded). */
  title: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingState: StreamingState;
  preparingTool: PreparingTool | null;
  meta: LoadedConversationMeta | null;
  error: string | null;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_SNAPSHOT: ChatSnapshot = {
  conversationId: null,
  title: null,
  messages: EMPTY_MESSAGES,
  isStreaming: false,
  streamingState: null,
  preparingTool: null,
  meta: null,
  error: null,
};

// ===========================================================================
// Slice — mutable per-conversation viewer state.
//
// The server is authoritative: a turn runs to completion server-side and its
// events are published to a per-conversation stream. This slice is a *view*
// over that stream plus the persisted history. Switching away / refreshing
// just detaches; re-attaching replays the in-flight turn (issue #254 +
// server-authoritative streaming follow-up).
// ===========================================================================

interface ConversationSlice {
  keys: Set<string>;
  conversationId: string | null;
  title: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingState: StreamingState;
  preparingTool: PreparingTool | null;
  meta: LoadedConversationMeta | null;
  error: string | null;
  // streaming scratch
  blocks: ContentBlock[];
  toolCalls: ToolCallDisplay[];
  iteration?: IterationProgress;
  // live subscription to the server turn stream (null when detached)
  connection: ConversationStreamConnection | null;
  /** The next streamed `user.message` echoes a turn we optimistically added —
   *  consume it instead of appending a duplicate. */
  pendingEcho: boolean;
  /** The params of the last `sendTurn` on this slice. Retry replays these
   *  verbatim — same text, model, and appContext — so it reproduces the
   *  original send instead of re-deriving model/context from current UI state
   *  (which silently downgraded the model on retry). */
  lastSend?: StartTurnParams;
  /** Stop pressed before `/v1/chat/start` resolved (no conversationId yet).
   *  `sendTurn` fires the cancel as soon as it has the id. */
  cancelRequested: boolean;
  /** First `subscribed` frame of a resume should trim a stale in-flight turn
   *  from disk history (the replay rebuilds it). */
  resumeOnSubscribe: boolean;
  /** True once full history is loaded (loadConversation) or the conversation
   *  was authored in this session (sendTurn / new draft). A dot-only probe
   *  leaves it false so opening the conversation still fetches full history. */
  hydrated: boolean;
  lastActiveAt: number;
  snapshot: ChatSnapshot;
}

export interface StartTurnHooks {
  onConversationId?: (id: string) => void;
}

export interface StartTurnParams {
  text: string;
  appContext?: AppContext;
  model?: string;
  files?: File[];
  currentUserId?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function cloneBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((b) => {
    if (b.type === "tool") return { ...b, toolCalls: [...b.toolCalls] };
    return { ...b };
  });
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function wrapStringResult(text: string, isError = false): ToolResultForUI {
  return { content: [{ type: "text", text }], isError };
}

const updateTool =
  (evt: ToolDoneEvent) =>
  (tc: ToolCallDisplay): ToolCallDisplay =>
    tc.id === evt.id
      ? {
          ...tc,
          status: evt.ok ? ("done" as const) : ("error" as const),
          ok: evt.ok,
          ms: evt.ms,
          resourceUri: tc.resourceUri ?? evt.resourceUri,
          resourceLinks:
            evt.resourceLinks != null && evt.resourceLinks.length > 0
              ? evt.resourceLinks
              : tc.resourceLinks,
          result: evt.result != null ? (evt.result as ToolResultForUI) : tc.result,
        }
      : tc;

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const DRAFT_PREFIX = "draft:";
let draftCounter = 0;

export function freshDraftKey(): string {
  draftCounter += 1;
  return `${DRAFT_PREFIX}${draftCounter}`;
}

export function isDraftKey(key: string): boolean {
  return key.startsWith(DRAFT_PREFIX);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_SLICES = 30;

export interface ChatStore {
  ensureSlice(key: string, opts?: { conversationId?: string | null }): void;
  getSnapshot(key: string): ChatSnapshot;
  subscribeSlice(key: string, cb: () => void): () => void;
  getStreamingIds(): string[];
  subscribeStreamingIds(cb: () => void): () => void;
  markActive(key: string): void;
  markInactive(key: string): void;
  /** Send a message: start a server turn, then watch its stream. */
  sendTurn(key: string, params: StartTurnParams, hooks?: StartTurnHooks): Promise<void>;
  /** Load persisted history and attach to any in-flight turn. */
  loadConversation(id: string): Promise<void>;
  /** Probe whether a conversation is generating (restores dots on reload),
   *  without fetching message history. */
  probeConversation(id: string): void;
  /** Set a conversation's title (from the live `conversation.title` SSE).
   *  No-op if the conversation has no slice in this tab. */
  setTitle(conversationId: string, title: string): void;
  /** Stop an in-flight turn (the only thing that aborts generation). */
  cancelTurn(key: string): void;
  /** Re-send the last message on this slice, replaying its original send
   *  params (text + model + appContext). No-op if nothing was sent yet. */
  retryLastMessage(key: string): void;
  simulateError(key: string, message: string): void;
  reset(): void;
  /** Close every per-slice SSE socket WITHOUT clearing slice state. For
   *  `pagehide` (tab close / bfcache enter): lets the server reclaim SSE
   *  slots immediately instead of waiting on TCP teardown, while leaving
   *  the in-memory slices intact so a bfcache restore can re-attach. The
   *  heavier {@link reset} (which also clears all state) is for identity
   *  change, not tab lifecycle. */
  closeAllConnections(): void;
  sliceCount(): number;
}

export function createChatStore(): ChatStore {
  const byKey = new Map<string, ConversationSlice>();
  const allSlices = new Set<ConversationSlice>();
  const listeners = new Map<string, Set<() => void>>();
  const activeCounts = new Map<string, number>();

  let streamingIds: string[] = [];
  const streamingListeners = new Set<() => void>();

  // -- snapshot + notification --

  function buildSnapshot(slice: ConversationSlice): ChatSnapshot {
    return {
      conversationId: slice.conversationId,
      title: slice.title,
      messages: slice.messages,
      isStreaming: slice.isStreaming,
      streamingState: slice.streamingState,
      preparingTool: slice.preparingTool,
      meta: slice.meta,
      error: slice.error,
    };
  }

  function notifyKey(key: string): void {
    const set = listeners.get(key);
    if (!set) return;
    for (const cb of set) cb();
  }

  function recomputeStreamingIds(): void {
    const ids = new Set<string>();
    for (const slice of allSlices) {
      if (slice.isStreaming && slice.conversationId) ids.add(slice.conversationId);
    }
    const next = [...ids].sort();
    if (next.length !== streamingIds.length || next.some((id, i) => id !== streamingIds[i])) {
      streamingIds = next;
      for (const cb of streamingListeners) cb();
    }
  }

  function commit(slice: ConversationSlice): void {
    slice.snapshot = buildSnapshot(slice);
    for (const key of slice.keys) notifyKey(key);
    recomputeStreamingIds();
  }

  // -- slice lifecycle --

  function isActive(slice: ConversationSlice): boolean {
    for (const key of slice.keys) {
      if ((activeCounts.get(key) ?? 0) > 0) return true;
    }
    return false;
  }

  function removeSlice(slice: ConversationSlice): void {
    slice.connection?.close();
    slice.connection = null;
    for (const key of slice.keys) byKey.delete(key);
    allSlices.delete(slice);
  }

  function evict(): void {
    if (allSlices.size <= MAX_SLICES) return;
    const idle = [...allSlices]
      .filter((s) => !s.isStreaming && !isActive(s))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    let over = allSlices.size - MAX_SLICES;
    for (const s of idle) {
      if (over <= 0) break;
      removeSlice(s);
      over -= 1;
    }
  }

  function createSlice(key: string, conversationId: string | null): ConversationSlice {
    const slice: ConversationSlice = {
      keys: new Set([key]),
      conversationId,
      title: null,
      messages: [],
      isStreaming: false,
      streamingState: null,
      preparingTool: null,
      meta: null,
      error: null,
      blocks: [],
      toolCalls: [],
      iteration: undefined,
      connection: null,
      pendingEcho: false,
      cancelRequested: false,
      resumeOnSubscribe: false,
      // A fresh draft is fully "loaded" (empty IS its full history); a slice
      // keyed by a real conversation id starts unhydrated until fetched.
      hydrated: isDraftKey(key),
      lastActiveAt: Date.now(),
      snapshot: EMPTY_SNAPSHOT,
    };
    slice.snapshot = buildSnapshot(slice);
    byKey.set(key, slice);
    allSlices.add(slice);
    evict();
    return slice;
  }

  function ensureSlice(key: string, opts?: { conversationId?: string | null }): void {
    const existing = byKey.get(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return;
    }
    const convId =
      opts && "conversationId" in opts
        ? (opts.conversationId ?? null)
        : isDraftKey(key)
          ? null
          : key;
    createSlice(key, convId);
  }

  function aliasSlice(slice: ConversationSlice, conversationId: string): void {
    if (slice.keys.has(conversationId)) return;
    slice.keys.add(conversationId);
    byKey.set(conversationId, slice);
  }

  // -- streaming scratch --

  function resetScratch(slice: ConversationSlice): void {
    slice.blocks = [];
    slice.toolCalls = [];
    slice.iteration = undefined;
  }

  function assistantFromScratch(slice: ConversationSlice): ChatMessage {
    return {
      role: "assistant",
      content: textFromBlocks(slice.blocks),
      blocks: cloneBlocks(slice.blocks),
      toolCalls: [...slice.toolCalls],
      iteration: slice.iteration ? { ...slice.iteration } : undefined,
    };
  }

  function flush(slice: ConversationSlice): void {
    const updated = [...slice.messages];
    updated[updated.length - 1] = assistantFromScratch(slice);
    slice.messages = updated;
    commit(slice);
  }

  /** Drop the trailing in-flight turn (last user message + anything after). */
  function trimTrailingTurn(slice: ConversationSlice): void {
    for (let i = slice.messages.length - 1; i >= 0; i--) {
      if (slice.messages[i].role === "user") {
        slice.messages = slice.messages.slice(0, i);
        return;
      }
    }
  }

  /** True when the loaded disk tail is an unfinished turn — a trailing user
   *  message (no assistant yet) or an assistant flagged `pending` (read before
   *  its run.done). Distinguishes a partial snapshot from a finished turn. */
  function hasPendingTail(slice: ConversationSlice): boolean {
    const last = slice.messages[slice.messages.length - 1];
    if (!last) return false;
    return last.role === "user" || last.pending === true;
  }

  // -- subscription --

  function closeConnection(slice: ConversationSlice): void {
    slice.connection?.close();
    slice.connection = null;
  }

  function openConnection(slice: ConversationSlice, conversationId: string, resume: boolean): void {
    closeConnection(slice);
    slice.resumeOnSubscribe = resume;
    // When a resume finds no active turn, the server may still replay the most
    // recent (already-finished) turn from its grace buffer. Those events would
    // re-append a turn that's already in the loaded disk history → duplicate.
    // Drop them once we know this connection isn't watching a live turn.
    let dropEvents = false;
    slice.connection = connectConversationStream({
      conversationId,
      token: getAuthToken() ?? undefined,
      afterSeq: 0,
      onSubscribed: (info) => {
        if (slice.resumeOnSubscribe) {
          slice.resumeOnSubscribe = false;
          const pendingTail = hasPendingTail(slice);
          if (info.isActive || (pendingTail && info.activeSeq > 0)) {
            // A turn needs reconciling: a live one (`isActive`), or one that
            // finished in the load→subscribe window but is still in the grace
            // buffer (`pendingTail && activeSeq>0`). The replay carries the full
            // trailing turn.
            //
            // Trim the disk tail ONLY when it's `pending` — the server's
            // authoritative "this turn has no terminal event yet" flag, i.e. the
            // in-flight turn's own partial copy. The replay then rebuilds it
            // without duplicating. When the tail is NOT pending it's a COMPLETED
            // prior turn and the active turn simply isn't on disk yet (it began
            // after this snapshot); keep it and let the replay append the new
            // turn. Trimming a complete turn here silently drops it — the
            // resume-race transcript-loss bug.
            if (pendingTail) trimTrailingTurn(slice);
            resetScratch(slice);
            if (info.isActive) {
              slice.isStreaming = true;
              if (!slice.streamingState) slice.streamingState = "thinking";
            }
            commit(slice);
            return;
          }
          if (pendingTail) {
            // Partial disk tail but the run is gone (grace GC'd) — no replay can
            // complete it. Refetch the now-complete transcript.
            dropEvents = true;
            closeConnection(slice);
            void loadConversation(conversationId);
            return;
          }
          if (!slice.isStreaming) {
            // Complete disk tail (or idle) — ignore any stray grace-buffer
            // replay; it would duplicate (and flicker) a turn already fully on
            // disk.
            dropEvents = true;
            closeConnection(slice);
            return;
          }
        }
        // Server-authoritative reconcile: the server says no turn is running,
        // but we still think we're streaming. Happens when a viewer reconnects
        // after the turn ended while disconnected past the RunBus grace window
        // — the terminal frame was GC'd, so it will never replay and the spinner
        // would hang forever. Clear it. A terminal frame still within grace
        // arrives in the replay that follows and finalizes the content; if it
        // was GC'd, the slice keeps its last-seen partial (a reload fetches the
        // final) — either way we stop hanging.
        if (!info.isActive && slice.isStreaming) {
          slice.isStreaming = false;
          slice.streamingState = null;
          slice.preparingTool = null;
          commit(slice);
        }
      },
      onEvent: (type, data) => {
        if (dropEvents) return;
        applyStreamEvent(slice, type, data);
      },
      onError: () => {
        // The stream gave up unrecoverably (events route 403/404 or auth fail
        // after refresh; transient network / 5xx reconnect via backoff instead
        // and never reach here). The turn itself runs to completion
        // server-side and persists — this is a failure to WATCH it, not to run
        // it, so we must NOT drop the optimistic placeholder pair the way a
        // start-failure does (the user's message really was sent).
        //
        // Null the connection like every other terminal path. Otherwise
        // `loadConversation` / `probeConversation` see a truthy `connection`
        // and skip refetching, so reopening the conversation in-app can't
        // recover the persisted result (only a full page reload would).
        closeConnection(slice);
        // For an idle resume (no live turn) there's nothing to clean up — the
        // loaded disk history renders fine; leave it intact.
        if (!slice.isStreaming) return;
        // A fresh/active turn was being watched: without this the optimistic
        // assistant placeholder spins forever with no feed and no error.
        // Stop the spinner and stamp a recoverable error; the result is on
        // disk, so reopening / reloading the conversation surfaces it.
        slice.isStreaming = false;
        slice.streamingState = null;
        slice.preparingTool = null;
        slice.pendingEcho = false;
        const updated = [...slice.messages];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && !last.content && (last.blocks?.length ?? 0) === 0) {
          updated[updated.length - 1] = {
            ...last,
            error: "Lost the connection to this response. Reload to view it.",
          };
          slice.messages = updated;
        } else {
          slice.error = "Lost the connection to this response.";
        }
        commit(slice);
      },
    });
  }

  // -- stream reducer --

  function applyStreamEvent(slice: ConversationSlice, type: string, data: unknown): void {
    switch (type) {
      case "user.message": {
        const evt = data as { content: string; userId?: string; timestamp?: string };
        resetScratch(slice);
        if (slice.pendingEcho) {
          // Our optimistic user message + assistant placeholder are already in
          // place; the deltas will fill the placeholder.
          slice.pendingEcho = false;
        } else {
          const userMsg: ChatMessage = {
            role: "user",
            content: evt.content,
            ...(evt.timestamp ? { timestamp: evt.timestamp } : {}),
            ...(evt.userId ? { userId: evt.userId } : {}),
          };
          const assistantMsg: ChatMessage = {
            role: "assistant",
            content: "",
            blocks: [],
            toolCalls: [],
            timestamp: new Date().toISOString(),
          };
          slice.messages = [...slice.messages, userMsg, assistantMsg];
        }
        slice.isStreaming = true;
        slice.streamingState = "thinking";
        commit(slice);
        break;
      }
      case "chat.start": {
        const evt = data as { conversationId: string };
        if (evt.conversationId && slice.conversationId !== evt.conversationId) {
          slice.conversationId = evt.conversationId;
          aliasSlice(slice, evt.conversationId);
          commit(slice);
        }
        break;
      }
      case "text.delta": {
        const evt = data as TextDeltaEvent;
        slice.streamingState = "streaming";
        slice.preparingTool = null;
        const last = slice.blocks[slice.blocks.length - 1];
        if (last && last.type === "text") last.text += evt.text;
        else slice.blocks.push({ type: "text", text: evt.text });
        flush(slice);
        break;
      }
      case "reasoning.delta": {
        const evt = data as ReasoningDeltaEvent;
        slice.streamingState = "streaming";
        slice.preparingTool = null;
        const last = slice.blocks[slice.blocks.length - 1];
        if (last && last.type === "reasoning") last.text += evt.text;
        else slice.blocks.push({ type: "reasoning", text: evt.text });
        flush(slice);
        break;
      }
      case "tool.preparing": {
        const evt = data as ToolPreparingEvent;
        slice.streamingState = "preparing";
        slice.preparingTool = { id: evt.id, name: evt.name };
        commit(slice);
        break;
      }
      case "tool.preparing.done":
        break;
      case "tool.start": {
        const evt = data as ToolStartEvent;
        slice.streamingState = "working";
        slice.preparingTool = null;
        const newTool: ToolCallDisplay = {
          id: evt.id,
          name: evt.name,
          status: "running",
          resourceUri: evt.resourceUri,
          input: evt.input,
          // Bare source/app name. Parse the namespace first (#354): a naive
          // `__` split leaves the `ws_<id>-` prefix attached, which fails
          // registry.hasSource() with a 403 on the resource-read path.
          appName: appNameFromToolName(evt.name),
        };
        slice.toolCalls = [...slice.toolCalls, newTool];
        const last = slice.blocks[slice.blocks.length - 1];
        if (last && last.type === "tool") last.toolCalls = [...last.toolCalls, newTool];
        else slice.blocks.push({ type: "tool", toolCalls: [newTool] });
        flush(slice);
        break;
      }
      case "tool.done": {
        const evt = data as ToolDoneEvent;
        const updater = updateTool(evt);
        slice.toolCalls = slice.toolCalls.map(updater);
        for (const block of slice.blocks) {
          if (block.type === "tool") block.toolCalls = block.toolCalls.map(updater);
        }
        const anyRunning = slice.toolCalls.some((tc) => tc.status === "running");
        slice.streamingState = anyRunning ? "working" : "analyzing";
        flush(slice);
        break;
      }
      case "llm.done": {
        const evt = data as LlmDoneEvent;
        slice.iteration = {
          n: (slice.iteration?.n ?? 0) + 1,
          inputTokens: (slice.iteration?.inputTokens ?? 0) + (evt.usage?.inputTokens ?? 0),
          outputTokens: (slice.iteration?.outputTokens ?? 0) + (evt.usage?.outputTokens ?? 0),
        };
        flush(slice);
        break;
      }
      case "done": {
        const result = data as ChatResult;
        slice.streamingState = null;
        slice.preparingTool = null;
        slice.isStreaming = false;

        if (result.toolCalls) {
          const outputMap = new Map(result.toolCalls.map((tc) => [tc.id, tc.output]));
          const backfill = (tc: ToolCallDisplay): ToolCallDisplay => {
            if (tc.result != null) return tc;
            const output = outputMap.get(tc.id);
            return output != null ? { ...tc, result: wrapStringResult(output) } : tc;
          };
          for (const block of slice.blocks) {
            if (block.type === "tool") block.toolCalls = block.toolCalls.map(backfill);
          }
          slice.toolCalls = slice.toolCalls.map(backfill);
        }

        const finalBlocks = cloneBlocks(slice.blocks);
        const finalTools = slice.toolCalls.length > 0 ? [...slice.toolCalls] : undefined;
        const usage = result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cacheReadTokens: result.usage.cacheReadTokens,
              cacheWriteTokens: result.usage.cacheWriteTokens,
              reasoningTokens: result.usage.reasoningTokens,
              model: result.usage.model,
              llmMs: result.usage.llmMs,
            }
          : undefined;
        // Cast: `files` is attached to the done payload by the server but isn't
        // on the typed ChatResult — read it defensively.
        const resultFiles = (result as unknown as Record<string, unknown>).files as
          | MessageFileAttachment[]
          | undefined;

        const updated = [...slice.messages];
        if (updated.length > 0 && updated[updated.length - 1].role === "assistant") {
          updated[updated.length - 1] = {
            role: "assistant",
            content: result.response,
            blocks: finalBlocks,
            toolCalls: finalTools,
            usage,
            ...(result.stopReason && result.stopReason !== "complete"
              ? { stopReason: result.stopReason }
              : {}),
            ...(resultFiles && resultFiles.length > 0 ? { files: resultFiles } : {}),
          };
          slice.messages = updated;
        }
        resetScratch(slice);
        commit(slice);
        closeConnection(slice);
        break;
      }
      case "error": {
        const evt = data as StreamErrorEvent;
        slice.streamingState = null;
        slice.preparingTool = null;
        slice.isStreaming = false;
        const updated = [...slice.messages];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = { ...last, error: evt.message };
          slice.messages = updated;
        } else {
          slice.error = evt.message;
        }
        commit(slice);
        closeConnection(slice);
        break;
      }
      case "cancelled": {
        slice.streamingState = null;
        slice.preparingTool = null;
        slice.isStreaming = false;
        commit(slice);
        closeConnection(slice);
        break;
      }
    }
  }

  // -- send (start a server turn, then watch it) --

  async function sendTurn(
    key: string,
    params: StartTurnParams,
    hooks?: StartTurnHooks,
  ): Promise<void> {
    ensureSlice(key);
    const slice = byKey.get(key);
    if (!slice || slice.isStreaming) return;

    // Capture the send so retry can replay it verbatim (text + model + context).
    slice.lastSend = params;
    slice.error = null;
    slice.isStreaming = true;
    slice.streamingState = "thinking";
    slice.pendingEcho = true;
    slice.cancelRequested = false;
    // Authoring a turn means the full conversation lives in memory.
    slice.hydrated = true;
    resetScratch(slice);

    // Optimistic user message + assistant placeholder for snappy UX. The
    // streamed `user.message` echo is consumed (pendingEcho), not duplicated.
    const userFiles: MessageFileAttachment[] | undefined = params.files?.map((f) => ({
      id: `pending_${f.name}_${f.size}`,
      filename: f.name,
      mimeType: f.type || "application/octet-stream",
      size: f.size,
      extracted: false,
    }));
    const userMsg: ChatMessage = {
      role: "user",
      content: params.text,
      timestamp: new Date().toISOString(),
      ...(params.currentUserId ? { userId: params.currentUserId } : {}),
      ...(userFiles && userFiles.length > 0 ? { files: userFiles } : {}),
    };
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      blocks: [],
      toolCalls: [],
      timestamp: new Date().toISOString(),
    };
    slice.messages = [...slice.messages, userMsg, assistantMsg];
    commit(slice);

    const req: ChatRequest = {
      message: params.text,
      ...(slice.conversationId ? { conversationId: slice.conversationId } : {}),
      ...(params.appContext ? { appContext: params.appContext } : {}),
      ...(params.model ? { model: params.model } : {}),
    };

    let conversationId: string;
    try {
      const result =
        params.files && params.files.length > 0
          ? await startChatTurnMultipart(req, params.files)
          : await startChatTurn(req);
      conversationId = result.conversationId;
    } catch (err) {
      handleTurnError(slice, err);
      slice.isStreaming = false;
      slice.streamingState = null;
      slice.pendingEcho = false;
      commit(slice);
      return;
    }

    if (slice.conversationId !== conversationId) {
      slice.conversationId = conversationId;
      aliasSlice(slice, conversationId);
      hooks?.onConversationId?.(conversationId);
      commit(slice);
    }

    // Watch the turn we just started (fresh turn — not a resume).
    openConnection(slice, conversationId, false);

    // Stop was pressed before we had a conversationId — honor it now. The
    // server's `cancelled` frame arrives on the connection just opened and
    // clears the streaming state.
    if (slice.cancelRequested) {
      slice.cancelRequested = false;
      void cancelChatTurn(conversationId).catch((err) => {
        console.warn("[chat-store] deferred cancel failed", err);
      });
    }
  }

  function handleTurnError(slice: ConversationSlice, err: unknown): void {
    // Drop the optimistic user+assistant placeholders on a hard start failure.
    slice.messages = slice.messages.slice(0, -2);
    slice.error = formatSendError(err);
  }

  // -- load from disk + attach --

  async function loadConversation(id: string): Promise<void> {
    const existing = byKey.get(id);
    // Already fully loaded and live — keep the stream, don't refetch. A
    // dot-only probe (connection but not hydrated) falls through so opening
    // the conversation fetches its full history.
    if (existing?.hydrated && (existing.isStreaming || existing.connection)) {
      existing.lastActiveAt = Date.now();
      return;
    }
    ensureSlice(id, { conversationId: id });
    const slice = byKey.get(id);
    if (slice) slice.error = null;
    try {
      const res = await callTool("conversations", "get", { id, expand: "full" });
      const current = byKey.get(id);
      if (!current) return;
      if (res.isError) {
        const errText = res.content
          ?.map((b) => b.text ?? "")
          .filter(Boolean)
          .join("\n");
        throw new Error(errText || "Failed to load conversation");
      }
      let raw: unknown = res.structuredContent;
      if (!raw && res.content?.[0]?.text) {
        try {
          raw = JSON.parse(res.content[0].text);
        } catch {
          raw = {};
        }
      }
      const parsed = raw as {
        metadata: { id: string; ownerId?: string; title?: string | null };
        messages: ChatMessage[];
      };
      current.conversationId = parsed.metadata.id;
      aliasSlice(current, parsed.metadata.id);
      current.meta = { ownerId: parsed.metadata.ownerId };
      current.title = parsed.metadata.title ?? null;
      current.messages = parsed.messages ?? [];
      current.hydrated = true;
      commit(current);
      // Attach to any in-flight turn (resume — trims a stale in-flight turn
      // from the loaded history if the server says one is active).
      openConnection(current, parsed.metadata.id, true);
    } catch (err) {
      const slc = byKey.get(id);
      if (slc) {
        slc.error = err instanceof Error ? err.message : "Failed to load conversation";
        commit(slc);
      }
    }
  }

  function cancelTurn(key: string): void {
    const slice = byKey.get(key);
    if (!slice) return;
    if (!slice.conversationId) {
      // Stop pressed before `/v1/chat/start` resolved — latch it; `sendTurn`
      // fires the cancel as soon as it has the id.
      slice.cancelRequested = true;
      return;
    }
    // The server emits a terminal `cancelled` event which finalizes the slice;
    // no optimistic mutation needed. Surface a failed cancel — without this the
    // turn keeps running, Stop silently did nothing, and the rejection is lost.
    void cancelChatTurn(slice.conversationId).catch((err) => {
      console.warn("[chat-store] cancel failed", err);
    });
  }

  /**
   * Lightweight "is this conversation generating?" probe — used on reload to
   * restore background streaming dots without fetching message history. Opens
   * a resume subscription: if the server says the turn is active, the slice
   * flips to streaming (→ `getStreamingIds` → dot) and tails live; if not, the
   * connection closes and the slice stays idle. Leaves `hydrated` false so a
   * later open still loads full history.
   */
  function probeConversation(id: string): void {
    const existing = byKey.get(id);
    if (existing?.isStreaming || existing?.connection) return; // already live/probed
    ensureSlice(id, { conversationId: id });
    const slice = byKey.get(id);
    if (slice) openConnection(slice, id, true);
  }

  // -- retry / simulate --

  function retryLastMessage(key: string): void {
    const slice = byKey.get(key);
    // Replay the original send verbatim — same text, model, and appContext.
    // Re-deriving from current UI state (the old path) silently retried on the
    // workspace-default model, ignoring the user's selection.
    const params = slice?.lastSend;
    if (!slice || !params) return;
    // Drop the errored turn (trailing user message + after) so the replay
    // re-adds it cleanly.
    for (let i = slice.messages.length - 1; i >= 0; i--) {
      if (slice.messages[i].role === "user") {
        slice.messages = slice.messages.slice(0, i);
        break;
      }
    }
    slice.error = null;
    slice.isStreaming = false;
    slice.streamingState = null;
    slice.preparingTool = null;
    commit(slice);
    void sendTurn(key, params);
  }

  function simulateError(key: string, message: string): void {
    const slice = byKey.get(key);
    if (!slice || slice.messages.length === 0) return;
    const updated = [...slice.messages];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant") {
      updated[updated.length - 1] = { ...last, error: message };
    } else {
      updated.push({ role: "assistant", content: "", error: message });
    }
    slice.messages = updated;
    slice.streamingState = null;
    slice.preparingTool = null;
    slice.isStreaming = false;
    commit(slice);
  }

  function reset(): void {
    for (const slice of allSlices) slice.connection?.close();
    byKey.clear();
    allSlices.clear();
    activeCounts.clear();
    streamingIds = [];
    for (const set of listeners.values()) {
      for (const cb of set) cb();
    }
    for (const cb of streamingListeners) cb();
  }

  function closeAllConnections(): void {
    // Close sockets only — keep slices so a bfcache restore re-attaches.
    // No listener notify: the snapshot is unchanged (we're not mutating
    // isStreaming/state here; the socket close is invisible to render).
    for (const slice of allSlices) {
      slice.connection?.close();
      slice.connection = null;
    }
  }

  return {
    ensureSlice,
    getSnapshot(key) {
      return byKey.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
    },
    subscribeSlice(key, cb) {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => {
        const s = listeners.get(key);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) listeners.delete(key);
      };
    },
    getStreamingIds() {
      return streamingIds;
    },
    subscribeStreamingIds(cb) {
      streamingListeners.add(cb);
      return () => streamingListeners.delete(cb);
    },
    markActive(key) {
      activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
      const slice = byKey.get(key);
      if (slice) slice.lastActiveAt = Date.now();
    },
    markInactive(key) {
      const n = (activeCounts.get(key) ?? 0) - 1;
      if (n <= 0) activeCounts.delete(key);
      else activeCounts.set(key, n);
    },
    sendTurn,
    loadConversation,
    probeConversation,
    setTitle(conversationId, title) {
      const slice = byKey.get(conversationId);
      if (!slice || slice.title === title) return;
      slice.title = title;
      commit(slice);
    },
    cancelTurn,
    retryLastMessage,
    simulateError,
    reset,
    closeAllConnections,
    sliceCount() {
      return allSlices.size;
    },
  };
}

/** Module-singleton store. */
export const chatStore = createChatStore();
