/**
 * The private tools' schemas: the TypeBox authoring source for the `$defs`
 * entries of every tool `contract.ts` marks private.
 *
 * The emitted document (`schemas/contracts/conversations/v1/contract.json`) is
 * the published contract; this file is where those schemas are written.
 * `scripts/emit-contract.ts` turns it into JSON, and `--check` fails when the
 * committed document differs. Nothing at runtime imports this file. The public
 * tools are authored beside today's tools, in
 * `src/platform/schemas/conversations.ts`.
 *
 * Scope (workspace and owner) and principal are never arguments: they are
 * carried by the call's authenticated context (CONTRACT.md, "Scope and
 * principal").
 */

import { type TSchema, Type } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const ConversationId = Type.String({ pattern: "^conv_[0-9a-f]{16}$" });

/** An event as stored: a timestamp, a type, and the fields its type defines. */
export const StoredEvent = Type.Object(
  { ts: Type.String(), type: Type.String() },
  { additionalProperties: true },
);

/** A conversation as `create` answers it. */
export const CreatedConversation = Type.Object({
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

/** Every private tool: name → input and output schema. */
export const PRIVATE_SCHEMAS = {
  create: {
    input: Type.Object({
      id: Type.Optional(ConversationId),
      model: Type.String({ minLength: 1 }),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    output: Type.Object({ conversation: CreatedConversation }),
  },
  events: {
    input: Type.Object({
      id: Type.String(),
      afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      throughSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    }),
    output: Type.Object({
      events: Type.Array(Type.Object({ seq: Type.Integer(), event: StoredEvent })),
      lastSeq: Type.Integer(),
    }),
  },
  append_events: {
    input: Type.Object({ id: Type.String(), events: Type.Array(StoredEvent) }),
    output: Type.Object({ lastSeq: Type.Integer() }),
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
} as const satisfies Record<string, { input: TSchema; output: TSchema }>;

export type PrivateToolName = keyof typeof PRIVATE_SCHEMAS;

/** One-line descriptions a server publishes for its private tools in `tools/list`. */
export const PRIVATE_DESCRIPTIONS: Record<PrivateToolName, string> = {
  create: "Create a conversation in the caller's scope. Refuses a taken id (conversation_exists).",
  events:
    "One page of events in seq order, after `afterSeq` and up to `throughSeq` (the snapshot " +
    "bound; every page returns the conversation's last seq as `lastSeq`).",
  append_events: "Append events in order, all or none; returns the last one's seq.",
  delete: "Delete a conversation and its events.",
  delete_workspace:
    "Purge every owner's conversations in the caller's workspace, and any storage held for " +
    "it (the scope's owner is ignored). Idempotent. Returns what it removed.",
};
