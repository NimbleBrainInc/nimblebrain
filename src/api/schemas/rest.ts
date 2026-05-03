// ---------------------------------------------------------------------------
// REST request/response schemas for /v1/* endpoints.
//
// Single source of truth for both runtime validation (TypeBox `Value.Check`
// at the route entry point) and TypeScript types (Static<>) that the
// handlers and the web client consume.
//
// Trust boundary policy: REST is first-party only — same team controls
// both ends. We still validate request shapes at runtime because the
// SkillsTab incident showed type-only contracts can drift silently.
// Response shapes are type-only (no runtime check) — we generate them,
// we trust them.
//
// Migration scope: this module covers `/v1/tools/call` and `/v1/chat`
// only — the highest-traffic endpoints. The remaining REST routes
// (`/v1/auth/*`, `/v1/bootstrap`, `/v1/events`, `/v1/resources/*`,
// `/v1/shell`, `/v1/files/*`, `/v1/apps/*`, well-known, mcp internals)
// are tracked in #163 for a follow-up PR. Until then they continue to
// use hand-rolled shape checks; do not add new routes that follow that
// pattern — add them here.
// ---------------------------------------------------------------------------

import { type Static, Type } from "@sinclair/typebox";

// ── /v1/tools/call ───────────────────────────────────────────────────────

export const ToolCallRequestEnvelope = Type.Object(
  {
    server: Type.String({
      description: "Tool source name (e.g. `skills`, `home`, `automations`).",
    }),
    tool: Type.String({
      description:
        "Tool name. May be bare (`create`) or fully qualified (`skills__create`); both forms are accepted.",
    }),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Arguments to pass to the tool. Validated against the tool's own input schema once the tool is resolved.",
      }),
    ),
  },
  { required: ["server", "tool"] },
);
export type ToolCallRequestEnvelope = Static<typeof ToolCallRequestEnvelope>;

// ── /v1/chat ─────────────────────────────────────────────────────────────

const ContentPart = Type.Object({ type: Type.String() }, { additionalProperties: true });

const FileReference = Type.Object({ id: Type.String() }, { additionalProperties: true });

/**
 * JSON body schema for `/v1/chat` and `/v1/chat/stream`. Multipart form
 * uploads have their own parse path (parseMultipartChatBody) and don't
 * go through this schema.
 *
 * `identity` is set by middleware after schema validation, so it's not
 * in the request envelope. `contentParts` and `fileRefs` come from the
 * multipart path; the JSON shape here is the simple text-only case.
 */
export const ChatRequestBody = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      description: "The user's message. Must be non-empty.",
    }),
    conversationId: Type.Optional(
      Type.String({ description: "Existing conversation id; omit to start a new one." }),
    ),
    model: Type.Optional(
      Type.String({ description: "Model override; omit to use the workspace default." }),
    ),
    maxIterations: Type.Optional(Type.Number()),
    workspaceId: Type.Optional(
      Type.String({
        description: "Workspace id; takes precedence over the X-Workspace-Id header when both set.",
      }),
    ),
    appContext: Type.Optional(
      // Mirrors `AppContext` in `src/runtime/types.ts`. `appState` is the
      // UI state pushed by the app via Synapse `setVisibleState()` —
      // optional, but when present the web enriches the request with it
      // (see `web/src/hooks/useChat.ts`). Schema must include it so the
      // derived TS type doesn't silently strip it from `parsed.appContext`.
      Type.Object({
        appName: Type.String(),
        serverName: Type.String(),
        appState: Type.Optional(
          Type.Object({
            state: Type.Record(Type.String(), Type.Unknown()),
            summary: Type.Optional(Type.String()),
            updatedAt: Type.String(),
          }),
        ),
      }),
    ),
    contentParts: Type.Optional(Type.Array(ContentPart)),
    fileRefs: Type.Optional(Type.Array(FileReference)),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Arbitrary metadata stored in the conversation's first JSONL line.",
      }),
    ),
    allowedTools: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Glob patterns filtering which tools are available. Same matching rules as skill allowed-tools.",
      }),
    ),
  },
  { required: ["message"] },
);
export type ChatRequestBody = Static<typeof ChatRequestBody>;
