// ---------------------------------------------------------------------------
// MCP App Bridge — host-side callback types + re-exports of wire envelopes.
//
// Wire-envelope types are derived from TypeBox schemas in `./schemas` —
// single source of truth for both runtime validation (Value.Check at the
// iframe trust boundary) and TypeScript types (Static<>). See `./schemas.ts`
// for the trust-boundary policy and the canonical envelope shapes.
//
// Non-envelope types (BridgeCallbacks, UiChatContext) live here because
// they describe the host's API to its callers, not a wire shape that
// crosses a trust boundary.
// ---------------------------------------------------------------------------

export type {
  // App → Host envelopes
  AppToHostMessage,
  ExtAppsInitializedNotification,
  ExtAppsInitializeRequest,
  ExtAppsRequestTeardownNotification,
  ResourcesReadMessage,
  SynapseRequestFileMessage,
  ToolsCallMessage,
  UiActionMessage,
  UiDownloadFileMessage,
  UiKeydownMessage,
  UiMessageMessage,
  UiOpenLinkMessage,
  UiPersistStateMessage,
  UiSizeChangedMessage,
  UiUpdateModelContextMessage,
  // Host → App envelopes
  ExtAppsHostContextChangedNotification,
  ExtAppsInitializeResponse,
  ExtAppsToolInputNotification,
  ExtAppsToolResultNotification,
  HostToAppMessage,
  UiDataChangedMessage,
  UiInitializeMessage,
  UiResourceResultError,
  UiResourceResultResponse,
  UiStateLoadedMessage,
  UiToolResultError,
  UiToolResultMessage,
  UiToolResultResponse,
} from "./schemas";

// ---------------------------------------------------------------------------
// Bridge callbacks
// ---------------------------------------------------------------------------

/** Context attached to a ui/message from an app (extracted from _meta). */
export interface UiChatContext {
  action?: string;
  entity?: { type: string; id: string };
  state?: Record<string, unknown>;
}

/** Callbacks the bridge invokes when the iframe sends messages. */
export interface BridgeCallbacks {
  /** Called when the iframe sends a ui/message with chat content. */
  onChat?: (message: string, context?: UiChatContext) => void;
  /** Called when the iframe requests a resize (inline views). */
  onResize?: (height: number) => void;
  /** Called when the iframe requests navigation to a route. */
  onNavigate?: (route: string) => void;
  /** Called when an app requests a prompt to be pre-filled in the chat input. */
  onPromptAction?: (prompt: string) => void;
  /** Called when the iframe requests a semantic action. */
  onAction?: (action: string, params: Record<string, unknown>) => void;
  /** Called when the iframe confirms handshake complete. */
  onInitialized?: () => void;
  /**
   * Provide NimbleBrain-specific extensions to merge into the ext-apps
   * `hostContext` at handshake time (e.g. `{ workspace: { id, name } }`).
   * Called once per `ui/initialize` request, so it can read live state at
   * the moment the iframe finishes loading.
   *
   * The bridge stays workspace-agnostic; the caller owns what extensions to
   * publish. Spec-standardized fields (`theme`, `styles`) are always set by
   * the bridge and override any same-named keys returned here.
   */
  getHostExtensions?: () => Record<string, unknown>;
}
