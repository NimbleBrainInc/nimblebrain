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
import {
  deriveConversationMeta,
  deriveUsageMetrics,
  reconstructMessages,
} from "./event-reconstructor.ts";
import { ConversationIndex, canAccess } from "./index-cache.ts";
import {
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

  async create(options?: CreateConversationOptions): Promise<Conversation> {
    const id = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      createdAt: now,
      updatedAt: now,
      title: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      lastModel: null,
      format: "events",
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options?.ownerId ? { ownerId: options.ownerId } : {}),
      visibility: options?.ownerId ? (options.visibility ?? "private") : options?.visibility,
      ...(options?.ownerId
        ? { participants: options.participants ?? [options.ownerId] }
        : options?.participants
          ? { participants: options.participants }
          : {}),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
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
    const conversation: Conversation = {
      id: raw.id as string,
      createdAt: raw.createdAt as string,
      updatedAt: (raw.updatedAt as string) ?? (raw.createdAt as string),
      title: (raw.title as string | null) ?? null,
      totalInputTokens: (raw.totalInputTokens as number) ?? 0,
      totalOutputTokens: (raw.totalOutputTokens as number) ?? 0,
      totalCostUsd: (raw.totalCostUsd as number) ?? 0,
      lastModel: (raw.lastModel as string | null) ?? null,
      ...(raw.format ? { format: raw.format as "events" } : {}),
      ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
      ...(raw.ownerId ? { ownerId: raw.ownerId as string } : {}),
      ...(raw.visibility ? { visibility: raw.visibility as "private" | "shared" } : {}),
      ...(raw.participants ? { participants: raw.participants as string[] } : {}),
      ...(raw.metadata ? { metadata: raw.metadata as Record<string, unknown> } : {}),
    };

    // Derive mutable metadata from events (source of truth)
    if (lines.length > 1) {
      const events = safeParseLines<ConversationEvent>(lines.slice(1));
      const usage = deriveUsageMetrics(events);
      if (usage.totalInputTokens > 0 || usage.totalOutputTokens > 0) {
        conversation.totalInputTokens = usage.totalInputTokens;
        conversation.totalOutputTokens = usage.totalOutputTokens;
        conversation.totalCostUsd = usage.totalCostUsd;
        conversation.lastModel = usage.lastModel;
      }
      // Derive title, visibility, participants from metadata events
      const meta = deriveConversationMeta(events, {
        title: conversation.title,
        visibility: conversation.visibility,
        participants: conversation.participants,
      });
      conversation.title = meta.title;
      if (meta.visibility !== undefined) conversation.visibility = meta.visibility;
      if (meta.participants !== undefined) conversation.participants = meta.participants;
      // Derive updatedAt from last event timestamp
      const lastEvent = events[events.length - 1];
      if (lastEvent) {
        conversation.updatedAt = lastEvent.ts;
      }
    }

    if (access) {
      const meta = {
        ownerId: conversation.ownerId,
        visibility: conversation.visibility,
        participants: conversation.participants,
      };
      if (!canAccess(meta, access)) return null;
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
        // Create synthetic run bookends + llm.response from assistant metadata
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
          inputTokens: message.metadata.inputTokens ?? 0,
          outputTokens: message.metadata.outputTokens ?? 0,
          cacheReadTokens: message.metadata.cacheReadTokens ?? 0,
          cacheCreationTokens: 0,
          llmMs: message.metadata.llmMs ?? 0,
        };
        const runDone: ConversationEvent = {
          ts: message.timestamp,
          type: "run.done",
          runId,
          stopReason: "complete",
          totalMs: message.metadata.llmMs ?? 0,
        } as ConversationEvent;

        const path = this.path(conversation.id);
        appendFileSync(
          path,
          `${JSON.stringify(runStart)}\n${JSON.stringify(llmResponse)}\n${JSON.stringify(runDone)}\n`,
        );
      }
      return;
    }

    // Legacy format — same pattern as JsonlConversationStore
    const path = this.path(conversation.id);
    if (message.role === "assistant" && message.metadata) {
      conversation.totalInputTokens += message.metadata.inputTokens ?? 0;
      conversation.totalOutputTokens += message.metadata.outputTokens ?? 0;
      conversation.totalCostUsd += message.metadata.costUsd ?? 0;
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

  async history(conversation: Conversation, limit?: number): Promise<StoredMessage[]> {
    const path = this.path(conversation.id);
    if (!existsSync(path)) return [];

    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length < 2) return [];

    const isEventFormat = this.detectFormat(lines);

    let messages: StoredMessage[];
    if (isEventFormat) {
      const events = safeParseLines<ConversationEvent>(lines.slice(1));
      messages = reconstructMessages(events);
    } else {
      messages = safeParseLines<StoredMessage>(lines.slice(1));
    }

    return limit ? messages.slice(-limit) : messages;
  }

  async list(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    await this.index.populate(this.dir);
    return this.index.list(options, access);
  }

  async delete(id: string): Promise<boolean> {
    const path = this.path(id);
    if (!existsSync(path)) return false;
    await unlink(path);
    this.index.remove(id);
    return true;
  }

  update(id: string, patch: ConversationPatch): Promise<Conversation | null> {
    return this.trackWrite(this._update(id, patch));
  }

  async fork(id: string, atMessage?: number): Promise<Conversation | null> {
    const source = await this.load(id);
    if (!source) return null;

    const allMessages = await this.history(source);
    const messagesToCopy = atMessage !== undefined ? allMessages.slice(0, atMessage) : allMessages;

    const newConv = await this.create();

    if (messagesToCopy.length > 0) {
      for (const msg of messagesToCopy) {
        if (msg.role === "assistant" && msg.metadata) {
          newConv.totalInputTokens += msg.metadata.inputTokens ?? 0;
          newConv.totalOutputTokens += msg.metadata.outputTokens ?? 0;
          newConv.totalCostUsd += msg.metadata.costUsd ?? 0;
          newConv.lastModel = msg.metadata.model ?? newConv.lastModel;
        }
      }
      newConv.updatedAt =
        messagesToCopy[messagesToCopy.length - 1]?.timestamp ?? new Date().toISOString();

      // Write as event-format: convert messages to events
      const eventLines: string[] = [];
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
          eventLines.push(
            JSON.stringify({
              ts: msg.timestamp,
              type: "llm.response",
              runId: "forked",
              model: msg.metadata?.model ?? "unknown",
              content: msg.content,
              inputTokens: msg.metadata?.inputTokens ?? 0,
              outputTokens: msg.metadata?.outputTokens ?? 0,
              cacheReadTokens: msg.metadata?.cacheReadTokens ?? 0,
              cacheCreationTokens: 0,
              llmMs: msg.metadata?.llmMs ?? 0,
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

  async shareConversation(id: string, ownerId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;
    if (conversation.ownerId && conversation.ownerId !== ownerId) return null;

    const ts = new Date().toISOString();
    this.appendEventSync(id, { ts, type: "metadata.visibility", visibility: "shared" });

    let participants = conversation.participants ?? [];
    if (!participants.includes(ownerId)) {
      participants = [ownerId, ...participants];
    }
    this.appendEventSync(id, { ts, type: "metadata.participants", participants });

    this.index.invalidate();
    return this.load(id);
  }

  async unshareConversation(id: string, ownerId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;
    if (conversation.ownerId && conversation.ownerId !== ownerId) return null;

    const ts = new Date().toISOString();
    this.appendEventSync(id, { ts, type: "metadata.visibility", visibility: "private" });
    const participants = conversation.ownerId ? [conversation.ownerId] : [];
    this.appendEventSync(id, { ts, type: "metadata.participants", participants });

    this.index.invalidate();
    return this.load(id);
  }

  async addParticipant(id: string, userId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;

    let participants = conversation.participants ?? [];
    if (!participants.includes(userId)) {
      participants = [...participants, userId];
      this.appendEventSync(id, {
        ts: new Date().toISOString(),
        type: "metadata.participants",
        participants,
      });
      this.index.invalidate();
    }

    return this.load(id);
  }

  async removeParticipant(id: string, userId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;
    if (conversation.ownerId === userId) return null;

    if (conversation.participants) {
      const participants = conversation.participants.filter((p) => p !== userId);
      this.appendEventSync(id, {
        ts: new Date().toISOString(),
        type: "metadata.participants",
        participants,
      });
      this.index.invalidate();
    }

    return this.load(id);
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
        const reasoningTokens = (d.reasoningTokens as number) ?? 0;
        const e: LlmResponseEvent = {
          ts,
          type: "llm.response",
          runId,
          model: d.model as string,
          content: (d.content ?? []) as LlmResponseEvent["content"],
          inputTokens: (d.inputTokens as number) ?? 0,
          outputTokens: (d.outputTokens as number) ?? 0,
          cacheReadTokens: (d.cacheReadTokens as number) ?? 0,
          cacheCreationTokens: (d.cacheCreationTokens as number) ?? 0,
          llmMs: (d.llmMs as number) ?? 0,
          ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
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
        const e: ToolDoneEvent = {
          ts,
          type: "tool.done",
          runId,
          name: d.name as string,
          id: d.id as string,
          ok: (d.ok as boolean) ?? true,
          ms: (d.ms as number) ?? 0,
          ...(output !== undefined ? { output } : {}),
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

      default:
        return null;
    }
  }

  /** Synchronously append an event line to a conversation file. */
  private appendEventSync(id: string, event: ConversationEvent): void {
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
