import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options?.ownerId ? { ownerId: options.ownerId } : {}),
      visibility: options?.ownerId ? (options.visibility ?? "private") : options?.visibility,
      ...(options?.ownerId
        ? { participants: options.participants ?? [options.ownerId] }
        : options?.participants
          ? { participants: options.participants }
          : {}),
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
    // Default missing fields for backward compat with old JSONL files
    const conversation: Conversation = {
      id: raw.id as string,
      createdAt: raw.createdAt as string,
      updatedAt: (raw.updatedAt as string) ?? (raw.createdAt as string),
      title: (raw.title as string | null) ?? null,
      totalInputTokens: (raw.totalInputTokens as number) ?? 0,
      totalOutputTokens: (raw.totalOutputTokens as number) ?? 0,
      totalCostUsd: (raw.totalCostUsd as number) ?? 0,
      lastModel: (raw.lastModel as string | null) ?? null,
      ...(raw.workspaceId ? { workspaceId: raw.workspaceId as string } : {}),
      ...(raw.ownerId ? { ownerId: raw.ownerId as string } : {}),
      ...(raw.visibility ? { visibility: raw.visibility as "private" | "shared" } : {}),
      ...(raw.participants ? { participants: raw.participants as string[] } : {}),
      ...(raw.metadata ? { metadata: raw.metadata as Record<string, unknown> } : {}),
    };

    // Enforce access control when context is provided
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

  async append(conversation: Conversation, message: StoredMessage): Promise<void> {
    const path = this.path(conversation.id);

    // Accumulate token stats from assistant messages with metadata
    if (message.role === "assistant" && message.metadata) {
      conversation.totalInputTokens += message.metadata.inputTokens ?? 0;
      conversation.totalOutputTokens += message.metadata.outputTokens ?? 0;
      conversation.totalCostUsd += message.metadata.costUsd ?? 0;
      conversation.lastModel = message.metadata.model ?? conversation.lastModel;
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

  async fork(id: string, atMessage?: number): Promise<Conversation | null> {
    const source = await this.load(id);
    if (!source) return null;

    const allMessages = await this.history(source);
    const messagesToCopy = atMessage !== undefined ? allMessages.slice(0, atMessage) : allMessages;

    // Create a new conversation
    const newConv = await this.create();

    // If there are messages to copy, rewrite the new file with them
    if (messagesToCopy.length > 0) {
      // Re-accumulate tokens from the copied messages
      for (const msg of messagesToCopy) {
        if (msg.role === "assistant" && msg.metadata) {
          newConv.totalInputTokens += msg.metadata.inputTokens ?? 0;
          newConv.totalOutputTokens += msg.metadata.outputTokens ?? 0;
          newConv.totalCostUsd += msg.metadata.costUsd ?? 0;
          newConv.lastModel = msg.metadata.model ?? newConv.lastModel;
        }
      }
      // Update updatedAt to last message timestamp
      newConv.updatedAt =
        messagesToCopy[messagesToCopy.length - 1]?.timestamp ?? new Date().toISOString();

      const lines = [JSON.stringify(newConv)];
      for (const msg of messagesToCopy) {
        lines.push(JSON.stringify(msg));
      }

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

    conversation.visibility = "shared";
    // Ensure owner is in participants
    if (!conversation.participants) {
      conversation.participants = [ownerId];
    } else if (!conversation.participants.includes(ownerId)) {
      conversation.participants = [ownerId, ...conversation.participants];
    }

    await this.rewriteMetadata(id, conversation);
    return conversation;
  }

  async unshareConversation(id: string, ownerId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;
    if (conversation.ownerId && conversation.ownerId !== ownerId) return null;

    conversation.visibility = "private";
    // Keep only the owner in participants
    conversation.participants = conversation.ownerId ? [conversation.ownerId] : [];

    await this.rewriteMetadata(id, conversation);
    return conversation;
  }

  async addParticipant(id: string, userId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;

    if (!conversation.participants) {
      conversation.participants = [userId];
    } else if (!conversation.participants.includes(userId)) {
      conversation.participants = [...conversation.participants, userId];
    }

    await this.rewriteMetadata(id, conversation);
    return conversation;
  }

  async removeParticipant(id: string, userId: string): Promise<Conversation | null> {
    const conversation = await this.load(id);
    if (!conversation) return null;
    // Cannot remove the owner
    if (conversation.ownerId === userId) return null;

    if (conversation.participants) {
      conversation.participants = conversation.participants.filter((p) => p !== userId);
    }

    await this.rewriteMetadata(id, conversation);
    return conversation;
  }

  /** Atomically rewrite the metadata line (line 1) for a conversation. */
  private async rewriteMetadata(id: string, conversation: Conversation): Promise<void> {
    const path = this.path(id);
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    lines[0] = JSON.stringify(conversation);
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
