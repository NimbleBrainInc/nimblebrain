/**
 * Event-sourced conversation store.
 *
 * Single JSONL file per conversation with events as lines 2+.
 * Implements both ConversationStore (CRUD) and EventSink (engine event persistence).
 * Cost, totals, and breakdowns are derived at read time.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceLinkInfo } from "../engine/content-helpers.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { ConversationCorruptedError } from "../runtime/errors.ts";
import { assertNoBinaryPayloads } from "./binary-guard.ts";
import {
  deriveConversationMeta,
  deriveUsageMetrics,
  reconstructMessages,
} from "./event-reconstructor.ts";
import { ConversationIndex, canAccess } from "./index-cache.ts";
import {
  type ConnectorSkillInjectedEvent,
  type ContextAssembledEvent,
  type ContextAssembledSource,
  type Conversation,
  type ConversationAccessContext,
  type ConversationEvent,
  type ConversationListResult,
  type ConversationPatch,
  type ConversationStore,
  type CreateConversationOptions,
  type ListOptions,
  type LlmResponseEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunStartEvent,
  type SkillsLoadedEntry,
  type SkillsLoadedEvent,
  type StoredMessage,
  type ToolDoneEvent,
  type ToolStartEvent,
  validateConversationId,
} from "./types.ts";

/** Parse an array of JSON lines, silently skipping malformed entries. */
function safeParseLines<T>(lines: string[]): T[] {
  const results: T[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed line — partial writes, truncation, or corruption
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

/** Conversation events that are persisted (non-workspace, non-ephemeral). */
const CONVERSATION_EVENT_TYPES = new Set([
  "run.start",
  "llm.done",
  "tool.start",
  "tool.done",
  "tool.progress",
  "run.done",
  "run.error",
  "skills.loaded",
  "context.assembled",
  "connector.skill.injected",
]);

// ---------------------------------------------------------------------------
// Conversation header + derived-metadata helpers
// ---------------------------------------------------------------------------

/** Build the base Conversation from a parsed line-0 header record (ownerId already validated). */
function parseConversationHeader(raw: Record<string, unknown>): Conversation {
  return {
    id: raw.id as string,
    createdAt: raw.createdAt as string,
    updatedAt: (raw.updatedAt as string) ?? (raw.createdAt as string),
    title: (raw.title as string | null) ?? null,
    lastModel: (raw.lastModel as string | null) ?? null,
    ownerId: raw.ownerId as string,
    ...(raw.format ? { format: raw.format as "events" } : {}),
    ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
    ...(raw.visibility ? { visibility: raw.visibility as "private" | "shared" } : {}),
    ...(raw.metadata ? { metadata: raw.metadata as Record<string, unknown> } : {}),
  };
}

/** Overlay event-derived metadata (model, title, updatedAt) onto a conversation header. */
function applyDerivedMeta(conversation: Conversation, lines: string[]): void {
  const events = safeParseLines<ConversationEvent>(lines.slice(1));
  const usage = deriveUsageMetrics(events);
  if (usage.lastModel) {
    conversation.lastModel = usage.lastModel;
  }
  const meta = deriveConversationMeta(events, { title: conversation.title });
  conversation.title = meta.title;
  // Derive updatedAt from last event timestamp
  const lastEvent = events[events.length - 1];
  if (lastEvent) {
    conversation.updatedAt = lastEvent.ts;
  }
}

// ---------------------------------------------------------------------------
// Fork message → event-line conversion
// ---------------------------------------------------------------------------

/** Model of the last assistant message that carries one, else undefined. */
function forkLastModel(messages: StoredMessage[]): string | undefined {
  let model: string | undefined;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.metadata?.model) {
      model = msg.metadata.model;
    }
  }
  return model;
}

/** Serialize a forked user message as a `user.message` event line. */
function forkUserEventLine(msg: StoredMessage): string {
  return JSON.stringify({
    ts: msg.timestamp,
    type: "user.message",
    content: msg.content,
    ...(msg.userId ? { userId: msg.userId } : {}),
  });
}

/**
 * Serialize a forked assistant turn as run.start/llm.response/run.done event
 * lines. Each assistant turn must be wrapped in a synthetic run span — without
 * it, reconstructMessages drops the turn (assistant messages are only emitted
 * inside an active run scope).
 */
function forkAssistantEventLines(msg: StoredMessage, runId: string): string[] {
  const model = msg.metadata?.model ?? "unknown";
  return [
    JSON.stringify({ ts: msg.timestamp, type: "run.start", runId, model }),
    JSON.stringify({
      ts: msg.timestamp,
      type: "llm.response",
      runId,
      model,
      content: msg.content,
      usage: msg.metadata?.usage ?? { inputTokens: 0, outputTokens: 0 },
      llmMs: msg.metadata?.llmMs ?? 0,
    }),
    JSON.stringify({
      ts: msg.timestamp,
      type: "run.done",
      runId,
      stopReason: "complete",
      totalMs: msg.metadata?.llmMs ?? 0,
    }),
  ];
}

/** Convert forked messages into event-format JSONL lines. */
function messagesToForkEventLines(messages: StoredMessage[]): string[] {
  const eventLines: string[] = [];
  let runCounter = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      eventLines.push(forkUserEventLine(msg));
    } else if (msg.role === "assistant") {
      eventLines.push(...forkAssistantEventLines(msg, `forked-${runCounter++}`));
    }
  }
  return eventLines;
}

// ---------------------------------------------------------------------------
// Engine event → conversation event mappers
// ---------------------------------------------------------------------------

/** Shared inputs for every engine→conversation event mapper. */
interface EngineEventContext {
  ts: string;
  d: Record<string, unknown>;
  runId: string;
  debug: boolean;
}

/** Map an engine `run.start` to a persisted `run.start` event. */
function mapRunStart({ ts, d, runId, debug }: EngineEventContext): RunStartEvent {
  return {
    ts,
    type: "run.start",
    runId,
    model: d.model as string,
    ...(debug && d.systemPrompt ? { systemPrompt: d.systemPrompt as string } : {}),
    ...(debug && d.messageRoles ? { messages: d.messageRoles as unknown[] } : {}),
    ...(debug && d.toolNames ? { toolSchemas: d.toolNames as string[] } : {}),
  };
}

/** Map an engine `tool.start` to a persisted `tool.start` event. */
function mapToolStart({ ts, d, runId, debug }: EngineEventContext): ToolStartEvent {
  return {
    ts,
    type: "tool.start",
    runId,
    name: d.name as string,
    id: d.id as string,
    ...(debug && d.input !== undefined ? { input: d.input } : {}),
  };
}

/** Map an engine `tool.done` to a persisted `tool.done` event. */
function mapToolDone({ ts, d, runId }: EngineEventContext): ToolDoneEvent {
  // Always persist the text output for conversation history reconstruction.
  // The engine now sends `output` (extracted text) alongside `result` (full structured).
  const output = typeof d.output === "string" ? d.output : undefined;
  // Bounded model-view text, present only when the result exceeded the
  // model-context bound. Replay uses it verbatim so the replayed prompt
  // matches what the model saw live. See boundToolResultForModel.
  const modelOutput = typeof d.modelOutput === "string" ? d.modelOutput : undefined;
  // UI-binding resource references. The engine emits these on the live
  // tool.done; persist them so a reopened conversation rehydrates its
  // artifact viewers (the panel a tool's `artifact://` resource link renders into).
  // They are small references, not bytes — the body is fetched on view.
  const resourceUri = typeof d.resourceUri === "string" ? d.resourceUri : undefined;
  const resourceLinks =
    Array.isArray(d.resourceLinks) && d.resourceLinks.length > 0
      ? (d.resourceLinks as ResourceLinkInfo[])
      : undefined;
  return {
    ts,
    type: "tool.done",
    runId,
    name: d.name as string,
    id: d.id as string,
    ok: (d.ok as boolean) ?? true,
    ms: (d.ms as number) ?? 0,
    ...(output !== undefined ? { output } : {}),
    ...(modelOutput !== undefined ? { modelOutput } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(resourceLinks !== undefined ? { resourceLinks } : {}),
  };
}

/** Map an engine `tool.progress` to a persisted `tool.progress` event. */
function mapToolProgress({ ts, d, runId }: EngineEventContext): ConversationEvent {
  return {
    ts,
    type: "tool.progress",
    runId,
    id: d.id as string,
    message: (d.message as string) ?? "",
  };
}

/** Map an engine `run.done` to a persisted `run.done` event. */
function mapRunDone({ ts, d, runId }: EngineEventContext): RunDoneEvent {
  // Pass the engine's stopReason through verbatim. Defaulting to
  // "complete" here used to mask length-truncation and other
  // model-driven exits — the engine now derives the real reason
  // from the final LLM call's finishReason. If d.stopReason is
  // somehow missing, persist "other" so it's clear we don't know.
  return {
    ts,
    type: "run.done",
    runId,
    stopReason: (d.stopReason as string) ?? "other",
    totalMs: (d.totalMs as number) ?? 0,
  };
}

/** Map an engine `run.error` to a persisted `run.error` event. */
function mapRunError({ ts, d, runId }: EngineEventContext): RunErrorEvent {
  return {
    ts,
    type: "run.error",
    runId,
    error: (d.error as string) ?? "Unknown error",
    errorType: (d.type as string) ?? "Error",
  };
}

/** Map an engine `skills.loaded` to a persisted `skills.loaded` event. */
function mapSkillsLoaded({ ts, d, runId }: EngineEventContext): SkillsLoadedEvent {
  // Trust boundary: persisted JSON → typed projection. The cast assumes
  // every emitter populates the full `SkillsLoadedEntry` shape (the
  // platform's only emitter, `buildSkillsLoadedPayload`, does). Tools
  // that depend on per-field guarantees on read should validate at
  // their consumption point rather than assume the cast is sound for
  // arbitrary on-disk data — the broader event-shape validation is its
  // own audit, not in scope here.
  const skills = Array.isArray(d.skills)
    ? (d.skills as SkillsLoadedEntry[])
    : ([] as SkillsLoadedEntry[]);
  return {
    ts,
    type: "skills.loaded",
    runId,
    skills,
    totalTokens: (d.totalTokens as number) ?? 0,
  };
}

/** Map an engine `context.assembled` to a persisted `context.assembled` event. */
function mapContextAssembled({ ts, d, runId }: EngineEventContext): ContextAssembledEvent {
  const sources = Array.isArray(d.sources)
    ? (d.sources as ContextAssembledSource[])
    : ([] as ContextAssembledSource[]);
  const excluded = Array.isArray(d.excluded)
    ? (d.excluded as ContextAssembledSource[])
    : ([] as ContextAssembledSource[]);
  return {
    ts,
    type: "context.assembled",
    runId,
    sources,
    excluded,
    totalTokens: (d.totalTokens as number) ?? 0,
    ...(typeof d.modelMaxContext === "number" ? { modelMaxContext: d.modelMaxContext } : {}),
    ...(typeof d.headroomTokens === "number" ? { headroomTokens: d.headroomTokens } : {}),
  };
}

/** Map an engine `connector.skill.injected` to a persisted event, or null when the body is empty. */
function mapConnectorSkillInjected({ ts, d }: EngineEventContext): ConversationEvent | null {
  // The body is persisted verbatim; the reconstructor wraps it in
  // `<connector-skill>` containment when it rebuilds the message. A
  // missing body would surface an empty guidance block, so drop the
  // event rather than persist a useless one.
  const skillBody = typeof d.skillBody === "string" ? d.skillBody : "";
  if (!skillBody) return null;
  const e: ConnectorSkillInjectedEvent = {
    ts,
    type: "connector.skill.injected",
    toolName: (d.toolName as string) ?? "",
    skillName: (d.skillName as string) ?? "",
    skillBody,
    scope: (d.scope as string) ?? "connector",
  };
  return e;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EventSourcedStoreConfig {
  /** Directory for conversation JSONL files. */
  dir: string;
  /** Logging verbosity — "debug" persists full request/response data. */
  logLevel?: "normal" | "debug";
  /**
   * Called on any write to this dir's conversations — create, delete, or
   * append (an append changes a conversation's summary). The runtime routes
   * this to its conversation-cache invalidation so cross-workspace lists/loads
   * (the locator and the conversations-tool index) stay fresh. The per-dir
   * `ConversationIndex` is invalidated independently in-store.
   */
  onMutate?: () => void;
}

export class EventSourcedConversationStore implements ConversationStore, EventSink {
  private dir: string;
  private logLevel: "normal" | "debug";
  private onMutate?: () => void;
  private index = new ConversationIndex();
  private activeConversationId: string | null = null;
  private pendingWrites = new Set<Promise<unknown>>();
  /** Flag for once-per-process logging when the usage fallback fires. */
  private warnedMissingUsage = false;

  constructor(config: EventSourcedStoreConfig) {
    this.dir = config.dir;
    this.logLevel = config.logLevel ?? "normal";
    this.onMutate = config.onMutate;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  // =========================================================================
  // EventSink interface
  // =========================================================================

  /** Set which conversation file engine events should be written to. */
  setActiveConversation(id: string): void {
    this.activeConversationId = id;
  }

  /** Map engine events to conversation events and persist. */
  emit(event: EngineEvent): void {
    if (!this.activeConversationId) return;
    if (!CONVERSATION_EVENT_TYPES.has(event.type)) return;

    const mapped = this.mapEngineEvent(event);
    if (!mapped) return;

    this.appendEventSync(this.activeConversationId, mapped);
  }

  // =========================================================================
  // ConversationStore interface
  // =========================================================================

  async create(options: CreateConversationOptions): Promise<Conversation> {
    const id = options.id ?? `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      createdAt: now,
      updatedAt: now,
      title: null,
      lastModel: null,
      ownerId: options.ownerId,
      format: "events",
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    const path = this.path(id);
    await writeFile(path, `${JSON.stringify(conversation)}\n`);
    this.index.invalidate();
    this.onMutate?.();
    return conversation;
  }

  async load(id: string, access?: ConversationAccessContext): Promise<Conversation | null> {
    const path = this.path(id);
    if (!existsSync(path)) return null;

    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const raw = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (typeof raw.ownerId !== "string" || raw.ownerId.length === 0) {
      // Stage 1 invariant: every conversation has an ownerId. A file
      // without one is pre-migration data and unreadable by this code.
      // Throw a typed error so the HTTP layer can map to a clean
      // `422 conversation_corrupted` (with the migration command in
      // the message) instead of bubbling as 500.
      throw new ConversationCorruptedError(id, "missing_owner");
    }
    const conversation = parseConversationHeader(raw);

    // Derive mutable metadata from events (source of truth)
    if (lines.length > 1) {
      applyDerivedMeta(conversation, lines);
    }

    if (access && !canAccess({ ownerId: conversation.ownerId }, access)) {
      return null;
    }

    return conversation;
  }

  /** Append a ConversationEvent to a conversation file. */
  appendEvent(id: string, event: ConversationEvent): void {
    this.appendEventSync(id, event);
  }

  /**
   * Backward-compatible append for StoredMessage.
   * Converts assistant messages to events; user messages to user.message events.
   */
  async append(conversation: Conversation, message: StoredMessage): Promise<void> {
    if (conversation.format === "events") {
      this.appendEventFormat(conversation, message);
      return;
    }
    await this.appendLegacyFormat(conversation, message);
  }

  /** Append a StoredMessage to an event-format conversation, converting it to events. */
  private appendEventFormat(conversation: Conversation, message: StoredMessage): void {
    if (message.role === "user") {
      const event: ConversationEvent = {
        ts: message.timestamp,
        type: "user.message",
        content: message.content as ConversationEvent extends { content: infer C } ? C : never,
        ...(message.userId ? { userId: message.userId } : {}),
      } as ConversationEvent;
      this.appendEventSync(conversation.id, event);
      return;
    }

    if (message.role === "assistant" && message.metadata) {
      // Create synthetic run bookends + llm.response from assistant metadata.
      // Route through `appendEventSync` (three calls instead of one batched
      // `appendFileSync`) so the binary-payload guard covers this path too.
      // The three events are written in order, terminated by a trailing
      // newline each — same on-disk shape as the previous batched write.
      const runId = `append_${Date.now()}`;
      const runStart: ConversationEvent = {
        ts: message.timestamp,
        type: "run.start",
        runId,
        model: message.metadata.model ?? "unknown",
      } as ConversationEvent;
      const llmResponse: LlmResponseEvent = {
        ts: message.timestamp,
        type: "llm.response",
        runId,
        model: message.metadata.model ?? "unknown",
        content: message.content as LlmResponseEvent["content"],
        usage: message.metadata.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
        },
        llmMs: message.metadata.llmMs ?? 0,
      };
      const runDone: ConversationEvent = {
        ts: message.timestamp,
        type: "run.done",
        runId,
        stopReason: "complete",
        totalMs: message.metadata.llmMs ?? 0,
      } as ConversationEvent;

      this.appendEventSync(conversation.id, runStart);
      this.appendEventSync(conversation.id, llmResponse);
      this.appendEventSync(conversation.id, runDone);
    }
  }

  /** Append a StoredMessage to a legacy (message-format) conversation via atomic rewrite. */
  private async appendLegacyFormat(
    conversation: Conversation,
    message: StoredMessage,
  ): Promise<void> {
    // Legacy format — same pattern as JsonlConversationStore
    assertNoBinaryPayloads(message, `message(${message.role})`);
    const path = this.path(conversation.id);
    if (message.role === "assistant" && message.metadata) {
      conversation.lastModel = message.metadata.model ?? conversation.lastModel;
    }
    conversation.updatedAt = message.timestamp;

    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    lines[0] = JSON.stringify(conversation);
    lines.push(JSON.stringify(message));

    const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
    await rename(tmpPath, path);
    this.index.invalidate();
  }

  /**
   * Read raw conversation events for a single conversation. Returns []
   * for missing files or legacy (message-format) conversations. Phase 2
   * read tools (`skills__active_for`, `skills__loading_log`) consume this.
   */
  async readEvents(id: string): Promise<ConversationEvent[]> {
    const path = this.path(id);
    if (!existsSync(path)) return [];
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length < 2) return [];
    if (!this.detectFormat(lines)) return [];
    return safeParseLines<ConversationEvent>(lines.slice(1));
  }

  /** Directory holding the per-conversation JSONLs. */
  getDir(): string {
    return this.dir;
  }

  async history(conversation: Conversation, limit?: number): Promise<StoredMessage[]> {
    const messages = await this.readMessages(conversation.id);
    return limit ? messages.slice(-limit) : messages;
  }

  /**
   * Read and reconstruct a conversation's messages from disk.
   *
   * `ignoreCompaction` selects the projection: the default (false) returns the
   * compacted view (summary seed + recent tail) that feeds the model;
   * `ignoreCompaction: true` returns the FULL verbatim history — the
   * conversation's truth, matching what the UI/export render. Use the verbatim
   * view anywhere the conversation is copied or shown to the user (e.g.
   * `fork`), never for the model context.
   */
  private async readMessages(
    conversationId: string,
    opts?: { ignoreCompaction?: boolean },
  ): Promise<StoredMessage[]> {
    const path = this.path(conversationId);
    if (!existsSync(path)) return [];

    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length < 2) return [];

    if (this.detectFormat(lines)) {
      const events = safeParseLines<ConversationEvent>(lines.slice(1));
      return reconstructMessages(events, opts);
    }
    return safeParseLines<StoredMessage>(lines.slice(1));
  }

  async list(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    await this.index.populate(this.dir);
    return this.index.list(options, access);
  }

  async delete(id: string, access?: ConversationAccessContext): Promise<boolean> {
    // Access check happens before existence check so we don't leak
    // existence-but-not-yours to non-owners — `false` for both shapes.
    if (access) {
      const conv = await this.load(id);
      if (!conv) return false;
      if (conv.ownerId !== access.userId) return false;
    }
    const path = this.path(id);
    if (!existsSync(path)) return false;
    await unlink(path);
    this.index.remove(id);
    this.onMutate?.();
    return true;
  }

  async update(
    id: string,
    patch: ConversationPatch,
    access?: ConversationAccessContext,
  ): Promise<Conversation | null> {
    if (access) {
      const existing = await this.load(id);
      if (!existing) return null;
      if (existing.ownerId !== access.userId) return null;
    }
    return this.trackWrite(this._update(id, patch));
  }

  async fork(
    id: string,
    atMessage?: number,
    access?: ConversationAccessContext,
  ): Promise<Conversation | null> {
    // Unlike delete/update which can short-circuit on the access
    // check, fork legitimately needs the loaded source to do its job
    // (history + messagesToCopy). So we load first, then evaluate
    // both branches in the same posture: foreign owner and missing
    // both return null, indistinguishable to the caller.
    const source = await this.load(id);
    if (!source) return null;
    if (access && source.ownerId !== access.userId) return null;

    // Fork from the VERBATIM history, not the compacted projection. A fork is
    // a faithful copy of the conversation as the user sees it; reading the
    // compacted view here would bake the `<conversation-summary>` seed in as
    // real events and permanently drop the pre-boundary turns the UI still
    // shows. `atMessage` is an index into that same full-history view (the web
    // client's projection), so slicing the compacted array would also cut at
    // the wrong logical point.
    const allMessages = await this.readMessages(source.id, { ignoreCompaction: true });
    const messagesToCopy = atMessage !== undefined ? allMessages.slice(0, atMessage) : allMessages;

    const newConv = await this.create({
      ownerId: source.ownerId,
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
    });

    if (messagesToCopy.length > 0) {
      await this.writeForkedMessages(newConv, messagesToCopy);
    }

    return newConv;
  }

  /** Populate a freshly forked conversation file from copied messages, in event format. */
  private async writeForkedMessages(
    newConv: Conversation,
    messagesToCopy: StoredMessage[],
  ): Promise<void> {
    // Token totals are derived from events; only carry lastModel forward.
    const lastModel = forkLastModel(messagesToCopy);
    if (lastModel) {
      newConv.lastModel = lastModel;
    }
    newConv.updatedAt =
      messagesToCopy[messagesToCopy.length - 1]?.timestamp ?? new Date().toISOString();

    // Reconstructed messages should already be free of binary payloads
    // (we read them out of the event log, which is guarded on write).
    // Re-assert anyway so an in-memory source that somehow held bytes
    // can't poison the forked file.
    for (const msg of messagesToCopy) {
      assertNoBinaryPayloads(msg, `fork.message(${msg.role})`);
    }

    // Write as event-format: convert messages to events. Each assistant turn
    // is wrapped in a synthetic run.start/run.done span so reconstructMessages
    // keeps it (assistant messages are only emitted inside an active run scope).
    const eventLines = messagesToForkEventLines(messagesToCopy);
    const lines = [JSON.stringify(newConv), ...eventLines];
    const path = this.path(newConv.id);
    const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
    await rename(tmpPath, path);
    this.index.invalidate();
  }

  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    await Promise.allSettled(Array.from(this.pendingWrites));
  }

  // =========================================================================
  // Private
  // =========================================================================

  private mapEngineEvent(event: EngineEvent): ConversationEvent | null {
    const ctx: EngineEventContext = {
      ts: new Date().toISOString(),
      d: event.data,
      runId: event.data.runId as string,
      debug: this.logLevel === "debug",
    };

    switch (event.type) {
      case "run.start":
        return mapRunStart(ctx);
      case "llm.done":
        return this.mapLlmDone(ctx);
      case "tool.start":
        return mapToolStart(ctx);
      case "tool.done":
        return mapToolDone(ctx);
      case "tool.progress":
        return mapToolProgress(ctx);
      case "run.done":
        return mapRunDone(ctx);
      case "run.error":
        return mapRunError(ctx);
      case "skills.loaded":
        return mapSkillsLoaded(ctx);
      case "context.assembled":
        return mapContextAssembled(ctx);
      case "connector.skill.injected":
        return mapConnectorSkillInjected(ctx);
      default:
        return null;
    }
  }

  /** Map an engine `llm.done` to a persisted `llm.response`, backfilling usage if omitted. */
  private mapLlmDone({ ts, d, runId }: EngineEventContext): LlmResponseEvent {
    const finishReason = d.finishReason as LlmResponseEvent["finishReason"];
    // Defensive default at the write boundary: a malformed emitter
    // must not produce `usage: undefined` in the JSONL — that
    // corrupts the file forever and crashes every downstream reader.
    // The current engine always supplies `data.usage`, but this
    // guard means a single bad code path can't poison the stream.
    // Log once when the fallback fires so a regressed emitter isn't
    // a silent telemetry blackout.
    let usage = d.usage as LlmResponseEvent["usage"] | undefined;
    if (!usage) {
      if (!this.warnedMissingUsage) {
        this.warnedMissingUsage = true;
        process.stderr.write(
          "[event-sourced-store] llm.done event arrived without `data.usage`; writing zeroed fallback. This indicates a regressed emitter — check the engine.\n",
        );
      }
      usage = { inputTokens: 0, outputTokens: 0 };
    }
    return {
      ts,
      type: "llm.response",
      runId,
      model: d.model as string,
      content: (d.content ?? []) as LlmResponseEvent["content"],
      usage,
      llmMs: (d.llmMs as number) ?? 0,
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  /** Synchronously append an event line to a conversation file. */
  private appendEventSync(id: string, event: ConversationEvent): void {
    assertNoBinaryPayloads(event, `event(${event.type})`);
    const path = this.path(id);
    appendFileSync(path, `${JSON.stringify(event)}\n`);
    // An append changes a conversation's summary (title/updatedAt/tokens), so
    // the cross-workspace caches must refresh — not just on create/delete. The hook
    // is a cheap invalidation flag; the rescan it triggers is lazy (next read).
    this.onMutate?.();
  }

  /** Detect whether a conversation file uses event format or legacy message format. */
  private detectFormat(lines: string[]): boolean {
    const [firstLine, secondLine] = lines;

    // Check line 1 for explicit format field
    if (firstLine) {
      try {
        const meta = JSON.parse(firstLine) as Record<string, unknown>;
        if (meta.format === "events") return true;
      } catch {
        // fall through
      }
    }

    // Check line 2 for type field (event) vs role field (legacy)
    if (secondLine) {
      try {
        const parsed = JSON.parse(secondLine) as Record<string, unknown>;
        if ("type" in parsed) return true;
        if ("role" in parsed) return false;
      } catch {
        // fall through
      }
    }

    return false;
  }

  private async _update(id: string, patch: ConversationPatch): Promise<Conversation | null> {
    const path = this.path(id);
    if (!existsSync(path)) return null;

    if (patch.title !== undefined) {
      this.appendEventSync(id, {
        ts: new Date().toISOString(),
        type: "metadata.title",
        title: patch.title,
      });
    }

    this.index.invalidate();
    return this.load(id);
  }

  private trackWrite<T>(p: Promise<T>): Promise<T> {
    this.pendingWrites.add(p);
    p.then(
      () => this.pendingWrites.delete(p),
      () => this.pendingWrites.delete(p),
    );
    return p;
  }

  private path(id: string): string {
    validateConversationId(id, this.dir);
    return join(this.dir, `${id}.jsonl`);
  }
}
