import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

export const ConversationsListInput = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max conversations to return. Default: 20." })),
  cursor: Type.Optional(
    Type.String({ description: "Opaque pagination cursor from a previous response." }),
  ),
  search: Type.Optional(Type.String({ description: "Substring match on title and preview." })),
  sortBy: Type.Optional(
    StringEnum(["created", "updated"] as const, {
      description: 'Sort field. Default: "updated".',
    }),
  ),
  dateFrom: Type.Optional(
    Type.String({
      description: "Filter: only conversations created on or after this ISO 8601 date.",
    }),
  ),
  dateTo: Type.Optional(
    Type.String({
      description: "Filter: only conversations created on or before this ISO 8601 date.",
    }),
  ),
});
// No `workspaceId`: conversations are workspace-owned and the workspace is
// AMBIENT (the request's focused workspace, via `RequestContext`), never a
// caller-supplied coordinate. Same contract as `files__*`.
export type ConversationsListInput = Static<typeof ConversationsListInput>;

/**
 * Description shared by every tool that addresses one conversation.
 *
 * `id` is optional on all of them: an agent inside a chat has no way to learn
 * its own conversation id, so requiring one made the current conversation the
 * only one these tools could not reach. Omitted, it resolves from the request
 * context.
 */
const CONVERSATION_ID_DESCRIPTION =
  'Conversation ID. Omit it (or pass "current") to address the conversation this call is happening inside; required from outside a chat.';

export const ConversationsGetInput = Type.Object({
  id: Type.Optional(Type.String({ description: CONVERSATION_ID_DESCRIPTION })),
  expand: Type.Optional(
    StringEnum(["metadata", "messages", "full"] as const, {
      description:
        'How much of the conversation to return. "metadata" returns just metadata (no messages). "messages" (default) returns metadata + the most recent `limit` messages, capped by a content-size guard. "full" returns every message — use only when you genuinely need the entire transcript; long conversations can run hundreds of thousands of tokens.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        'Max messages to return when expand is "messages" (the default mode). Counted from the end of the conversation. Default: 20. Ignored when expand is "metadata" or "full".',
    }),
  ),
});
export type ConversationsGetInput = Static<typeof ConversationsGetInput>;

export const ConversationsSearchInput = Type.Object(
  {
    query: Type.String({
      description: "Search query. Case-insensitive substring match on message content.",
    }),
    limit: Type.Optional(Type.Number({ description: "Max conversations to return. Default: 10." })),
  },
  { required: ["query"] },
);
export type ConversationsSearchInput = Static<typeof ConversationsSearchInput>;

export const ConversationsUpdateInput = Type.Object(
  {
    id: Type.Optional(Type.String({ description: CONVERSATION_ID_DESCRIPTION })),
    title: Type.String({ description: "New title for the conversation." }),
  },
  { required: ["title"] },
);
export type ConversationsUpdateInput = Static<typeof ConversationsUpdateInput>;

export const ConversationsForkInput = Type.Object({
  id: Type.Optional(
    Type.String({ description: `Source conversation. ${CONVERSATION_ID_DESCRIPTION}` }),
  ),
  atMessage: Type.Optional(
    Type.Number({ description: "Message index to fork at. Default: all messages." }),
  ),
});
export type ConversationsForkInput = Static<typeof ConversationsForkInput>;

export const ConversationsStatsInput = Type.Object({
  period: Type.Optional(
    StringEnum(["day", "week", "month", "all"] as const, {
      description: 'Time period for stats. Default: "week".',
    }),
  ),
});
export type ConversationsStatsInput = Static<typeof ConversationsStatsInput>;

export const ConversationsExportInput = Type.Object(
  {
    id: Type.Optional(Type.String({ description: CONVERSATION_ID_DESCRIPTION })),
    format: StringEnum(["markdown", "json"] as const, { description: "Export format." }),
  },
  { required: ["format"] },
);
export type ConversationsExportInput = Static<typeof ConversationsExportInput>;

// ── Output schemas ──────────────────────────────────────────────────────
//
// Each tool's result, published as its `outputSchema` (src/platform/AGENTS.md
// §2.1). The display shapes are declared here, where the handlers' outputs name
// them; `jsonl-reader.ts` builds them from stored conversation logs and
// re-exports them for its callers. A shape read from a log admits every value
// that log can hold, not only what the runtime writes today.

const NullableString = Type.Union([Type.String(), Type.Null()]);

/** A conversation as its header and events project it: the row `list`, `update` and `fork` describe. */
const ConversationSummaryFields = {
  id: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  messageCount: Type.Number(),
  totalInputTokens: Type.Number(),
  totalOutputTokens: Type.Number(),
  lastModel: NullableString,
  preview: Type.String({
    description: "The conversation's first user message, capped for the response.",
  }),
};

/** What `conversations__fork` returns: a summary of the new conversation. */
export const ConversationsForkOutput = Type.Object({
  ...ConversationSummaryFields,
  title: Type.Null({ description: "A fork starts untitled." }),
});
export type ConversationsForkOutput = Static<typeof ConversationsForkOutput>;

/** What `conversations__update` returns: the conversation as a reader now projects it. */
export const ConversationsUpdateOutput = Type.Object({
  ...ConversationSummaryFields,
  title: NullableString,
});
export type ConversationsUpdateOutput = Static<typeof ConversationsUpdateOutput>;

/** One row of `conversations__list`. */
export const ConversationListEntry = Type.Object({
  ...ConversationSummaryFields,
  title: NullableString,
  ownerId: Type.Union([Type.String(), Type.Null()], {
    description: "The conversation's owner; null when its header names none.",
  }),
  workspaceId: Type.String({
    description: "The workspace whose directory holds the conversation.",
  }),
  active: Type.Boolean({ description: "Whether a reply is generating for it right now." }),
});
export type ConversationListEntry = Static<typeof ConversationListEntry>;

/** What `conversations__list` returns: one page of the workspace's conversations. */
export const ConversationsListOutput = Type.Object({
  conversations: Type.Array(ConversationListEntry),
  nextCursor: Type.Union([Type.String(), Type.Null()], {
    description: "Pass as `cursor` for the next page; null on the last page.",
  }),
  totalCount: Type.Number(),
});
export type ConversationsListOutput = Static<typeof ConversationsListOutput>;

export const DisplayResourceLink = Type.Object({
  uri: Type.String(),
  name: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});
export type DisplayResourceLink = Static<typeof DisplayResourceLink>;

/**
 * MCP tool-result envelope — identical shape to what streaming emits, so the
 * UI consumes one type regardless of source. `content[0].text` is the tool's
 * text output; `isError` mirrors `!ok`.
 */
export const DisplayToolResult = Type.Object({
  content: Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
  structuredContent: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  isError: Type.Boolean(),
});
export type DisplayToolResult = Static<typeof DisplayToolResult>;

export const DisplayToolCall = Type.Object({
  id: Type.String(),
  name: Type.String({ description: 'Full tool name (may include "server__tool" prefix).' }),
  appName: Type.Optional(
    Type.String({ description: 'Server prefix from the name (before "__"), if any.' }),
  ),
  status: StringEnum(["done", "error"] as const, {
    description: "Terminal status — tool calls from history are never mid-flight.",
  }),
  ok: Type.Boolean(),
  ms: Type.Number(),
  input: Type.Record(Type.String(), Type.Unknown()),
  result: DisplayToolResult,
  resourceUri: Type.Optional(Type.String()),
  resourceLinks: Type.Optional(Type.Array(DisplayResourceLink)),
});
export type DisplayToolCall = Static<typeof DisplayToolCall>;

export const DisplayBlock = Type.Union([
  Type.Object({ type: StringEnum(["text"] as const), text: Type.String() }),
  Type.Object({ type: StringEnum(["reasoning"] as const), text: Type.String() }),
  Type.Object({ type: StringEnum(["tool"] as const), toolCalls: Type.Array(DisplayToolCall) }),
]);
export type DisplayBlock = Static<typeof DisplayBlock>;

export const DisplayUsage = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  /**
   * Cache-write and reasoning subtotals carried through so fork() can
   * round-trip them onto the new file. Losing them here means a forked
   * conversation would report lower cost than the original on cache-heavy or
   * reasoning-heavy turns.
   */
  cacheWriteTokens: Type.Optional(Type.Number()),
  reasoningTokens: Type.Optional(Type.Number()),
  model: Type.String({
    description: "Model of the last LLM call in the run (runs can switch models mid-turn).",
  }),
  llmMs: Type.Number(),
});
export type DisplayUsage = Static<typeof DisplayUsage>;

export const DisplayFile = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  mimeType: Type.String(),
  size: Type.Number(),
  extracted: Type.Boolean(),
});
export type DisplayFile = Static<typeof DisplayFile>;

/** One skill in a turn's `skills.loaded` telemetry, projected for display. */
export const DisplaySkill = Type.Object({
  id: Type.String(),
  name: Type.String({ description: "The skill's own name — safe to render directly." }),
  connector: Type.Optional(
    Type.String({ description: "The MCP server that published it; absent for filesystem skills." }),
  ),
  // A string, not an enum: the scope is read from the recorded event, and a
  // record keeps the vocabulary current when it was written (`bundle` and
  // `platform` name tiers that are `provided` and `org` today).
  scope: Type.String({
    description: 'Storage tier the skill loaded from: "org", "workspace", "user" or "provided".',
  }),
  tokens: Type.Number(),
  loadedBy: Type.String(),
  reason: Type.String(),
});
export type DisplaySkill = Static<typeof DisplaySkill>;

/** A turn's skills-loaded telemetry — the ledger line's data. */
export const DisplaySkillsContext = Type.Object({
  skills: Type.Array(DisplaySkill),
  totalTokens: Type.Number(),
});
export type DisplaySkillsContext = Static<typeof DisplaySkillsContext>;

/**
 * A single chat turn as it should be rendered. One per `user.message` event
 * and one per `run.start`→`run.done` span — never split per iteration.
 */
export const DisplayMessage = Type.Object({
  role: StringEnum(["user", "assistant"] as const),
  content: Type.String({ description: "Aggregated text across all text blocks." }),
  blocks: Type.Array(DisplayBlock, {
    description: "Ordered content blocks — the primary structure for rendering.",
  }),
  timestamp: Type.String(),
  userId: Type.Optional(Type.String()),
  toolCalls: Type.Optional(
    Type.Array(DisplayToolCall, { description: "All tool calls flattened out of blocks." }),
  ),
  /** Aggregate LLM usage for the whole turn; absent on user messages. */
  usage: Type.Optional(DisplayUsage),
  files: Type.Optional(Type.Array(DisplayFile)),
  /**
   * Non-"complete" run terminations bubble up here: a `run.done` stopReason
   * verbatim ("max_iterations", "cancelled", …), "error" for a `run.error`,
   * "interrupted" for a run with no terminal event.
   */
  stopReason: Type.Optional(Type.String()),
  /**
   * True when this assistant turn has no terminal event yet (no run.done /
   * run.error) and a run is live for the conversation — a partial disk
   * snapshot rather than a finished turn.
   */
  pending: Type.Optional(Type.Boolean()),
  /**
   * Skills the runtime composed into this turn's prompt (the `skills.loaded`
   * event for the run) — the Context Ledger's durable source. Absent when the
   * turn loaded none.
   */
  skillsLoaded: Type.Optional(DisplaySkillsContext),
});
export type DisplayMessage = Static<typeof DisplayMessage>;

/** Metadata `conversations__get` returns for a conversation. */
export const ConversationMetadata = Type.Object({
  id: Type.String(),
  title: NullableString,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  totalInputTokens: Type.Number(),
  totalOutputTokens: Type.Number(),
  lastModel: NullableString,
  model: Type.String({ description: "The model the conversation is bound to." }),
  ownerId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(
    Type.String({
      description:
        "The workspace the conversation is sealed to; absent when the record carries no stamp.",
    }),
  ),
});
export type ConversationMetadata = Static<typeof ConversationMetadata>;

/**
 * What `conversations__get` returns. `expand: "metadata"` sends no messages and
 * `expand: "full"` the whole transcript; the default sends the most recent
 * messages under a character budget, and says so when it dropped older ones.
 */
export const ConversationsGetOutput = Type.Object({
  metadata: ConversationMetadata,
  totalMessages: Type.Number(),
  truncated: Type.Optional(
    Type.Boolean({ description: "Present, and true, when older messages were dropped." }),
  ),
  droppedOlderMessages: Type.Optional(Type.Number()),
  truncationHint: Type.Optional(Type.String()),
  messages: Type.Array(DisplayMessage),
});
export type ConversationsGetOutput = Static<typeof ConversationsGetOutput>;

/** What `conversations__export` returns: the transcript as Markdown or as JSON text. */
export const ConversationsExportOutput = Type.Object({ content: Type.String() });
export type ConversationsExportOutput = Static<typeof ConversationsExportOutput>;

/** One conversation whose messages matched a `conversations__search` query. */
export const ConversationSearchResult = Type.Object({
  id: Type.String(),
  title: NullableString,
  matches: Type.Array(Type.Object({ snippet: Type.String() })),
});
export type ConversationSearchResult = Static<typeof ConversationSearchResult>;

/** What `conversations__search` returns. */
export const ConversationsSearchOutput = Type.Object({
  results: Type.Array(ConversationSearchResult),
  totalMatches: Type.Number(),
});
export type ConversationsSearchOutput = Static<typeof ConversationsSearchOutput>;

/** One model's share of a `conversations__stats` period. */
export const ConversationModelStats = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  conversations: Type.Number({ description: "Conversations with a turn on this model." }),
});
export type ConversationModelStats = Static<typeof ConversationModelStats>;

/** What `conversations__stats` returns: token usage for the period in the current workspace. */
export const ConversationsStatsOutput = Type.Object({
  period: Type.Object({
    since: Type.String({ description: 'ISO 8601 lower bound; "" for period "all".' }),
    until: Type.String(),
  }),
  totalConversations: Type.Number(),
  totalInputTokens: Type.Number(),
  totalOutputTokens: Type.Number(),
  byModel: Type.Record(Type.String(), ConversationModelStats, {
    description: "Usage keyed by model id.",
  }),
  topTools: Type.Array(Type.Object({ name: Type.String(), callCount: Type.Number() }), {
    description: "Tools by call count, most-called first.",
  }),
});
export type ConversationsStatsOutput = Static<typeof ConversationsStatsOutput>;
