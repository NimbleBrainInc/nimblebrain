/**
 * The records role's tool schemas: the TypeBox authoring source for
 * `schemas/records/*.json`.
 *
 * The emitted JSON is the published contract; this file is where it is
 * written. `scripts/emit-schemas.ts` turns it into JSON, and `--check` fails
 * when the committed JSON differs. Nothing at runtime imports this file.
 *
 * Scope (workspace and owner) is never an argument: it is carried by the
 * connection's authenticated context (CONTRACT.md, "Scope").
 */

import { type TSchema, Type } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const ConversationId = Type.String({ pattern: "^conv_[0-9a-f]{16}$" });

/** An event as stored: a timestamp, a type, and the fields its type defines. */
export const RecordsEvent = Type.Object(
  { ts: Type.String(), type: Type.String() },
  { additionalProperties: true },
);

export const RecordsConversation = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  title: Nullable(Type.String()),
  lastModel: Nullable(Type.String()),
  ownerId: Type.String(),
  workspaceId: Type.String(),
  model: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const RecordsSummary = Type.Object({
  id: Type.String(),
  title: Nullable(Type.String()),
  preview: Type.String(),
  createdAt: Type.String(),
  lastActivityAt: Type.String(),
  messageCount: Type.Integer(),
  usage: Type.Record(
    Type.String(),
    Type.Object({ inputTokens: Type.Number(), outputTokens: Type.Number() }),
  ),
});

export const RecordsSearchHit = Type.Object({
  id: Type.String(),
  title: Nullable(Type.String()),
  matches: Type.Array(Type.Object({ seq: Type.Integer(), snippet: Type.String() })),
});

const GetOutput = Type.Object({ conversation: Nullable(RecordsConversation) });

/** Every records tool: name → input and output schema. */
export const RECORDS_SCHEMAS = {
  create: {
    input: Type.Object({
      id: Type.Optional(ConversationId),
      model: Type.String({ minLength: 1 }),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    output: Type.Object({ conversation: RecordsConversation }),
  },
  get: {
    input: Type.Object({ id: Type.String() }),
    output: GetOutput,
  },
  events: {
    input: Type.Object({
      id: Type.String(),
      afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      throughSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    }),
    output: Type.Object({
      events: Type.Array(Type.Object({ seq: Type.Integer(), event: RecordsEvent })),
      lastSeq: Type.Integer(),
    }),
  },
  append_events: {
    input: Type.Object({ id: Type.String(), events: Type.Array(RecordsEvent) }),
    output: Type.Object({ lastSeq: Type.Integer() }),
  },
  update: {
    input: Type.Object({ id: Type.String(), title: Type.Optional(Type.String()) }),
    output: GetOutput,
  },
  delete: {
    input: Type.Object({ id: Type.String() }),
    output: Type.Object({ deleted: Type.Boolean() }),
  },
  delete_workspace: {
    input: Type.Object({}),
    output: Type.Object({
      deleted: Type.Array(Type.Object({ id: Type.String(), ownerId: Type.String() })),
    }),
  },
  list: {
    input: Type.Object({
      text: Type.Optional(Type.String()),
      updatedFrom: Type.Optional(Type.String()),
      updatedTo: Type.Optional(Type.String()),
      sort: Type.Optional(Type.Union([Type.Literal("updated"), Type.Literal("created")])),
      cursor: Type.Optional(Type.String()),
      limit: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
    output: Type.Object({
      items: Type.Array(RecordsSummary),
      nextCursor: Nullable(Type.String()),
      total: Type.Integer(),
    }),
  },
  search: {
    input: Type.Object({
      text: Type.String({ minLength: 1 }),
      cursor: Type.Optional(Type.String()),
      limit: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
    output: Type.Object({
      items: Type.Array(RecordsSearchHit),
      nextCursor: Nullable(Type.String()),
      total: Type.Integer(),
    }),
  },
} as const satisfies Record<string, { input: TSchema; output: TSchema }>;

export type RecordsToolName = keyof typeof RECORDS_SCHEMAS;

/** One-line descriptions a records server publishes in `tools/list`. */
export const RECORDS_DESCRIPTIONS: Record<RecordsToolName, string> = {
  create: "Create a conversation in the caller's scope. Refuses a taken id (conversation_exists).",
  get: "A conversation with its projected title, last model and last activity, or null.",
  events:
    "One page of events in seq order, after `afterSeq` and up to `throughSeq` (the snapshot " +
    "bound; every page returns the conversation's last seq as `lastSeq`).",
  append_events: "Append events in order, all or none; returns the last one's seq.",
  update: "Patch a conversation: a title is recorded as a metadata.title event.",
  delete: "Delete a conversation and its events.",
  delete_workspace:
    "Remove every owner's conversations in the caller's workspace (the scope's owner is " +
    "ignored). Idempotent. Returns what it removed.",
  list: "One page of the caller's conversations, newest first.",
  search: "The caller's conversations whose message text contains `text`.",
};
