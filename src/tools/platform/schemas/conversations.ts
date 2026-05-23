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
export type ConversationsListInput = Static<typeof ConversationsListInput>;

export const ConversationsGetInput = Type.Object(
  {
    id: Type.String({ description: "Conversation ID." }),
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
  },
  { required: ["id"] },
);
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
    id: Type.String({ description: "Conversation ID." }),
    title: Type.String({ description: "New title for the conversation." }),
  },
  { required: ["id", "title"] },
);
export type ConversationsUpdateInput = Static<typeof ConversationsUpdateInput>;

export const ConversationsForkInput = Type.Object(
  {
    id: Type.String({ description: "Source conversation ID." }),
    atMessage: Type.Optional(
      Type.Number({ description: "Message index to fork at. Default: all messages." }),
    ),
  },
  { required: ["id"] },
);
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
    id: Type.String({ description: "Conversation ID." }),
    format: StringEnum(["markdown", "json"] as const, { description: "Export format." }),
  },
  { required: ["id", "format"] },
);
export type ConversationsExportInput = Static<typeof ConversationsExportInput>;
