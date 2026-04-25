// ---------------------------------------------------------------------------
// MCP App Bridge — Message Type Definitions
//
// Defines the postMessage protocol between host (web client) and app iframes.
// Uses JSON-RPC 2.0 envelope format per ext-apps spec (2026-01-26).
//
// Spec methods use ui/ and tools/ prefixes.
// NimbleBrain extensions use synapse/ prefix.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App -> Host messages (ext-apps spec)
// ---------------------------------------------------------------------------

/** Spec: App requests the host to execute a tool call (standard MCP proxying). */
export interface ToolsCallMessage {
  jsonrpc: "2.0";
  method: "tools/call";
  id: string;
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

/** Spec: App sends a message to the conversation.
 *  Params: { role: "user", content: [{ type: "text", text, _meta? }] }
 *  NimbleBrain extension: { action: "prompt", value: string } for prompt suggestions.
 */
export interface UiMessageMessage {
  jsonrpc: "2.0";
  method: "ui/message";
  id?: string;
  params: {
    role?: "user";
    content?: Array<{ type: string; text: string; _meta?: Record<string, unknown> }>;
    // NimbleBrain extension: prompt suggestion
    action?: "prompt";
    value?: string;
  };
}

/** Spec: App requests the host to open a URL in a new tab. */
export interface UiOpenLinkMessage {
  jsonrpc: "2.0";
  method: "ui/open-link";
  id?: string;
  params: {
    url: string;
  };
}

/** Spec: App reports its content size for auto-sizing (inline views). */
export interface UiSizeChangedMessage {
  jsonrpc: "2.0";
  method: "ui/notifications/size-changed";
  id?: string;
  params: {
    width?: number;
    height: number;
  };
}

/** Spec: App pushes model context visible to the LLM. */
export interface UiUpdateModelContextMessage {
  jsonrpc: "2.0";
  id: string;
  method: "ui/update-model-context";
  params: {
    content?: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

/** ext-apps: App sends ui/initialize as a JSON-RPC request (has id). */
export interface ExtAppsInitializeRequest {
  jsonrpc: "2.0";
  id: string;
  method: "ui/initialize";
  params: {
    protocolVersion: string;
    clientInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
  };
}

/** ext-apps: App confirms initialization complete. */
export interface ExtAppsInitializedNotification {
  jsonrpc: "2.0";
  method: "ui/notifications/initialized";
  params: Record<string, never>;
}

/** ext-apps: App requests teardown. */
export interface ExtAppsRequestTeardownNotification {
  jsonrpc: "2.0";
  method: "ui/notifications/request-teardown";
  params: Record<string, never>;
}

// ---------------------------------------------------------------------------
// App -> Host messages (NimbleBrain extensions)
// ---------------------------------------------------------------------------

/** Extension: App requests a semantic action from the shell. */
export interface UiActionMessage {
  jsonrpc: "2.0";
  method: "synapse/action";
  id?: string;
  params: {
    action: string;
    [key: string]: unknown;
  };
}

/** Extension: App requests the host to trigger a file download. */
export interface UiDownloadFileMessage {
  jsonrpc: "2.0";
  method: "synapse/download-file";
  id?: string;
  params: {
    data: Blob;
    filename: string;
    mimeType: string;
  };
}

/** Extension: App requests widget state persistence. */
export interface UiPersistStateMessage {
  jsonrpc: "2.0";
  method: "synapse/persist-state";
  id: string;
  params: {
    state: Record<string, unknown>;
    version?: number;
  };
}

/** Extension: App requests a file from the user via native file picker. */
export interface SynapseRequestFileMessage {
  jsonrpc: "2.0";
  method: "synapse/request-file";
  id: string;
  params: {
    accept?: string;
    maxSize?: number;
    multiple?: boolean;
  };
}

/** Extension: App forwards a keyboard shortcut to the host. */
export interface UiKeydownMessage {
  jsonrpc: "2.0";
  method: "synapse/keydown";
  params: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  };
}

/** Union of all App -> Host messages. */
export type AppToHostMessage =
  | ToolsCallMessage
  | ResourcesReadMessage
  | UiMessageMessage
  | UiOpenLinkMessage
  | UiSizeChangedMessage
  | UiUpdateModelContextMessage
  | UiActionMessage
  | UiDownloadFileMessage
  | UiPersistStateMessage
  | SynapseRequestFileMessage
  | UiKeydownMessage
  | ExtAppsInitializeRequest
  | ExtAppsInitializedNotification
  | ExtAppsRequestTeardownNotification;

// ---------------------------------------------------------------------------
// Host -> App messages
// ---------------------------------------------------------------------------

/** Sent to the iframe on load with platform capabilities and theme (legacy path). */
export interface UiInitializeMessage {
  jsonrpc: "2.0";
  method: "ui/initialize";
  params: {
    capabilities: {
      tools: boolean;
      messages: boolean;
      links: boolean;
      downloads: boolean;
    };
    theme: {
      mode: "light" | "dark";
      primaryColor: string;
      tokens?: Record<string, string>;
    };
    apiBase?: string;
    appName?: string;
  };
}

/** Spec: App requests the host to read an MCP resource. */
export interface ResourcesReadMessage {
  jsonrpc: "2.0";
  method: "resources/read";
  id: string;
  params: {
    uri: string;
    /** Internal-only: route the read to a different server (allowed for internal bundles). */
    server?: string;
  };
}

/** Spec: Result of a resources/read request — returns ReadResourceResult per MCP spec. */
export interface UiResourceResultResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    contents: Array<{
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }>;
  };
}

/** Error response for a failed resources/read request. */
export interface UiResourceResultError {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
  };
}

/** Spec: Result of a tools/call request — returns CallToolResult per MCP spec. */
export interface UiToolResultResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
  };
}

/** Error response for a failed tools/call request. */
export interface UiToolResultError {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
  };
}

/** Spec: Forwarded tool result notification from the agent. */
export interface UiToolResultMessage {
  jsonrpc: "2.0";
  method: "ui/notifications/tool-result";
  params: {
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
  };
}

/** Spec: Host responds to ui/initialize request (ext-apps handshake). */
export interface ExtAppsInitializeResponse {
  jsonrpc: "2.0";
  // JSON-RPC 2.0 allows request IDs to be strings or numbers; ext-apps SDK
  // clients (Reboot via @reboot-dev/reboot-react) use numeric IDs starting
  // at 0, so the response echoes whichever shape the request used.
  id: string | number;
  result: {
    protocolVersion: string;
    hostInfo: { name: string; version: string };
    hostCapabilities: Record<string, unknown>;
    hostContext?: {
      theme?: "light" | "dark";
      styles?: {
        variables?: Record<string, string>;
      };
      [key: string]: unknown;
    };
  };
}

/** Spec: Host sends tool input to view. */
export interface ExtAppsToolInputNotification {
  jsonrpc: "2.0";
  method: "ui/notifications/tool-input";
  params: {
    arguments: Record<string, unknown>;
  };
}

/** Spec: Host sends tool result to view. */
export interface ExtAppsToolResultNotification {
  jsonrpc: "2.0";
  method: "ui/notifications/tool-result";
  params: {
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
  };
}

/** Spec: Host notifies view of context changes (theme, locale, etc). */
export interface ExtAppsHostContextChangedNotification {
  jsonrpc: "2.0";
  method: "ui/notifications/host-context-changed";
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Host -> App messages (NimbleBrain extensions)
// ---------------------------------------------------------------------------

/** Extension: Forwarded data change notification from SSE. */
export interface UiDataChangedMessage {
  jsonrpc: "2.0";
  method: "synapse/data-changed";
  params: {
    source: "agent";
    server: string;
    tool: string;
  };
}

/** Extension: Host sends previously persisted widget state on init. */
export interface UiStateLoadedMessage {
  jsonrpc: "2.0";
  method: "synapse/state-loaded";
  params: {
    state: Record<string, unknown> | null;
    version?: number;
  };
}

/** Union of all Host -> App messages. */
export type HostToAppMessage =
  | UiInitializeMessage
  | UiToolResultResponse
  | UiToolResultError
  | UiToolResultMessage
  | UiResourceResultResponse
  | UiResourceResultError
  | UiDataChangedMessage
  | UiStateLoadedMessage
  | ExtAppsInitializeResponse
  | ExtAppsToolInputNotification
  | ExtAppsToolResultNotification
  | ExtAppsHostContextChangedNotification;

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
