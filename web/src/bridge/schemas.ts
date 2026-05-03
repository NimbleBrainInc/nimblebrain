// ---------------------------------------------------------------------------
// MCP App Bridge — postMessage protocol schemas
//
// JSON-RPC 2.0 envelopes between the host (web shell) and app iframes.
// Single source of truth for both runtime shape (Value.Check at the iframe
// trust boundary) and TypeScript types (Static<>).
//
// Trust boundary policy:
//   - App→Host messages cross from sandboxed third-party iframe code
//     (Synapse apps, Reboot prototypes) into the host. These are runtime-
//     validated via `validateAppToHostMessage()` in bridge.ts.
//   - Host→App messages are emitted by code we own. Schemas exist for
//     the type-derivation win; no runtime validation is applied because
//     there's no untrusted source.
//
// `additionalProperties` policy: schemas in this file do NOT set
// `additionalProperties: false`. The host's per-message handlers in
// bridge.ts read only the documented fields; extra fields from a buggy
// or hostile iframe are ignored, not propagated. Validation here checks
// "the documented fields are well-formed," not "no extras present." If
// you need to forbid extras for a specific envelope, add the constraint
// explicitly on that envelope's `params` object — don't tighten this
// file as a whole, since the relaxation on `ui/initialize` (clientInfo
// + capabilities optional) is deliberate and matches existing-bridge
// behavior.
//
// Spec methods use the `ui/` and `tools/` prefixes (ext-apps spec
// 2026-01-26). NimbleBrain extensions use the `synapse/` prefix.
// ---------------------------------------------------------------------------

import { type Static, Type } from "@sinclair/typebox";

// ── Shared building blocks ───────────────────────────────────────────────

const JsonRpcVersion = Type.Literal("2.0");

/** Loose record used in `arguments`, `_meta`, etc. — caller-defined shape. */
const UnknownRecord = Type.Record(Type.String(), Type.Unknown());

/** Empty params shape (`Record<string, never>` in the legacy interfaces). */
const EmptyParams = Type.Object({}, { additionalProperties: false });

/**
 * JSON-RPC 2.0 request id. Per spec § 4: "An identifier established by
 * the Client that MUST contain a String, Number, or NULL value if
 * included." The MCP SDK's `RequestId` (`@modelcontextprotocol/sdk/types`)
 * is `string | number`. ext-apps clients built on
 * `@reboot-dev/reboot-react` use numeric ids starting at 0; the iframe
 * boundary cannot dictate caller id shape.
 *
 * Response envelopes (Host → App) echo whichever shape the request used,
 * so they take the same union — narrowing the response side to string
 * would force-coerce numeric requests to string responses, breaking
 * id correlation in clients that compare strictly.
 */
const RequestId = Type.Union([Type.String(), Type.Number()]);

const ContentItem = Type.Object(
  {
    type: Type.String(),
    text: Type.Optional(Type.String()),
    _meta: Type.Optional(UnknownRecord),
  },
  { additionalProperties: true },
);

const ToolResultContent = Type.Object(
  {
    type: Type.String(),
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

// ── App → Host messages (ext-apps spec) ──────────────────────────────────

export const ToolsCallMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("tools/call"),
  id: RequestId,
  params: Type.Object({
    name: Type.String(),
    arguments: Type.Optional(UnknownRecord),
  }),
});
export type ToolsCallMessage = Static<typeof ToolsCallMessage>;

export const ResourcesReadMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("resources/read"),
  id: RequestId,
  params: Type.Object({
    uri: Type.String(),
    server: Type.Optional(Type.String()),
  }),
});
export type ResourcesReadMessage = Static<typeof ResourcesReadMessage>;

export const UiMessageMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/message"),
  id: Type.Optional(Type.String()),
  params: Type.Object({
    role: Type.Optional(Type.Literal("user")),
    content: Type.Optional(Type.Array(ContentItem)),
    action: Type.Optional(Type.Literal("prompt")),
    value: Type.Optional(Type.String()),
  }),
});
export type UiMessageMessage = Static<typeof UiMessageMessage>;

export const UiOpenLinkMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/open-link"),
  id: Type.Optional(Type.String()),
  params: Type.Object({ url: Type.String() }),
});
export type UiOpenLinkMessage = Static<typeof UiOpenLinkMessage>;

export const UiSizeChangedMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/size-changed"),
  id: Type.Optional(Type.String()),
  params: Type.Object({
    width: Type.Optional(Type.Number()),
    height: Type.Number(),
  }),
});
export type UiSizeChangedMessage = Static<typeof UiSizeChangedMessage>;

export const UiUpdateModelContextMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  method: Type.Literal("ui/update-model-context"),
  params: Type.Object({
    content: Type.Optional(
      Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
    ),
    structuredContent: Type.Optional(UnknownRecord),
  }),
});
export type UiUpdateModelContextMessage = Static<typeof UiUpdateModelContextMessage>;

export const ExtAppsInitializeRequest = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  method: Type.Literal("ui/initialize"),
  // `clientInfo` and `capabilities` are spec-required, but the existing
  // bridge accepts ui/initialize regardless of params shape — relaxing
  // here to match real-world behavior. Tightening to spec-strict is a
  // separate decision that should account for in-flight clients.
  params: Type.Object({
    protocolVersion: Type.String(),
    clientInfo: Type.Optional(Type.Object({ name: Type.String(), version: Type.String() })),
    capabilities: Type.Optional(UnknownRecord),
  }),
});
export type ExtAppsInitializeRequest = Static<typeof ExtAppsInitializeRequest>;

export const ExtAppsInitializedNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/initialized"),
  params: EmptyParams,
});
export type ExtAppsInitializedNotification = Static<typeof ExtAppsInitializedNotification>;

export const ExtAppsRequestTeardownNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/request-teardown"),
  params: EmptyParams,
});
export type ExtAppsRequestTeardownNotification = Static<typeof ExtAppsRequestTeardownNotification>;

// ── App → Host messages (NimbleBrain extensions) ─────────────────────────

export const UiActionMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/action"),
  id: Type.Optional(Type.String()),
  params: Type.Intersect([
    Type.Object({ action: Type.String() }),
    Type.Record(Type.String(), Type.Unknown()),
  ]),
});
export type UiActionMessage = Static<typeof UiActionMessage>;

export const UiDownloadFileMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/download-file"),
  id: Type.Optional(Type.String()),
  // `data: Blob` doesn't have a TypeBox literal; postMessage uses structured
  // clone so any Object passes wire-shape muster. Validate the surrounding
  // envelope; trust the value.
  params: Type.Object({
    data: Type.Unknown(),
    filename: Type.String(),
    mimeType: Type.String(),
  }),
});
export type UiDownloadFileMessage = Static<typeof UiDownloadFileMessage> & {
  params: { data: Blob; filename: string; mimeType: string };
};

export const UiPersistStateMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/persist-state"),
  id: RequestId,
  params: Type.Object({
    state: UnknownRecord,
    version: Type.Optional(Type.Number()),
  }),
});
export type UiPersistStateMessage = Static<typeof UiPersistStateMessage>;

export const SynapseRequestFileMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/request-file"),
  id: RequestId,
  params: Type.Object({
    accept: Type.Optional(Type.String()),
    maxSize: Type.Optional(Type.Number()),
    multiple: Type.Optional(Type.Boolean()),
  }),
});
export type SynapseRequestFileMessage = Static<typeof SynapseRequestFileMessage>;

export const UiKeydownMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/keydown"),
  params: Type.Object({
    key: Type.String(),
    ctrlKey: Type.Boolean(),
    metaKey: Type.Boolean(),
    shiftKey: Type.Boolean(),
    altKey: Type.Boolean(),
  }),
});
export type UiKeydownMessage = Static<typeof UiKeydownMessage>;

/** Discriminated union of every App → Host envelope. */
export const AppToHostMessage = Type.Union([
  ToolsCallMessage,
  ResourcesReadMessage,
  UiMessageMessage,
  UiOpenLinkMessage,
  UiSizeChangedMessage,
  UiUpdateModelContextMessage,
  UiActionMessage,
  UiDownloadFileMessage,
  UiPersistStateMessage,
  SynapseRequestFileMessage,
  UiKeydownMessage,
  ExtAppsInitializeRequest,
  ExtAppsInitializedNotification,
  ExtAppsRequestTeardownNotification,
]);
export type AppToHostMessage = Static<typeof AppToHostMessage>;

// ── Host → App messages (ext-apps spec) ──────────────────────────────────

export const UiInitializeMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/initialize"),
  params: Type.Object({
    capabilities: Type.Object({
      tools: Type.Boolean(),
      messages: Type.Boolean(),
      links: Type.Boolean(),
      downloads: Type.Boolean(),
    }),
    theme: Type.Object({
      mode: Type.Union([Type.Literal("light"), Type.Literal("dark")]),
      primaryColor: Type.String(),
      tokens: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    apiBase: Type.Optional(Type.String()),
    appName: Type.Optional(Type.String()),
  }),
});
export type UiInitializeMessage = Static<typeof UiInitializeMessage>;

export const UiResourceResultResponse = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  result: Type.Object({
    contents: Type.Array(
      Type.Object({
        uri: Type.String(),
        mimeType: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        blob: Type.Optional(Type.String()),
      }),
    ),
  }),
});
export type UiResourceResultResponse = Static<typeof UiResourceResultResponse>;

export const UiResourceResultError = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  error: Type.Object({ code: Type.Number(), message: Type.String() }),
});
export type UiResourceResultError = Static<typeof UiResourceResultError>;

export const UiToolResultResponse = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  result: Type.Object({
    content: Type.Array(ToolResultContent),
    structuredContent: Type.Optional(UnknownRecord),
  }),
});
export type UiToolResultResponse = Static<typeof UiToolResultResponse>;

export const UiToolResultError = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  error: Type.Object({ code: Type.Number(), message: Type.String() }),
});
export type UiToolResultError = Static<typeof UiToolResultError>;

export const UiToolResultMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/tool-result"),
  params: Type.Object({
    content: Type.Array(ToolResultContent),
    structuredContent: Type.Optional(UnknownRecord),
  }),
});
export type UiToolResultMessage = Static<typeof UiToolResultMessage>;

export const ExtAppsInitializeResponse = Type.Object({
  jsonrpc: JsonRpcVersion,
  id: RequestId,
  result: Type.Object({
    protocolVersion: Type.String(),
    hostInfo: Type.Object({ name: Type.String(), version: Type.String() }),
    hostCapabilities: UnknownRecord,
    hostContext: Type.Optional(
      Type.Intersect([
        Type.Object({
          theme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])),
          styles: Type.Optional(
            Type.Object({
              variables: Type.Optional(Type.Record(Type.String(), Type.String())),
            }),
          ),
        }),
        Type.Record(Type.String(), Type.Unknown()),
      ]),
    ),
  }),
});
export type ExtAppsInitializeResponse = Static<typeof ExtAppsInitializeResponse>;

export const ExtAppsToolInputNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/tool-input"),
  params: Type.Object({ arguments: UnknownRecord }),
});
export type ExtAppsToolInputNotification = Static<typeof ExtAppsToolInputNotification>;

export const ExtAppsToolResultNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/tool-result"),
  params: Type.Object({
    content: Type.Array(ToolResultContent),
    structuredContent: Type.Optional(UnknownRecord),
  }),
});
export type ExtAppsToolResultNotification = Static<typeof ExtAppsToolResultNotification>;

export const ExtAppsHostContextChangedNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/host-context-changed"),
  params: UnknownRecord,
});
export type ExtAppsHostContextChangedNotification = Static<
  typeof ExtAppsHostContextChangedNotification
>;

// ── Host → App messages (NimbleBrain extensions) ─────────────────────────

export const UiDataChangedMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/data-changed"),
  params: Type.Object({
    source: Type.Literal("agent"),
    server: Type.String(),
    tool: Type.String(),
  }),
});
export type UiDataChangedMessage = Static<typeof UiDataChangedMessage>;

export const UiStateLoadedMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/state-loaded"),
  params: Type.Object({
    state: Type.Union([UnknownRecord, Type.Null()]),
    version: Type.Optional(Type.Number()),
  }),
});
export type UiStateLoadedMessage = Static<typeof UiStateLoadedMessage>;

/** Discriminated union of every Host → App envelope. */
export const HostToAppMessage = Type.Union([
  UiInitializeMessage,
  UiToolResultResponse,
  UiToolResultError,
  UiToolResultMessage,
  UiResourceResultResponse,
  UiResourceResultError,
  UiDataChangedMessage,
  UiStateLoadedMessage,
  ExtAppsInitializeResponse,
  ExtAppsToolInputNotification,
  ExtAppsToolResultNotification,
  ExtAppsHostContextChangedNotification,
]);
export type HostToAppMessage = Static<typeof HostToAppMessage>;
