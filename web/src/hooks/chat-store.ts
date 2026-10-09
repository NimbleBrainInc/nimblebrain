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
import { nameFromSkillId } from "../lib/skill-display.ts";
import type {
  AppContext,
  ChatRequest,
  ChatResponse,
  ConversationStreamEvents,
  LedgerSkill,
  LlmDoneEvent,
  StreamErrorEvent,
  TextDeltaEvent,
  ToolCallResponse,
  ToolDoneEvent,
  ToolPreparingEvent,
  ToolStartEvent,
  UserMessageEvent,
} from "../types";

export type { LedgerSkill } from "../types";

/**
 * A turn's skill-loading telemetry, attached to its assistant message as
 * turn-level context metadata (NOT a content block — blocks are the LLM's
 * output; this is what the runtime composed *into* the prompt). Rendered by
 * the Context Ledger as one quiet line above the turn's activity. Present only
 * when the turn loaded at least one skill.
 */
export interface SkillsLoadedContext {
  skills: LedgerSkill[];
  totalTokens: number;
}

// ===========================================================================
// Public display types (shared across the chat UI). These live here — not in
// useChat — because the slice store is the lowest layer that owns them.
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
  /** Skills the runtime composed into this turn's prompt — the Context Ledger
   *  line. Set from the live `skills.loaded` event and re-derived on reopen from
   *  the persisted turn. Absent when the turn loaded no skills. */
  skillsLoaded?: SkillsLoadedContext;
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

/** Conversation-level metadata (conversations are single-owner). */
export interface LoadedConversationMeta {
  ownerId?: string;
  /**
   * The model this conversation is bound to, from `conversations__get`. Fixed
   * at create and never changes, so the composer states it rather than
   * offering it. Absent until the conversation's metadata has arrived.
   */
  model?: string;
  /**
   * The workspace this conversation is sealed to (from the server's
   * `conversations__get` metadata). The panel uses it to avoid resuming a
   * conversation that belongs to a workspace other than the one currently
   * focused — see `ChatProvider`'s re-scope effect. Absent on legacy records
   * with no stamped workspace; absence means "workspace unknown — don't reconcile", which preserves the
   * open-in-progress race guard.
   */
  workspaceId?: string;
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
  /** Whether `retryLastMessage` can actually replay a turn. Retry needs the
   *  original send params, which only exist for a turn sent in this session —
   *  a conversation loaded from disk has none. Surfaces the store's own answer
   *  so the UI offers the affordance only when it can act, instead of showing
   *  a button that silently no-ops. */
  canRetry: boolean;
}

/** Shown on a turn whose run ended without ever persisting a terminal event. */
const ABANDONED_TAIL_NOTICE = "This response was interrupted and never finished.";

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
  canRetry: false,
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
  /** The current turn's `skills.loaded` telemetry, carried through the
   *  flush/finalize rebuilds so it survives onto the finished message. */
  skillsLoaded?: SkillsLoadedContext;
  // live subscription to the server turn stream (null when detached)
  connection: ConversationStreamConnection | null;
  /** The next streamed `user.message` echoes a turn we optimistically added —
   *  consume it instead of appending a duplicate. */
  pendingEcho: boolean;
  /** The params of the last `sendTurn` on this slice. Retry replays these
   *  verbatim rather than re-deriving them from current UI state, so a retry
   *  reproduces the original send even if the UI has moved on since. */
  lastSend?: StartTurnParams;
  /** Stop pressed before `/v1/workspaces/:wsId/chat/start` resolved (no conversationId yet).
   *  `sendTurn` fires the cancel as soon as it has the id. */
  cancelRequested: boolean;
  /** First `subscribed` frame of a resume should trim a stale in-flight turn
   *  from disk history (the replay rebuilds it). */
  resumeOnSubscribe: boolean;
  /** The open connection watches a turn this tab sent (`sendTurn`), not one it
   *  re-attached to. Only such a turn announces finished tool calls. */
  watchingOwnTurn: boolean;
  /** Tool calls already announced to `onToolDone` listeners, so a replayed
   *  `tool.done` never announces a call twice. */
  announcedToolIds: Set<string>;
  /** A resume already refetched this transcript to try to complete a partial
   *  tail. The refetch is a bet that the server has since persisted the
   *  terminal event; if the tail comes back pending anyway, the bet lost and
   *  refetching again would return the same bytes. Guards that one retry so
   *  the reconcile can't re-enter itself indefinitely. */
  resumeRefetched: boolean;
  /** True once full history is loaded (loadConversation) or the conversation
   *  was authored in this session (sendTurn / new draft). */
  hydrated: boolean;
  lastActiveAt: number;
  snapshot: ChatSnapshot;
  /** The unsent composer text and files. A draft belongs to the conversation
   *  it was written in, not to the one composer the panel mounts, so switching
   *  conversations mid-turn never carries it into another. Replaced, never
   *  mutated, so `getDraft` hands React a stable reference between edits. */
  draft: ComposerDraft;
}

/** What the composer holds before a send. */
export interface ComposerDraft {
  text: string;
  files: File[];
}

const EMPTY_DRAFT: ComposerDraft = { text: "", files: [] };

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

/** Fill in tool results the stream never resolved from the terminal `done` payload. */
function backfillToolResults(
  slice: ConversationSlice,
  resultToolCalls: ChatResponse["toolCalls"],
): void {
  const outputMap = new Map(resultToolCalls.map((tc) => [tc.id, tc.output]));
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

/** Assemble the finalized assistant message from the terminal `done` payload. */
function buildFinalAssistantMessage(
  result: ChatResponse,
  finalBlocks: ContentBlock[],
  finalTools: ToolCallDisplay[] | undefined,
  usage: ChatMessage["usage"],
  skillsLoaded: SkillsLoadedContext | undefined,
): ChatMessage {
  return {
    role: "assistant",
    content: result.response,
    blocks: finalBlocks,
    toolCalls: finalTools,
    usage,
    ...(skillsLoaded ? { skillsLoaded } : {}),
    ...(result.stopReason && result.stopReason !== "complete"
      ? { stopReason: result.stopReason }
      : {}),
  };
}

/** Flip a slice to streaming when a resume finds a live turn. */
function markActiveStreaming(slice: ConversationSlice): void {
  slice.isStreaming = true;
  if (!slice.streamingState) slice.streamingState = "thinking";
}

/** Map picked File objects to optimistic pending-attachment metadata. */
function buildUserFiles(files: File[] | undefined): MessageFileAttachment[] | undefined {
  return files?.map((f) => ({
    id: `pending_${f.name}_${f.size}`,
    filename: f.name,
    mimeType: f.type || "application/octet-stream",
    size: f.size,
    extracted: false,
  }));
}

/** Build the optimistic user message shown immediately on send. */
function buildOptimisticUserMessage(
  params: StartTurnParams,
  userFiles: MessageFileAttachment[] | undefined,
): ChatMessage {
  return {
    role: "user",
    content: params.text,
    timestamp: new Date().toISOString(),
    // `userId` is the per-message author id, round-tripped end to end. It
    // has no UI consumer (single-owner → userId is always the current user),
    // but it is not dead code. Keep it.
    ...(params.currentUserId ? { userId: params.currentUserId } : {}),
    ...(userFiles && userFiles.length > 0 ? { files: userFiles } : {}),
  };
}

/** Build the `/v1/workspaces/:wsId/chat/start` request body from the slice + send params. */
function buildChatRequest(slice: ConversationSlice, params: StartTurnParams): ChatRequest {
  return {
    message: params.text,
    ...(slice.conversationId ? { conversationId: slice.conversationId } : {}),
    ...(params.appContext ? { appContext: params.appContext } : {}),
    ...(params.model ? { model: params.model } : {}),
  };
}

/** A loaded conversation: server metadata plus its reconstructed messages. */
interface LoadedConversation {
  metadata: {
    id: string;
    ownerId?: string;
    workspaceId?: string;
    title?: string | null;
    model?: string;
  };
  messages: ChatMessage[];
}

/**
 * Parse a `conversations.get` tool result into conversation metadata + messages.
 * Throws on an error result; falls back to parsing `content[0].text` as JSON
 * when the server returned no `structuredContent`.
 */
function parseConversationResult(res: ToolCallResponse): LoadedConversation {
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
  return raw as LoadedConversation;
}

/** Outcome of reconciling the first `subscribed` frame of a resume. */
type ResumeOutcome = "handled" | "drop" | "fallthrough";

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

/** A tool call that finished in a turn this tab sent, as `onToolDone` reports it. */
export interface FinishedToolCall {
  id: string;
  /** The tool's wire name, e.g. `nb__open_app`. */
  name: string;
  ok: boolean;
  /** The arguments the agent called it with. */
  input: Record<string, unknown>;
}

export interface ChatStore {
  ensureSlice(key: string, opts?: { conversationId?: string | null }): void;
  getSnapshot(key: string): ChatSnapshot;
  subscribeSlice(key: string, cb: () => void): () => void;
  /** The composer draft for a conversation (empty when it has none). On its
   *  own channel, apart from `subscribeSlice`, so a keystroke notifies the
   *  composer and not every transcript subscriber. */
  getDraft(key: string): ComposerDraft;
  subscribeDraft(key: string, cb: () => void): () => void;
  /** Merge a patch into a conversation's draft, creating its slice if needed. */
  setDraft(key: string, patch: Partial<ComposerDraft>): void;
  markActive(key: string): void;
  markInactive(key: string): void;
  /** Send a message: start a server turn, then watch its stream. */
  sendTurn(key: string, params: StartTurnParams, hooks?: StartTurnHooks): Promise<void>;
  /** Load persisted history and attach to any in-flight turn. */
  loadConversation(id: string): Promise<void>;
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
  /** Re-open a resume stream for every slice still flagged streaming but with
   *  no live connection — the bfcache-restore counterpart to
   *  {@link closeAllConnections}. */
  reattachStreaming(): void;
  sliceCount(): number;
  /**
   * Hear each tool call that finishes in a turn this tab sent and is watching
   * live: never one from history, a resumed stream, or another tab. For host
   * UI driven by the agent (`nb__open_app`). Returns the unsubscribe.
   */
  onToolDone(listener: (call: FinishedToolCall) => void): () => void;
}

export function createChatStore(): ChatStore {
  const byKey = new Map<string, ConversationSlice>();
  const allSlices = new Set<ConversationSlice>();
  const listeners = new Map<string, Set<() => void>>();
  const draftListeners = new Map<string, Set<() => void>>();
  const activeCounts = new Map<string, number>();
  const toolDoneListeners = new Set<(call: FinishedToolCall) => void>();

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
      canRetry: slice.lastSend !== undefined,
    };
  }

  function notifyKey(key: string): void {
    const set = listeners.get(key);
    if (!set) return;
    for (const cb of set) cb();
  }

  function notifyDraft(slice: ConversationSlice): void {
    for (const key of slice.keys) {
      const set = draftListeners.get(key);
      if (!set) continue;
      for (const cb of set) cb();
    }
  }

  function hasDraft(slice: ConversationSlice): boolean {
    return slice.draft.text.length > 0 || slice.draft.files.length > 0;
  }

  function setDraft(key: string, patch: Partial<ComposerDraft>): void {
    ensureSlice(key);
    const slice = byKey.get(key);
    if (!slice) return;
    const next = { ...slice.draft, ...patch };
    slice.draft = next.text.length === 0 && next.files.length === 0 ? EMPTY_DRAFT : next;
    notifyDraft(slice);
  }

  function commit(slice: ConversationSlice): void {
    slice.snapshot = buildSnapshot(slice);
    for (const key of slice.keys) notifyKey(key);
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
      // A draft is the user's words, not a cache entry, so a conversation holding
      // one is kept. Only slices with a conversation id qualify, the ones Recent
      // can reopen: an unsent chat is reached through the panel's New chat, which
      // the store cannot see, and exempting it would pin text nothing may reach.
      .filter((s) => !s.isStreaming && !isActive(s) && !(s.conversationId !== null && hasDraft(s)))
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
      watchingOwnTurn: false,
      announcedToolIds: new Set(),
      resumeRefetched: false,
      // A fresh draft is fully "loaded" (empty IS its full history); a slice
      // keyed by a real conversation id starts unhydrated until fetched.
      hydrated: isDraftKey(key),
      lastActiveAt: Date.now(),
      snapshot: EMPTY_SNAPSHOT,
      draft: EMPTY_DRAFT,
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
    slice.skillsLoaded = undefined;
  }

  function assistantFromScratch(slice: ConversationSlice): ChatMessage {
    return {
      role: "assistant",
      content: textFromBlocks(slice.blocks),
      blocks: cloneBlocks(slice.blocks),
      toolCalls: [...slice.toolCalls],
      iteration: slice.iteration ? { ...slice.iteration } : undefined,
      ...(slice.skillsLoaded ? { skillsLoaded: slice.skillsLoaded } : {}),
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

  /**
   * Recover a partial tail whose run is gone (no live turn, nothing in the
   * grace buffer), so no replay can ever complete it.
   *
   * Refetch ONCE, on the bet that the terminal event was persisted between our
   * snapshot and now. If the refetch already ran and the tail came back pending
   * anyway, the bet lost: the turn was abandoned without a terminal event, so
   * re-reading the same transcript cannot produce a different answer. Retrying
   * there is futile rather than merely slow, and unguarded it re-enters itself
   * (refetch → resume → reconcile → refetch) for as long as the conversation
   * stays open.
   */
  function recoverAbandonedTail(slice: ConversationSlice, conversationId: string): ResumeOutcome {
    closeConnection(slice);
    // The server just reported no run at all, so a slice still flagged
    // streaming — pinned by an earlier connection that did catch a live turn — is
    // holding a stale belief. Clear it here rather than only in
    // `settleAbandonedTail`, because `loadConversation` early-returns for a
    // hydrated slice it thinks is live: the refetch below would silently no-op
    // while the allowance was spent, stranding a spinner with no connection.
    // Same fact, same response as the server-authoritative check in
    // `openConnection`'s `onSubscribed`.
    slice.isStreaming = false;
    slice.streamingState = null;
    slice.preparingTool = null;
    if (!slice.resumeRefetched) {
      slice.resumeRefetched = true;
      void loadConversation(conversationId);
      return "drop";
    }
    settleAbandonedTail(slice);
    return "drop";
  }

  /**
   * Settle a resume whose partial tail outlived its run. The refetch already
   * ran and the tail came back pending, so the turn was abandoned without ever
   * persisting a terminal event — nothing further will arrive from disk or from
   * a replay. Stop presenting it as in-flight and keep whatever partial content
   * exists, so the conversation renders instead of spinning.
   */
  function settleAbandonedTail(slice: ConversationSlice): void {
    slice.isStreaming = false;
    slice.streamingState = null;
    slice.preparingTool = null;
    slice.pendingEcho = false;
    const updated = [...slice.messages];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant") {
      // Partial assistant content: keep it, but stop rendering it as still
      // arriving and say why it stops mid-thought.
      updated[updated.length - 1] = { ...last, pending: false, error: ABANDONED_TAIL_NOTICE };
    } else {
      // No assistant content at all. Carry the notice on an empty assistant
      // message rather than `slice.error`, which renders as a banner pinned to
      // the top of the panel — detached from the turn it explains, and cleared
      // by the next send or load, so a follow-up would erase the only account
      // of why the previous message was never answered. Same shape
      // `simulateError` uses for the equivalent case.
      updated.push({ role: "assistant", content: "", error: ABANDONED_TAIL_NOTICE });
    }
    slice.messages = updated;
    commit(slice);
  }

  /**
   * Reconcile the first `subscribed` frame of a resume against the loaded disk
   * tail. Returns:
   *   - "handled": a live/grace turn was reconciled (state committed) — the
   *     replay that follows finalizes it.
   *   - "drop": the run is gone or the tail is already complete — the caller
   *     should ignore all further replay events for this connection.
   *   - "fallthrough": no resume reconcile applied; run the server-authoritative
   *     spinner check.
   */
  function reconcileResume(
    slice: ConversationSlice,
    info: { isActive: boolean; activeSeq: number },
    conversationId: string,
  ): ResumeOutcome {
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
      if (info.isActive) markActiveStreaming(slice);
      slice.resumeRefetched = false;
      commit(slice);
      return "handled";
    }
    if (pendingTail) return recoverAbandonedTail(slice, conversationId);
    if (!slice.isStreaming) {
      // Complete disk tail (or idle) — ignore any stray grace-buffer replay;
      // it would duplicate (and flicker) a turn already fully on disk.
      closeConnection(slice);
      return "drop";
    }
    return "fallthrough";
  }

  function openConnection(slice: ConversationSlice, conversationId: string, resume: boolean): void {
    closeConnection(slice);
    slice.resumeOnSubscribe = resume;
    slice.watchingOwnTurn = !resume;
    // A fresh turn is a new bet: whatever stranded the previous tail says
    // nothing about this one, so the one-refetch allowance resets with it.
    if (!resume) slice.resumeRefetched = false;
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
          const outcome = reconcileResume(slice, info, conversationId);
          if (outcome === "drop") {
            dropEvents = true;
            return;
          }
          if (outcome === "handled") return;
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
        // `loadConversation` sees a truthy `connection`
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

  function handleUserMessage(slice: ConversationSlice, data: unknown): void {
    const evt = data as UserMessageEvent;
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
  }

  function handleChatStart(slice: ConversationSlice, data: unknown): void {
    const evt = data as ConversationStreamEvents["chat.start"];
    // The binding arrives with the id because a just-created conversation is
    // never loaded, so `loadConversation` would never supply it — and the
    // composer has to state the model the server pinned, not the one asked for.
    const learnedModel = slice.meta?.model !== evt.model;
    if (learnedModel) slice.meta = { ...slice.meta, model: evt.model };
    if (evt.conversationId && slice.conversationId !== evt.conversationId) {
      slice.conversationId = evt.conversationId;
      aliasSlice(slice, evt.conversationId);
      commit(slice);
    } else if (learnedModel) {
      commit(slice);
    }
  }

  function handleTextDelta(slice: ConversationSlice, data: unknown): void {
    const evt = data as TextDeltaEvent;
    slice.streamingState = "streaming";
    slice.preparingTool = null;
    const last = slice.blocks[slice.blocks.length - 1];
    if (last && last.type === "text") last.text += evt.text;
    else slice.blocks.push({ type: "text", text: evt.text });
    flush(slice);
  }

  /**
   * One untrusted stream entry → a ledger row, every field defaulted.
   *
   * The `name` fallback is a malformed-frame guard: the runtime stamps `name`
   * on every entry it emits. It derives rather than printing the id, because
   * every connector skill's id ends in `/SKILL.md` — the guard firing must not
   * put that back on screen.
   */
  function toLedgerSkill(s: Record<string, unknown>): LedgerSkill {
    return {
      id: s.id as string,
      name: typeof s.name === "string" && s.name ? s.name : nameFromSkillId(s.id as string),
      ...(typeof s.connector === "string" && s.connector ? { connector: s.connector } : {}),
      scope: (typeof s.scope === "string" ? s.scope : "org") as LedgerSkill["scope"],
      tokens: typeof s.tokens === "number" ? s.tokens : 0,
      loadedBy: (typeof s.loadedBy === "string"
        ? s.loadedBy
        : "tool_affinity") as LedgerSkill["loadedBy"],
      reason: typeof s.reason === "string" ? s.reason : "",
    };
  }

  function handleSkillsLoaded(slice: ConversationSlice, data: unknown): void {
    // The stream frame is untrusted `unknown`; normalize each entry the same way
    // the reopen path does (`projectSkillsLoaded` in the conversations app) so
    // live and replay produce byte-identical ledger rows and a malformed field
    // can't render `ledger-scope--undefined`. Zero well-formed entries → leave
    // `skillsLoaded` unset so the line is suppressed (absence is the signal).
    const evt = data as { skills?: unknown; totalTokens?: unknown };
    const rawEntries = Array.isArray(evt.skills) ? (evt.skills as Record<string, unknown>[]) : [];
    const skills: LedgerSkill[] = rawEntries
      .filter((s) => !!s && typeof s.id === "string")
      .map(toLedgerSkill);
    if (skills.length === 0) return;
    const totalTokens =
      typeof evt.totalTokens === "number"
        ? evt.totalTokens
        : skills.reduce((sum, s) => sum + s.tokens, 0);
    // One payload per turn; last write wins (a resume replays it, matching live).
    slice.skillsLoaded = { skills, totalTokens };
    // Surface it on the in-flight assistant message right away — selection
    // happens at compose time, before any block streams, so the line should
    // appear immediately (even on a turn that produces no text). `flush`
    // rebuilds the trailing assistant message from scratch, which now carries
    // `skillsLoaded`.
    const last = slice.messages[slice.messages.length - 1];
    if (last?.role === "assistant") flush(slice);
    else commit(slice);
  }

  function handleReasoningDelta(slice: ConversationSlice, data: unknown): void {
    const evt = data as TextDeltaEvent;
    // A reasoning block's cryptographic signature arrives as a delta carrying
    // no text. Taking it as "streaming" hides the live cursor behind a block
    // that renders nothing, leaving the turn with no indicator at all.
    if (evt.text === "") return;
    slice.streamingState = "streaming";
    slice.preparingTool = null;
    const last = slice.blocks[slice.blocks.length - 1];
    if (last && last.type === "reasoning") last.text += evt.text;
    else slice.blocks.push({ type: "reasoning", text: evt.text });
    flush(slice);
  }

  function handleToolPreparing(slice: ConversationSlice, data: unknown): void {
    const evt = data as ToolPreparingEvent;
    slice.streamingState = "preparing";
    slice.preparingTool = { id: evt.id, name: evt.name };
    commit(slice);
  }

  function handleToolStart(slice: ConversationSlice, data: unknown): void {
    const evt = data as ToolStartEvent;
    slice.streamingState = "working";
    slice.preparingTool = null;
    const newTool: ToolCallDisplay = {
      id: evt.id,
      name: evt.name,
      status: "running",
      resourceUri: evt.resourceUri,
      input: evt.input,
      appName: appNameFromToolName(evt.name),
    };
    slice.toolCalls = [...slice.toolCalls, newTool];
    const last = slice.blocks[slice.blocks.length - 1];
    if (last && last.type === "tool") last.toolCalls = [...last.toolCalls, newTool];
    else slice.blocks.push({ type: "tool", toolCalls: [newTool] });
    flush(slice);
  }

  function handleToolDone(slice: ConversationSlice, data: unknown): void {
    const evt = data as ToolDoneEvent;
    const updater = updateTool(evt);
    slice.toolCalls = slice.toolCalls.map(updater);
    for (const block of slice.blocks) {
      if (block.type === "tool") block.toolCalls = block.toolCalls.map(updater);
    }
    const anyRunning = slice.toolCalls.some((tc) => tc.status === "running");
    slice.streamingState = anyRunning ? "working" : "analyzing";
    flush(slice);
    announceToolDone(slice, evt);
  }

  // A finished tool call reaches `onToolDone` listeners only from a turn this
  // tab sent and is watching live, and only once. A conversation loaded from
  // history never runs these reducers; one re-attached after a reload or from
  // another tab is a resume, and a replayed frame repeats an announced id. A
  // turn left streaming in the background, after the person moved to another
  // conversation or workspace, is not being watched: its slice is no longer
  // active. The panel's open state does not enter into it, since the chat
  // stays active while the panel is closed.
  function announceToolDone(slice: ConversationSlice, evt: ToolDoneEvent): void {
    if (!slice.watchingOwnTurn || !isActive(slice) || slice.announcedToolIds.has(evt.id)) return;
    slice.announcedToolIds.add(evt.id);
    const tool = slice.toolCalls.find((tc) => tc.id === evt.id);
    const done: FinishedToolCall = {
      id: evt.id,
      name: evt.name,
      ok: evt.ok,
      input: tool?.input ?? {},
    };
    for (const listener of toolDoneListeners) listener(done);
  }

  function handleLlmDone(slice: ConversationSlice, data: unknown): void {
    const evt = data as LlmDoneEvent;
    slice.iteration = {
      n: (slice.iteration?.n ?? 0) + 1,
      inputTokens: (slice.iteration?.inputTokens ?? 0) + (evt.usage?.inputTokens ?? 0),
      outputTokens: (slice.iteration?.outputTokens ?? 0) + (evt.usage?.outputTokens ?? 0),
    };
    flush(slice);
  }

  function handleDone(slice: ConversationSlice, data: unknown): void {
    const result = data as ChatResponse;
    slice.streamingState = null;
    slice.preparingTool = null;
    slice.isStreaming = false;

    if (result.toolCalls) {
      backfillToolResults(slice, result.toolCalls);
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

    const updated = [...slice.messages];
    if (updated.length > 0 && updated[updated.length - 1].role === "assistant") {
      updated[updated.length - 1] = buildFinalAssistantMessage(
        result,
        finalBlocks,
        finalTools,
        usage,
        slice.skillsLoaded,
      );
      slice.messages = updated;
    }
    resetScratch(slice);
    commit(slice);
    closeConnection(slice);
  }

  function handleError(slice: ConversationSlice, data: unknown): void {
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
  }

  function handleCancelled(slice: ConversationSlice): void {
    slice.streamingState = null;
    slice.preparingTool = null;
    slice.isStreaming = false;
    commit(slice);
    closeConnection(slice);
  }

  // Per-type reducers, keyed by the stream's catalog. Unlisted types
  // (`subscribed`, `heartbeat`) are intentional no-ops.
  const STREAM_EVENT_HANDLERS: Partial<
    Record<keyof ConversationStreamEvents, (slice: ConversationSlice, data: unknown) => void>
  > = {
    "user.message": handleUserMessage,
    "chat.start": handleChatStart,
    "skills.loaded": handleSkillsLoaded,
    "text.delta": handleTextDelta,
    "reasoning.delta": handleReasoningDelta,
    "tool.preparing": handleToolPreparing,
    "tool.start": handleToolStart,
    "tool.done": handleToolDone,
    "llm.done": handleLlmDone,
    done: handleDone,
    error: handleError,
    cancelled: handleCancelled,
  };

  function applyStreamEvent(slice: ConversationSlice, type: string, data: unknown): void {
    // Own-key guard so an inherited name (constructor/toString/__proto__) can't
    // resolve to an Object.prototype member; unknown types no-op as the switch did.
    if (Object.hasOwn(STREAM_EVENT_HANDLERS, type)) {
      STREAM_EVENT_HANDLERS[type as keyof ConversationStreamEvents]?.(slice, data);
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

    // Accepting the send is what consumes the draft, so a send refused above
    // (a turn is already running) leaves every word of it in place. Only the
    // text that went out is cleared: the caller may await between Enter and
    // here, and a draft edited in that gap is the next message, not this one.
    if (slice.draft.text.trim() === params.text.trim()) {
      slice.draft = EMPTY_DRAFT;
      notifyDraft(slice);
    }

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
    const userFiles = buildUserFiles(params.files);
    const userMsg = buildOptimisticUserMessage(params, userFiles);
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      blocks: [],
      toolCalls: [],
      timestamp: new Date().toISOString(),
    };
    slice.messages = [...slice.messages, userMsg, assistantMsg];
    commit(slice);

    const req = buildChatRequest(slice, params);

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

  /** Stamp a load failure onto the slice (if it still exists) and notify. */
  function handleLoadError(id: string, err: unknown): void {
    const slc = byKey.get(id);
    if (slc) {
      slc.error = err instanceof Error ? err.message : "Failed to load conversation";
      commit(slc);
    }
  }

  async function loadConversation(id: string): Promise<void> {
    const existing = byKey.get(id);
    // Already fully loaded and live — keep the stream, don't refetch. An
    // unhydrated slice falls through so opening the conversation fetches its
    // full history.
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
      const parsed = parseConversationResult(res);
      current.conversationId = parsed.metadata.id;
      aliasSlice(current, parsed.metadata.id);
      current.meta = {
        ownerId: parsed.metadata.ownerId,
        workspaceId: parsed.metadata.workspaceId,
        model: parsed.metadata.model,
      };
      current.title = parsed.metadata.title ?? null;
      current.messages = parsed.messages ?? [];
      current.hydrated = true;
      commit(current);
      // Attach to any in-flight turn (resume — trims a stale in-flight turn
      // from the loaded history if the server says one is active).
      openConnection(current, parsed.metadata.id, true);
    } catch (err) {
      handleLoadError(id, err);
    }
  }

  function cancelTurn(key: string): void {
    const slice = byKey.get(key);
    if (!slice) return;
    if (!slice.conversationId) {
      // Stop pressed before `/v1/workspaces/:wsId/chat/start` resolved — latch it; `sendTurn`
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

  // -- retry / simulate --

  function retryLastMessage(key: string): void {
    const slice = byKey.get(key);
    // Replay the original send verbatim rather than re-deriving it from
    // current UI state, which would retry a different turn than the one that
    // failed.
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
    for (const set of listeners.values()) {
      for (const cb of set) cb();
    }
    for (const set of draftListeners.values()) {
      for (const cb of set) cb();
    }
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

  function reattachStreaming(): void {
    // bfcache restore: closeAllConnections nulled the sockets but left
    // isStreaming pinned true. Re-open a resume stream for each so the turn
    // re-tails (or, if it ended while we were away, the server-authoritative
    // reconcile in onSubscribed clears the stuck spinner).
    for (const slice of allSlices) {
      if (slice.isStreaming && slice.conversationId && !slice.connection) {
        // The trailing turn IS this slice's in-flight turn (it's streaming it),
        // built live so it carries no disk `pending` flag — the resume reconcile
        // can't recognize it. The replay (afterSeq:0) re-sends the whole turn
        // from seq 1, including the user.message echo. Mark pendingEcho so that
        // echo is consumed and the assistant rebuilt from the replay, exactly
        // like a fresh send — NOT appended as a duplicate user+assistant pair.
        slice.pendingEcho = true;
        openConnection(slice, slice.conversationId, true);
      }
    }
  }

  return {
    ensureSlice,
    onToolDone(listener) {
      toolDoneListeners.add(listener);
      return () => {
        toolDoneListeners.delete(listener);
      };
    },
    getSnapshot(key) {
      return byKey.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
    },
    getDraft(key) {
      return byKey.get(key)?.draft ?? EMPTY_DRAFT;
    },
    subscribeDraft(key, cb) {
      let set = draftListeners.get(key);
      if (!set) {
        set = new Set();
        draftListeners.set(key, set);
      }
      set.add(cb);
      return () => {
        const s = draftListeners.get(key);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) draftListeners.delete(key);
      };
    },
    setDraft,
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
    reattachStreaming,
    sliceCount() {
      return allSlices.size;
    },
  };
}

/** Module-singleton store. */
export const chatStore = createChatStore();
