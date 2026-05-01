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
// Migration policy: opportunistic. Endpoints get schemas when they're
// touched, not in a sweep. The two we ship here (/v1/tools/call envelope
// + /v1/chat JSON body) cover the highest-traffic surfaces.
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
      Type.Object({
        appName: Type.String(),
        serverName: Type.String(),
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
