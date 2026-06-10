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
]);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EventSourcedStoreConfig {
  /** Directory for conversation JSONL files. */
  dir: string;
  /** Logging verbosity — "debug" persists full request/response data. */
  logLevel?: "normal" | "debug";
}

export class EventSourcedConversationStore implements ConversationStore, EventSink {
  private dir: string;
  private logLevel: "normal" | "debug";
  private index = new ConversationIndex();
  private activeConversationId: string | null = null;
  private pendingWrites = new Set<Promise<unknown>>();
  /** Flag for once-per-process logging when the usage fallback fires. */
  private warnedMissingUsage = false;

  constructor(config: EventSourcedStoreConfig) {
    this.dir = config.dir;
    this.logLevel = config.logLevel ?? "normal";
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
    const conversation: Conversation = {
      id: raw.id as string,
      createdAt: raw.createdAt as string,
      updatedAt: (raw.updatedAt as string) ?? (raw.createdAt as string),
      title: (raw.title as string | null) ?? null,
      lastModel: (raw.lastModel as string | null) ?? null,
      ownerId: raw.ownerId,
      ...(raw.format ? { format: raw.format as "events" } : {}),
      ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
      ...(raw.metadata ? { metadata: raw.metadata as Record<string, unknown> } : {}),
    };

    // Derive mutable metadata from events (source of truth)
    if (lines.length > 1) {
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
      // Convert to event
      if (message.role === "user") {
        const event: ConversationEvent = {
          ts: message.timestamp,
          type: "user.message",
          content: message.content as ConversationEvent extends { content: infer C } ? C : never,
          ...(message.userId ? { userId: message.userId } : {}),
        } as ConversationEvent;
        this.appendEventSync(conversation.id, event);
      } else if (message.role === "assistant" && message.metadata) {
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
      return;
    }

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
      // Token totals are derived from events; only carry lastModel forward.
      for (const msg of messagesToCopy) {
        if (msg.role === "assistant" && msg.metadata?.model) {
          newConv.lastModel = msg.metadata.model;
        }
      }
      newConv.updatedAt =
        messagesToCopy[messagesToCopy.length - 1]?.timestamp ?? new Date().toISOString();

      // Write as event-format: convert messages to events.
      //
      // Each assistant turn must be wrapped in a synthetic
      // run.start/run.done span — without it, reconstructMessages drops
      // the turn (see event-reconstructor.ts: assistant messages are
      // only emitted inside an active run scope). Pre-fix, history() on
      // a forked event-format conversation returned only user messages.
      //
      // Reconstructed messages should already be free of binary payloads
      // (we read them out of the event log, which is guarded on write).
      // Re-assert anyway so an in-memory source that somehow held bytes
      // can't poison the forked file.
      for (const msg of messagesToCopy) {
        assertNoBinaryPayloads(msg, `fork.message(${msg.role})`);
      }
      const eventLines: string[] = [];
      let runCounter = 0;
      for (const msg of messagesToCopy) {
        if (msg.role === "user") {
          eventLines.push(
            JSON.stringify({
              ts: msg.timestamp,
              type: "user.message",
              content: msg.content,
              ...(msg.userId ? { userId: msg.userId } : {}),
            }),
          );
        } else if (msg.role === "assistant") {
          const runId = `forked-${runCounter++}`;
          const model = msg.metadata?.model ?? "unknown";
          eventLines.push(JSON.stringify({ ts: msg.timestamp, type: "run.start", runId, model }));
          eventLines.push(
            JSON.stringify({
              ts: msg.timestamp,
              type: "llm.response",
              runId,
              model,
              content: msg.content,
              usage: msg.metadata?.usage ?? { inputTokens: 0, outputTokens: 0 },
              llmMs: msg.metadata?.llmMs ?? 0,
            }),
          );
          eventLines.push(
            JSON.stringify({
              ts: msg.timestamp,
              type: "run.done",
              runId,
              stopReason: "complete",
              totalMs: msg.metadata?.llmMs ?? 0,
            }),
          );
        }
      }

      const lines = [JSON.stringify(newConv), ...eventLines];
      const path = this.path(newConv.id);
      const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
      await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
      await rename(tmpPath, path);
      this.index.invalidate();
    }

    return newConv;
  }

  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    await Promise.allSettled(Array.from(this.pendingWrites));
  }

  // =========================================================================
  // Private
  // =========================================================================

  private mapEngineEvent(event: EngineEvent): ConversationEvent | null {
    const ts = new Date().toISOString();
    const d = event.data;
    const runId = d.runId as string;
    const debug = this.logLevel === "debug";

    switch (event.type) {
      case "run.start": {
        const e: RunStartEvent = {
          ts,
          type: "run.start",
          runId,
          model: d.model as string,
          ...(debug && d.systemPrompt ? { systemPrompt: d.systemPrompt as string } : {}),
          ...(debug && d.messageRoles ? { messages: d.messageRoles as unknown[] } : {}),
          ...(debug && d.toolNames ? { toolSchemas: d.toolNames as string[] } : {}),
        };
        return e;
      }

      case "llm.done": {
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
        const e: LlmResponseEvent = {
          ts,
          type: "llm.response",
          runId,
          model: d.model as string,
          content: (d.content ?? []) as LlmResponseEvent["content"],
          usage,
          llmMs: (d.llmMs as number) ?? 0,
          ...(finishReason !== undefined ? { finishReason } : {}),
        };
        return e;
      }

      case "tool.start": {
        const e: ToolStartEvent = {
          ts,
          type: "tool.start",
          runId,
          name: d.name as string,
          id: d.id as string,
          ...(debug && d.input !== undefined ? { input: d.input } : {}),
        };
        return e;
      }

      case "tool.done": {
        // Always persist the text output for conversation history reconstruction.
        // The engine now sends `output` (extracted text) alongside `result` (full structured).
        const output = typeof d.output === "string" ? d.output : undefined;
        // Bounded model-view text, present only when the result exceeded the
        // model-context bound. Replay uses it verbatim so the replayed prompt
        // matches what the model saw live. See boundToolResultForModel.
        const modelOutput = typeof d.modelOutput === "string" ? d.modelOutput : undefined;
        const e: ToolDoneEvent = {
          ts,
          type: "tool.done",
          runId,
          name: d.name as string,
          id: d.id as string,
          ok: (d.ok as boolean) ?? true,
          ms: (d.ms as number) ?? 0,
          ...(output !== undefined ? { output } : {}),
          ...(modelOutput !== undefined ? { modelOutput } : {}),
        };
        return e;
      }

      case "tool.progress": {
        return {
          ts,
          type: "tool.progress",
          runId,
          id: d.id as string,
          message: (d.message as string) ?? "",
        };
      }

      case "run.done": {
        // Pass the engine's stopReason through verbatim. Defaulting to
        // "complete" here used to mask length-truncation and other
        // model-driven exits — the engine now derives the real reason
        // from the final LLM call's finishReason. If d.stopReason is
        // somehow missing, persist "other" so it's clear we don't know.
        const e: RunDoneEvent = {
          ts,
          type: "run.done",
          runId,
          stopReason: (d.stopReason as string) ?? "other",
          totalMs: (d.totalMs as number) ?? 0,
        };
        return e;
      }

      case "run.error": {
        const e: RunErrorEvent = {
          ts,
          type: "run.error",
          runId,
          error: (d.error as string) ?? "Unknown error",
          errorType: (d.type as string) ?? "Error",
        };
        return e;
      }

      case "skills.loaded": {
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
        const e: SkillsLoadedEvent = {
          ts,
          type: "skills.loaded",
          runId,
          skills,
          totalTokens: (d.totalTokens as number) ?? 0,
        };
        return e;
      }

      case "context.assembled": {
        const sources = Array.isArray(d.sources)
          ? (d.sources as ContextAssembledSource[])
          : ([] as ContextAssembledSource[]);
        const excluded = Array.isArray(d.excluded)
          ? (d.excluded as ContextAssembledSource[])
          : ([] as ContextAssembledSource[]);
        const e: ContextAssembledEvent = {
          ts,
          type: "context.assembled",
          runId,
          sources,
          excluded,
          totalTokens: (d.totalTokens as number) ?? 0,
          ...(typeof d.modelMaxContext === "number" ? { modelMaxContext: d.modelMaxContext } : {}),
          ...(typeof d.headroomTokens === "number" ? { headroomTokens: d.headroomTokens } : {}),
        };
        return e;
      }

      default:
        return null;
    }
  }

  /** Synchronously append an event line to a conversation file. */
  private appendEventSync(id: string, event: ConversationEvent): void {
    assertNoBinaryPayloads(event, `event(${event.type})`);
    const path = this.path(id);
    appendFileSync(path, `${JSON.stringify(event)}\n`);
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
