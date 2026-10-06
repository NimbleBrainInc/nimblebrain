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

// ── Output types ────────────────────────────────────────────────────────
//
// The display shapes are declared here, where the handlers' outputs name
// them; `jsonl-reader.ts` builds them and re-exports them for its callers.

/** What `conversations__fork` returns: a summary of the new conversation. */
export interface ConversationsForkOutput {
  id: string;
  title: null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  preview: string;
}

/**
 * A single chat turn as it should be rendered. One per `user.message` event
 * and one per `run.start`→`run.done` span — never split per iteration.
 */
export interface DisplayMessage {
  role: "user" | "assistant";
  /** Aggregated text across all text blocks (convenient for copy/title). */
  content: string;
  /** Ordered content blocks — the primary structure for rendering. */
  blocks: DisplayBlock[];
  timestamp: string;
  userId?: string;
  /** All tool calls flattened out of blocks — derived, for consumers that scan them. */
  toolCalls?: DisplayToolCall[];
  /** Aggregate LLM usage for the whole turn; undefined for user messages. */
  usage?: DisplayUsage;
  files?: DisplayFile[];
  /**
   * Non-"complete" run terminations bubble up here: a `run.done` stopReason
   * verbatim ("max_iterations", "cancelled", …), "error" for a `run.error`,
   * "interrupted" for a run with no terminal event.
   */
  stopReason?: string;
  /**
   * True when this assistant turn has no terminal event yet (no run.done /
   * run.error) — i.e. the run was still in flight when the file was read. Lets
   * a live viewer tell a partial disk snapshot from a finished turn and decide
   * whether to reconcile against the server's replay.
   */
  pending?: boolean;
  /**
   * Skills the runtime composed into this turn's prompt (the `skills.loaded`
   * event for the run) — the Context Ledger's durable source. The live stream
   * carries the same payload for an in-flight turn; this is how a reopened
   * conversation re-derives the ledger line. Absent when the turn loaded none.
   */
  skillsLoaded?: DisplaySkillsContext;
}

/** One skill in a turn's `skills.loaded` telemetry, projected for display. */
export interface DisplaySkill {
  id: string;
  /** The skill's own name — resolved here, safe to render directly. */
  name: string;
  /** The MCP server that published it; absent for filesystem skills. */
  connector?: string;
  scope: "org" | "workspace" | "user" | "provided";
  tokens: number;
  loadedBy: string;
  reason: string;
}

/** A turn's skills-loaded telemetry — the ledger line's data. */
export interface DisplaySkillsContext {
  skills: DisplaySkill[];
  totalTokens: number;
}

export type DisplayBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; toolCalls: DisplayToolCall[] };

export interface DisplayToolCall {
  id: string;
  /** Full tool name (may include "server__tool" prefix). */
  name: string;
  /** Server prefix from the name (before "__"), if any — convenience for routing. */
  appName?: string;
  /** Terminal status — tool calls from history are never mid-flight. */
  status: "done" | "error";
  ok: boolean;
  ms: number;
  input: Record<string, unknown>;
  /**
   * MCP tool-result envelope — identical shape to what streaming emits, so the
   * UI consumes one type regardless of source. `content[0].text` is the tool's
   * text output; `isError` mirrors `!ok`.
   */
  result: DisplayToolResult;
  resourceUri?: string;
  resourceLinks?: DisplayResourceLink[];
}

export interface DisplayToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

export interface DisplayResourceLink {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface DisplayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /**
   * Cache-write and reasoning subtotals carried through so fork() can
   * round-trip them onto the new file. The chat UI doesn't currently
   * render these per-message, but losing them here means a forked
   * conversation would silently report lower cost than the original on
   * cache-heavy or reasoning-heavy turns.
   */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Model of the last LLM call in the run (runs can switch models mid-turn). */
  model: string;
  llmMs: number;
}

export interface DisplayFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
}

/** Metadata `conversations__get` returns for a conversation. */
export interface ConversationMetadata {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  /** The model the conversation is bound to. */
  model: string;
  ownerId?: string;
  /** The workspace the conversation is sealed to; absent when the record carries no stamp. */
  workspaceId?: string;
}

/**
 * What `conversations__get` returns. `expand: "metadata"` sends no messages and
 * `expand: "full"` the whole transcript; the default sends the most recent
 * messages under a character budget, and says so when it dropped older ones.
 */
export interface ConversationsGetOutput {
  metadata: ConversationMetadata;
  totalMessages: number;
  messages: DisplayMessage[];
  truncated?: true;
  droppedOlderMessages?: number;
  truncationHint?: string;
}

/** What `conversations__update` returns: the conversation as a reader now projects it. */
export interface ConversationsUpdateOutput {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  preview: string;
}

/** What `conversations__export` returns: the transcript as Markdown or as JSON text. */
export interface ConversationsExportOutput {
  content: string;
}

/** One conversation whose messages matched a `conversations__search` query. */
export interface ConversationSearchResult {
  id: string;
  title: string | null;
  matches: Array<{ snippet: string }>;
}

/** What `conversations__search` returns. */
export interface ConversationsSearchOutput {
  results: ConversationSearchResult[];
  totalMatches: number;
}
