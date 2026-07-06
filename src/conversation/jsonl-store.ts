import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationCorruptedError } from "../runtime/errors.ts";
import { assertNoBinaryPayloads } from "./binary-guard.ts";
import { ConversationIndex, canAccess } from "./index-cache.ts";
import {
  type Conversation,
  type ConversationAccessContext,
  type ConversationListResult,
  type ConversationPatch,
  type ConversationStore,
  type CreateConversationOptions,
  type ListOptions,
  type StoredMessage,
  validateConversationId,
} from "./types.ts";

/**
 * Append-only JSONL conversation store.
 *
 * Format:
 *   Line 1: Conversation metadata (id, createdAt, updatedAt, ...)
 *   Lines 2+: StoredMessage objects, one per line
 */
let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

/** Model recorded by the last assistant message that carries one, else null. */
function lastAssistantModel(messages: StoredMessage[]): string | null {
  let model: string | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.metadata?.model) {
      model = msg.metadata.model;
    }
  }
  return model;
}

export class JsonlConversationStore implements ConversationStore {
  private index = new ConversationIndex();
  /**
   * Tracks all in-flight background write Promises (e.g. auto-title updates).
   * Use flush() to wait for all pending writes to settle before reading, so
   * tests and callers can avoid setTimeout-based race-condition workarounds.
   */
  private pendingWrites = new Set<Promise<unknown>>();

  constructor(private dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Wait for all in-flight background writes to settle.
   *
   * Background writes (e.g. auto-title metadata updates triggered by the
   * runtime) are tracked internally. Calling flush() is the correct way to
   * synchronise before reading — it eliminates the need for setTimeout delays
   * that make tests timing-dependent.
   *
   * Resolves immediately when no writes are pending (idempotent).
   */
  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    await Promise.allSettled(Array.from(this.pendingWrites));
  }

  /**
   * Register a Promise as a pending background write. The Promise is
   * automatically removed from the tracking set when it settles.
   */
  private trackWrite<T>(p: Promise<T>): Promise<T> {
    this.pendingWrites.add(p);
    p.then(
      () => this.pendingWrites.delete(p),
      () => this.pendingWrites.delete(p),
    );
    return p;
  }

  async create(options: CreateConversationOptions): Promise<Conversation> {
    const id = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      createdAt: now,
      updatedAt: now,
      title: null,
      lastModel: null,
      ownerId: options.ownerId,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
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
    const firstLine = content.split("\n")[0];
    if (!firstLine) return null;

    const raw = JSON.parse(firstLine) as Record<string, unknown>;
    if (typeof raw.ownerId !== "string" || raw.ownerId.length === 0) {
      // Typed error so the HTTP layer can map to a clean 422
      // (see src/api/handlers.ts::conversationCorruptedResponse).
      throw new ConversationCorruptedError(id, "missing_owner");
    }
    const conversation: Conversation = {
      id: raw.id as string,
      createdAt: raw.createdAt as string,
      updatedAt: (raw.updatedAt as string) ?? (raw.createdAt as string),
      title: (raw.title as string | null) ?? null,
      lastModel: (raw.lastModel as string | null) ?? null,
      ownerId: raw.ownerId,
      ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
      ...(raw.metadata ? { metadata: raw.metadata as Record<string, unknown> } : {}),
    };

    if (access && !canAccess({ ownerId: conversation.ownerId }, access)) {
      return null;
    }

    return conversation;
  }

  async append(conversation: Conversation, message: StoredMessage): Promise<void> {
    assertNoBinaryPayloads(message, `message(${message.role})`);
    const path = this.path(conversation.id);

    // Track lastModel for display. Token totals are derived from the
    // message history at read time (see ConversationIndex), never stored.
    if (message.role === "assistant" && message.metadata?.model) {
      conversation.lastModel = message.metadata.model;
    }

    // Update updatedAt from message timestamp
    conversation.updatedAt = message.timestamp;

    // Atomic rewrite: read all lines, update metadata (line 1), append new message
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Replace line 1 with updated metadata
    lines[0] = JSON.stringify(conversation);
    // Append the new message
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
    // Skip line 0 (metadata), parse the rest as messages
    const messages = lines.slice(1).map((line) => JSON.parse(line) as StoredMessage);

    return limit ? messages.slice(-limit) : messages;
  }

  async list(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    await this.index.populate(this.dir);
    return this.index.list(options, access);
  }

  async delete(id: string, access?: ConversationAccessContext): Promise<boolean> {
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

  private async _update(id: string, patch: ConversationPatch): Promise<Conversation | null> {
    const path = this.path(id);
    if (!existsSync(path)) return null;

    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const conversation = await this.load(id);
    if (!conversation) return null;

    // Apply patch
    if (patch.title !== undefined) {
      conversation.title = patch.title;
    }

    // Rewrite metadata line atomically
    lines[0] = JSON.stringify(conversation);
    const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
    await rename(tmpPath, path);

    this.index.invalidate();
    return conversation;
  }

  async fork(
    id: string,
    atMessage?: number,
    access?: ConversationAccessContext,
  ): Promise<Conversation | null> {
    // Fork needs the loaded source for history + messagesToCopy, so
    // we load first. Foreign-owner and missing both return null —
    // indistinguishable to the caller, same posture as delete/update.
    const source = await this.load(id);
    if (!source) return null;
    if (access && source.ownerId !== access.userId) return null;

    const allMessages = await this.history(source);
    const messagesToCopy = atMessage !== undefined ? allMessages.slice(0, atMessage) : allMessages;

    // Create a new conversation
    const newConv = await this.create({
      ownerId: source.ownerId,
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
    });

    // If there are messages to copy, rewrite the new file with them
    if (messagesToCopy.length > 0) {
      await this.writeForked(newConv, messagesToCopy);
    }

    return newConv;
  }

  /** Persist a forked conversation's metadata + copied messages atomically. */
  private async writeForked(conv: Conversation, messages: StoredMessage[]): Promise<void> {
    // Token totals derive from messages at read time; carry lastModel forward.
    conv.lastModel = lastAssistantModel(messages) ?? conv.lastModel;
    // updatedAt tracks the last copied message's timestamp.
    conv.updatedAt = messages[messages.length - 1]?.timestamp ?? new Date().toISOString();

    // Defence-in-depth: rebuilt-from-history shouldn't carry bytes,
    // but assert before stringify so an in-memory source that does
    // can't poison the forked file.
    for (const msg of messages) {
      assertNoBinaryPayloads(msg, `fork.message(${msg.role})`);
    }

    const lines = [JSON.stringify(conv), ...messages.map((msg) => JSON.stringify(msg))];
    const path = this.path(conv.id);
    const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
    await rename(tmpPath, path);

    this.index.invalidate();
  }

  private path(id: string): string {
    validateConversationId(id, this.dir);
    return join(this.dir, `${id}.jsonl`);
  }
}
