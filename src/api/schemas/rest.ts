// ---------------------------------------------------------------------------
// REST request schemas for /v1/* endpoints.
//
// Single source of truth for both runtime validation (TypeBox `Value.Check`
// at the route entry point) and the TypeScript types (Static<>) the handlers
// consume. REST is first-party, but a type-only request contract can still
// drift from what a client sends, so request shapes are checked at runtime.
//
// Response bodies are type-only and live in `responses.ts`, which imports
// nothing so the web codegen can emit it alone.
//
// This module covers `/v1/workspaces/:wsId/tools/call` and
// `/v1/workspaces/:wsId/chat`. The other routes parse their small bodies by
// hand; a new route with a JSON body declares its schema here.
// ---------------------------------------------------------------------------

import { type Static, Type } from "@sinclair/typebox";
import { CONVERSATION_ID_RE } from "../../conversation/types.ts";

// ── /v1/workspaces/:wsId/tools/call ─────────────────────────────────────────

export const ToolCallRequestEnvelope = Type.Object(
  {
    server: Type.String({
      description: "Tool source name (e.g. `skills`, `home`, `tasks`).",
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

// ── /v1/workspaces/:wsId/chat ───────────────────────────────────────────────

const ContentPart = Type.Object({ type: Type.String() }, { additionalProperties: true });

const FileReference = Type.Object({ id: Type.String() }, { additionalProperties: true });

/**
 * JSON body schema for `/v1/workspaces/:wsId/chat` and `/v1/workspaces/:wsId/chat/stream`. Multipart form
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
      Type.String({
        // Constrain to the canonical `conv_<16 hex>` shape at the schema
        // boundary so a malformed id (e.g. a path-traversal probe like
        // `../../foo`) is a 400 at every JSON chat surface, rather than
        // bubbling a raw Error out of `validateConversationId` → 500. The
        // multipart path validates the same regex in parseMultipartChatBody.
        pattern: CONVERSATION_ID_RE.source,
        description: "Existing conversation id; omit to start a new one.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: "Model override; omit to use the workspace default." }),
    ),
    maxIterations: Type.Optional(Type.Number()),
    workspaceId: Type.Optional(
      Type.String({
        description:
          "DEPRECATED and ignored (kept for client compatibility). The workspace is the one in the URL, /v1/workspaces/<wsId>/chat; it scopes the tools and the prompt briefing (installed apps + house rules). Per-tool-call workspace attribution lives on each tool.done event's `workspaceId` field.",
      }),
    ),
    appContext: Type.Optional(
      // Mirrors `AppContext` in `src/runtime/types.ts`. `appState` is the
      // UI state pushed by the app via Synapse `updateModelContext()` —
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
