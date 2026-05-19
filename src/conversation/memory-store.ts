import { estimateCost } from "../usage/cost.ts";
import type { TokenUsage } from "../usage/types.ts";
import { addUsage, emptyUsage } from "../usage/types.ts";
import { canAccess } from "./index-cache.ts";
import type {
  Conversation,
  ConversationAccessContext,
  ConversationListResult,
  ConversationPatch,
  ConversationStore,
  ConversationSummary,
  CreateConversationOptions,
  ListOptions,
  StoredMessage,
} from "./types.ts";

/**
 * Derive cumulative usage + cost from a flat list of stored messages.
 * Used by the legacy (non-event-sourced) stores when building a
 * ConversationSummary. Cost is computed at read time from the catalog;
 * never stored.
 */
function deriveSummaryTotals(messages: StoredMessage[]): {
  usage: TokenUsage;
  costUsd: number;
} {
  const usage = emptyUsage();
  let costUsd = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.metadata?.usage || !msg.metadata.model) continue;
    addUsage(usage, msg.metadata.usage);
    costUsd += estimateCost(msg.metadata.model, msg.metadata.usage);
  }
  return { usage, costUsd };
}

export class InMemoryConversationStore implements ConversationStore {
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, StoredMessage[]>();

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
    this.conversations.set(id, conversation);
    this.messages.set(id, []);
    return conversation;
  }

  async load(id: string, access?: ConversationAccessContext): Promise<Conversation | null> {
    const conversation = this.conversations.get(id) ?? null;
    if (!conversation) return null;

    if (access && !canAccess({ ownerId: conversation.ownerId }, access)) {
      return null;
    }

    return conversation;
  }

  async append(conversation: Conversation, message: StoredMessage): Promise<void> {
    const messages = this.messages.get(conversation.id);
    if (!messages) throw new Error(`Conversation ${conversation.id} not found`);

    // Track lastModel for display. Token totals are derived from message
    // history at read time (deriveSummaryTotals), never stored.
    if (message.role === "assistant" && message.metadata?.model) {
      conversation.lastModel = message.metadata.model;
    }

    // Update updatedAt from message timestamp
    conversation.updatedAt = message.timestamp;

    messages.push(message);
  }

  async history(conversation: Conversation, limit?: number): Promise<StoredMessage[]> {
    const messages = this.messages.get(conversation.id);
    if (!messages) return [];
    const slice = limit ? messages.slice(-limit) : messages;
    return slice.map((m) => ({ ...m }));
  }

  async list(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    const limit = options?.limit ?? 20;
    const search = options?.search?.toLowerCase();
    const sortBy = options?.sortBy ?? "updatedAt";
    const summaries: ConversationSummary[] = [];

    for (const [id, conversation] of this.conversations) {
      if (access && !canAccess({ ownerId: conversation.ownerId }, access)) continue;
      const msgs = this.messages.get(id) ?? [];
      const firstUser = msgs.find((m) => m.role === "user");
      const preview = firstUser
        ? typeof firstUser.content === "string"
          ? firstUser.content
          : ""
        : "";

      // Apply search filter
      if (search) {
        const titleMatch = conversation.title?.toLowerCase().includes(search) ?? false;
        const previewMatch = preview.toLowerCase().includes(search);
        if (!titleMatch && !previewMatch) continue;
      }

      const totals = deriveSummaryTotals(msgs);
      summaries.push({
        id: conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        title: conversation.title,
        messageCount: msgs.length,
        preview,
        totalInputTokens: totals.usage.inputTokens,
        totalOutputTokens: totals.usage.outputTokens,
        totalCostUsd: totals.costUsd,
        ownerId: conversation.ownerId,
      });
    }

    // Sort descending
    summaries.sort((a, b) => b[sortBy].localeCompare(a[sortBy]));

    const totalCount = summaries.length;

    // Cursor pagination: skip entries up to and including the cursor ID
    let items = summaries;
    if (options?.cursor) {
      const idx = items.findIndex((s) => s.id === options.cursor);
      if (idx >= 0) items = items.slice(idx + 1);
    }

    const page = items.slice(0, limit);
    const nextCursor =
      page.length === limit && items.length > limit ? (page[page.length - 1]?.id ?? null) : null;

    return { conversations: page, nextCursor, totalCount };
  }

  async delete(id: string, access?: ConversationAccessContext): Promise<boolean> {
    const conv = this.conversations.get(id);
    if (!conv) return false;
    if (access && conv.ownerId !== access.userId) return false;
    this.conversations.delete(id);
    this.messages.delete(id);
    return true;
  }

  async update(
    id: string,
    patch: ConversationPatch,
    access?: ConversationAccessContext,
  ): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    if (!conversation) return null;
    if (access && conversation.ownerId !== access.userId) return null;

    if (patch.title !== undefined) {
      conversation.title = patch.title;
    }

    return { ...conversation };
  }

  async fork(
    id: string,
    atMessage?: number,
    access?: ConversationAccessContext,
  ): Promise<Conversation | null> {
    const source = this.conversations.get(id);
    if (!source) return null;
    if (access && source.ownerId !== access.userId) return null;

    const sourceMessages = this.messages.get(id) ?? [];
    const messagesToCopy =
      atMessage !== undefined ? sourceMessages.slice(0, atMessage) : [...sourceMessages];

    const newConv = await this.create({
      ownerId: source.ownerId,
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
    });

    // Track lastModel from copied messages. Token totals derive at read.
    for (const msg of messagesToCopy) {
      if (msg.role === "assistant" && msg.metadata?.model) {
        newConv.lastModel = msg.metadata.model;
      }
    }

    // Update updatedAt if there are messages
    if (messagesToCopy.length > 0) {
      newConv.updatedAt =
        messagesToCopy[messagesToCopy.length - 1]?.timestamp ?? new Date().toISOString();
    }

    this.messages.set(
      newConv.id,
      messagesToCopy.map((m) => ({ ...m })),
    );

    return newConv;
  }
}
