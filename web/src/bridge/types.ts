// ---------------------------------------------------------------------------
// MCP App Bridge — host-side callback types + re-exports of wire envelopes.
//
// Wire-envelope types are derived from TypeBox schemas in `./schemas` —
// single source of truth for both runtime validation (Value.Check at the
// iframe trust boundary) and TypeScript types (Static<>). See `./schemas.ts`
// for the trust-boundary policy and the canonical envelope shapes.
//
// Non-envelope types (BridgeCallbacks) live here because
// they describe the host's API to its callers, not a wire shape that
// crosses a trust boundary.
// ---------------------------------------------------------------------------

import type { UploadLimits } from "./host-extensions";

export type {
  // App → Host envelopes
  AppToHostMessage,
  // Host → App envelopes
  ExtAppsHostContextChangedNotification,
  ExtAppsInitializedNotification,
  ExtAppsInitializeRequest,
  ExtAppsInitializeResponse,
  ExtAppsRequestTeardownNotification,
  ExtAppsToolInputNotification,
  ExtAppsToolResultNotification,
  HostToAppMessage,
  RelayedServerNotification,
  ResourcesListMessage,
  ResourcesReadMessage,
  ResourceTemplatesListMessage,
  SynapseRequestFileMessage,
  ToolsCallMessage,
  UiActionMessage,
  UiKeydownMessage,
  UiMessageMessage,
  UiOpenLinkMessage,
  UiResourceResultError,
  UiResourceResultResponse,
  UiSizeChangedMessage,
  UiToolResultError,
  UiToolResultMessage,
  UiToolResultResponse,
  UiUpdateModelContextMessage,
} from "./schemas";

// ---------------------------------------------------------------------------
// Bridge callbacks
// ---------------------------------------------------------------------------

/** Callbacks the bridge invokes when the iframe sends messages. */
export interface BridgeCallbacks {
  /** Called when the iframe sends a ui/message with chat content. */
  onChat?: (message: string) => void;
  /** Called when the iframe requests a resize (inline views). */
  onResize?: (height: number) => void;
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
  /**
   * The instance's upload limits, which the `ai.nimblebrain/request-file`
   * picker enforces before it uploads. Unset, the picker holds files to the
   * `maxSize` the app asks for (25 MB by default) and leaves the total to the
   * server.
   */
  getUploadLimits?: () => UploadLimits | undefined;
}
