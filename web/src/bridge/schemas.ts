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

/**
 * Empty params, and **optional**, because JSON-RPC 2.0 § 4.2 makes `params`
 * optional and the spec's own client omits the key entirely when it has
 * nothing to send. Requiring it drops the notification: the bridge validates
 * before it dispatches, so a spec-correct app's `initialized` never reaches
 * `onInitialized` and an inline view is left waiting for a tool result that
 * is never delivered.
 */
const EmptyParams = Type.Optional(Type.Object({}, { additionalProperties: false }));

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
    _meta: Type.Optional(UnknownRecord),
  }),
});
export type ToolsCallMessage = Static<typeof ToolsCallMessage>;

export const ResourcesReadMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("resources/read"),
  id: RequestId,
  params: Type.Object({
    uri: Type.String(),
    _meta: Type.Optional(UnknownRecord),
  }),
});
export type ResourcesReadMessage = Static<typeof ResourcesReadMessage>;

/**
 * `resources/list` and `resources/templates/list`, answered from the app's own
 * server — the listings `serverResources` promises.
 */
const ResourceListingParams = Type.Optional(
  Type.Object({
    cursor: Type.Optional(Type.String()),
    _meta: Type.Optional(UnknownRecord),
  }),
);

export const ResourcesListMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("resources/list"),
  id: RequestId,
  params: ResourceListingParams,
});
export type ResourcesListMessage = Static<typeof ResourcesListMessage>;

export const ResourceTemplatesListMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("resources/templates/list"),
  id: RequestId,
  params: ResourceListingParams,
});
export type ResourceTemplatesListMessage = Static<typeof ResourceTemplatesListMessage>;

export const UiMessageMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/message"),
  id: Type.Optional(RequestId),
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
  id: Type.Optional(RequestId),
  params: Type.Object({ url: Type.String() }),
});
export type UiOpenLinkMessage = Static<typeof UiOpenLinkMessage>;

export const UiSizeChangedMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/notifications/size-changed"),
  id: Type.Optional(RequestId),
  params: Type.Object({
    width: Type.Optional(Type.Number()),
    height: Type.Number(),
  }),
});
export type UiSizeChangedMessage = Static<typeof UiSizeChangedMessage>;

export const UiUpdateModelContextMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  // `id` is optional. The spec defines this as a request, and the
  // @nimblebrain/synapse SDK sends it with an `id` and waits for the answer;
  // the dispatcher in `bridge.ts` answers only when an `id` is present. A
  // client that sends it as a notification (no `id`) is still accepted, so
  // requiring `id` would drop that client's model-context pushes.
  id: Type.Optional(RequestId),
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
  id: Type.Optional(RequestId),
  params: Type.Intersect([
    Type.Object({ action: Type.String() }),
    Type.Record(Type.String(), Type.Unknown()),
  ]),
});
export type UiActionMessage = Static<typeof UiActionMessage>;

export const UiDownloadFileMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("synapse/download-file"),
  id: Type.Optional(RequestId),
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

/**
 * Spec `ui/download-file` — the standard way an app hands the user a file.
 *
 * `contents` carries MCP resource blocks: an `EmbeddedResource` (inline
 * `text` or base64 `blob`) or a `ResourceLink` the host is expected to fetch.
 * The blocks are typed loosely here for the same reason the rest of this file
 * is: the host reads only the documented fields, and a hostile iframe's extras
 * are ignored rather than propagated.
 *
 * Distinct from the `synapse/download-file` extension above, which predates
 * this and takes an already-materialised `Blob`.
 */
export const UiDownloadFileSpecMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/download-file"),
  id: RequestId,
  params: Type.Object({
    contents: Type.Array(
      Type.Object(
        {
          type: Type.String(),
          uri: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          mimeType: Type.Optional(Type.String()),
          resource: Type.Optional(UnknownRecord),
        },
        { additionalProperties: true },
      ),
    ),
  }),
});
export type UiDownloadFileSpecMessage = Static<typeof UiDownloadFileSpecMessage>;

/**
 * Spec `ui/request-display-mode` — an app asking to be shown differently.
 *
 * The host decides placement from its own layout and does not hand that
 * decision to an app, so this is always answered with the mode actually in
 * effect. The result field is `mode`, not an acknowledgement, precisely so a
 * host can decline: a correct app reads what came back rather than assuming
 * its request was granted.
 */
export const UiRequestDisplayModeMessage = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("ui/request-display-mode"),
  id: RequestId,
  params: Type.Object({
    mode: Type.Union([Type.Literal("inline"), Type.Literal("fullscreen"), Type.Literal("pip")]),
  }),
});
export type UiRequestDisplayModeMessage = Static<typeof UiRequestDisplayModeMessage>;

/**
 * Spec `notifications/message` — an app's log line, for the host's console.
 *
 * A notification, so there is no id and nothing to answer. The host already
 * advertises the `logging` capability; without a handler for this, everything
 * an app logged went nowhere.
 */
export const LoggingMessageNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.Literal("notifications/message"),
  params: Type.Object({
    level: Type.String(),
    logger: Type.Optional(Type.String()),
    data: Type.Optional(Type.Unknown()),
  }),
});
export type LoggingMessageNotification = Static<typeof LoggingMessageNotification>;

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
  ResourcesListMessage,
  ResourceTemplatesListMessage,
  UiMessageMessage,
  UiOpenLinkMessage,
  UiSizeChangedMessage,
  UiUpdateModelContextMessage,
  UiActionMessage,
  UiDownloadFileMessage,
  UiDownloadFileSpecMessage,
  UiRequestDisplayModeMessage,
  LoggingMessageNotification,
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

/**
 * An app server's own notification, relayed verbatim to its views — one of
 * `RELAYED_TO_VIEWS` (relayed-notifications.ts). The ext-apps spec defines this
 * forwarding per host capability (`serverResources.listChanged`, …), which
 * `ui/initialize` advertises for exactly the relayed methods.
 */
export const RelayedServerNotification = Type.Object({
  jsonrpc: JsonRpcVersion,
  method: Type.String(),
  params: Type.Optional(UnknownRecord),
});
export type RelayedServerNotification = Static<typeof RelayedServerNotification>;

// ── Host → App messages (NimbleBrain extensions) ─────────────────────────

/** Discriminated union of every Host → App envelope. */
export const HostToAppMessage = Type.Union([
  UiInitializeMessage,
  UiToolResultResponse,
  UiToolResultError,
  UiToolResultMessage,
  UiResourceResultResponse,
  UiResourceResultError,
  ExtAppsInitializeResponse,
  ExtAppsToolInputNotification,
  ExtAppsToolResultNotification,
  ExtAppsHostContextChangedNotification,
  RelayedServerNotification,
]);
export type HostToAppMessage = Static<typeof HostToAppMessage>;
