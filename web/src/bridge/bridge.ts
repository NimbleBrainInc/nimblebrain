// ---------------------------------------------------------------------------
// MCP App Bridge — postMessage Handler
//
// Implements the host side of the MCP Apps protocol (ext-apps spec 2026-01-26).
// Routes iframe messages to platform APIs and forwards events back to iframes.
//
// Spec-compliant methods:
//   tools/call, resources/read, resources/list, resources/templates/list,
//   tasks/get, tasks/result, tasks/cancel,
//   ui/initialize, ui/notifications/initialized,
//   ui/notifications/tool-result, ui/notifications/tool-input,
//   ui/notifications/host-context-changed, ui/notifications/size-changed,
//   ui/open-link, ui/message, ui/update-model-context,
//   ui/download-file, ui/request-display-mode, notifications/message
//
// Spec-compliant notifications forwarded host→iframe:
//   notifications/tasks/status (subscribed once per bridge instance)
//   the app server's own notifications on RELAYED_TO_VIEWS
//     (relayed-notifications.ts), verbatim, via the `server.notification` SSE
//     relay in hooks/useServerNotificationRelay.ts
//
// NimbleBrain extensions (synapse/ namespace — no spec equivalent):
//   synapse/action, synapse/download-file, synapse/data-changed,
//   synapse/persist-state, synapse/state-loaded, synapse/keydown,
//   synapse/request-file
// ---------------------------------------------------------------------------

import {
  type CallToolRequest,
  CallToolResultSchema,
  type CancelTaskRequest,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  ErrorCode,
  type GetTaskPayloadRequest,
  GetTaskPayloadResultSchema,
  type GetTaskRequest,
  GetTaskResultSchema,
  TaskStatusNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getActiveWorkspaceId, uploadResource } from "../api/client";
import { isIdentityApp } from "../lib/identity-apps";
import { appNameFromToolName } from "../lib/namespaced-tool";
import { getMcpBridgeClient, withSessionRetry } from "../mcp-bridge-client";
import { serverCapabilities } from "./relayed-notifications";
import type { LoggingMessageNotification } from "./schemas";
import { SERVER_META_KEY } from "./schemas";
import { getHostThemeMode, getSpecThemeTokens, getThemeTokens } from "./theme";
import type {
  BridgeCallbacks,
  ExtAppsHostContextChangedNotification,
  ExtAppsInitializeResponse,
  ExtAppsToolInputNotification,
  ResourcesListMessage,
  ResourcesReadMessage,
  SynapseRequestFileMessage,
  UiActionMessage,
  UiChatContext,
  UiDataChangedMessage,
  UiInitializeMessage,
  UiMessageMessage,
  UiStateLoadedMessage,
  UiToolResultError,
  UiToolResultMessage,
  UiToolResultResponse,
  UiUpdateModelContextMessage,
} from "./types";
import { validateAppToHostMessage } from "./validate";

// ---------------------------------------------------------------------------
// App state stores (module-level, shared across bridges)
// ---------------------------------------------------------------------------

interface AppStateEntry {
  state: Record<string, unknown>;
  summary?: string;
  updatedAt: string;
}

interface WidgetStateEntry {
  state: Record<string, unknown>;
  version?: number;
}

const appStateStore = new Map<string, AppStateEntry>();
const widgetStateStore = new Map<string, WidgetStateEntry>();

/**
 * Internal app names allowed to address another source — on tools/call,
 * resources/read, a resource listing, or a task request — by naming it in
 * `_meta[SERVER_META_KEY]` (or the legacy top-level field). External iframe
 * apps are strictly scoped to their own server. Defined once at module scope
 * so every call site shares the same trust list.
 */
const INTERNAL_APPS = new Set(["nb", "settings", "home", "usage"]);

/** Get the latest app state pushed via ui/update-model-context. */
export function getAppState(appName: string): AppStateEntry | undefined {
  return appStateStore.get(appName);
}

/** Clear app state (call when app is unmounted). */
export function clearAppState(appName: string): void {
  appStateStore.delete(appName);
}

/** Get persisted widget state. */
export function getWidgetState(appName: string): WidgetStateEntry | undefined {
  return widgetStateStore.get(appName);
}

/** Handle returned by createBridge. Used to send messages and tear down. */
export interface BridgeHandle {
  /** Send a ui/notifications/tool-result notification (agent-side tool result). */
  sendToolResult(result: { content: unknown[]; structuredContent?: Record<string, unknown> }): void;
  /** Send a synapse/data-changed notification (from SSE data.changed event). */
  sendDataChanged(server: string, tool: string): void;
  /** Send ui/notifications/host-context-changed (ext-apps spec). */
  setHostContext(context: Record<string, unknown>): void;
  /** Send ui/notifications/tool-input (ext-apps spec). */
  sendToolInput(params: { arguments: Record<string, unknown> }): void;
  /** Remove all event listeners and clean up. */
  destroy(): void;
}

/**
 * Create a bridge between the host page and an app iframe.
 *
 * Listens for postMessage events from the iframe and routes them per the
 * ext-apps spec, plus NimbleBrain synapse/ extensions.
 */
export function createBridge(
  iframe: HTMLIFrameElement,
  appName: string,
  callbacks?: BridgeCallbacks,
): BridgeHandle {
  let destroyed = false;

  function postToIframe(data: unknown): void {
    if (destroyed) return;
    // App iframes are srcdoc (see iframe.ts:createAppIframe), so their
    // origin is the opaque "null" origin. `postMessage`'s targetOrigin
    // only accepts "*", "/", or a serialised URL — literal "null" throws
    // DOMException at runtime. Tightening this requires the sandbox-proxy
    // work (iframe.ts TODO in createAppIframe) that gives iframes a real
    // origin. The iframe→parent direction (where the real leak lives) is
    // hardened via `hostContext.origin` in the handshake response below.
    iframe.contentWindow?.postMessage(data, "*");
  }

  // Send ui/initialize notification when the iframe finishes loading.
  // This is a NimbleBrain legacy path — the spec-compliant handshake is
  // the request/response flow handled below in handleMessage.
  function handleLoad(): void {
    if (destroyed) return;
    const mode = getHostThemeMode();
    const tokens = getThemeTokens(mode);
    const initMsg: UiInitializeMessage = {
      jsonrpc: "2.0",
      method: "ui/initialize",
      params: {
        capabilities: {
          tools: true,
          messages: true,
          links: true,
          downloads: true,
        },
        theme: {
          mode,
          primaryColor: tokens["--color-text-accent"],
          tokens,
        },
        apiBase: window.location.origin,
        appName,
      },
    };
    postToIframe(initMsg);
  }

  iframe.addEventListener("load", handleLoad);

  // Handle incoming messages from the iframe
  function handleMessage(event: MessageEvent): void {
    if (destroyed) return;
    // Security: only accept messages from this iframe's window
    if (event.source !== iframe.contentWindow) return;

    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    // Trust boundary: the iframe runs third-party app code. Validate
    // inbound envelopes against the declared schemas before acting on
    // them. Unrecognized methods (no schema in the registry) pass
    // through to the switch's `default`, which answers a request with
    // method-not-found and drops a notification.
    const validation = validateAppToHostMessage(msg);
    if (!validation.ok) {
      // Drop and log. A malformed envelope is either a buggy app or
      // a probe — either way the host should not process it.
      console.warn(
        `[bridge] dropping malformed ${validation.method ?? "(no method)"} envelope from app "${appName}": ${validation.reason}`,
      );
      return;
    }

    // Dispatch by method. Every spec method, the two ui/notifications/*
    // lifecycle signals, and the synapse/ extensions are distinct `method`
    // values, so one switch reproduces the original per-method routing. A
    // message with no method, or with one this host does not serve, lands in
    // `default`.
    switch (msg.method) {
      // -----------------------------------------------------------------
      // ext-apps protocol: ui/initialize REQUEST (has id + method)
      // -----------------------------------------------------------------
      case "ui/initialize":
        handleInitialize(msg.id, appName, callbacks, postToIframe);
        break;

      // -----------------------------------------------------------------
      // ext-apps protocol: ui/notifications/initialized
      // -----------------------------------------------------------------
      case "ui/notifications/initialized":
        callbacks?.onInitialized?.();
        break;

      // -----------------------------------------------------------------
      // ext-apps protocol: ui/notifications/request-teardown
      // -----------------------------------------------------------------
      case "ui/notifications/request-teardown":
        break;

      // -----------------------------------------------------------------
      // Spec: tools/call — standard MCP proxying
      // Returns CallToolResult: { content, structuredContent?, isError? }
      // -----------------------------------------------------------------
      case "tools/call":
        handleToolsCall(msg.params, msg.id, appName, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: resources/read — standard MCP resource reads
      // Returns ReadResourceResult: { contents: [{ uri, mimeType?, text?, blob? }] }
      // -----------------------------------------------------------------
      case "resources/read":
        handleResourcesRead(msg.params, msg.id, appName, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: resources/list, resources/templates/list — the app's own
      // server's listings (the promise `serverResources` makes). Pagination
      // passes through: `cursor` in, `nextCursor` out.
      // -----------------------------------------------------------------
      case "resources/list":
      case "resources/templates/list":
        handleResourceListing(msg.method, msg.params, msg.id, appName, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: tasks/get — non-blocking fetch of current task state.
      // Tasks surface is MCP-only; when the flag is off the iframe SDK
      // won't call it (capability isn't advertised), so there's no REST
      // fallback path here.
      // -----------------------------------------------------------------
      case "tasks/get": {
        const { id, params } = msg;
        forwardTaskRequest(TASKS_GET_METHOD, params, GetTaskResultSchema, id, appName).then(
          postToIframe,
        );
        break;
      }

      // -----------------------------------------------------------------
      // Spec: tasks/result — blocks until terminal; returns the payload
      // of the original request (for tools/call, a CallToolResult).
      // -----------------------------------------------------------------
      case "tasks/result": {
        const { id, params } = msg;
        forwardTaskRequest(
          TASKS_RESULT_METHOD,
          params,
          GetTaskPayloadResultSchema,
          id,
          appName,
        ).then(postToIframe);
        break;
      }

      // -----------------------------------------------------------------
      // Spec: tasks/cancel — best-effort cancel; returns the (final)
      // task state. Cancelling a terminal task surfaces as `-32602`.
      // -----------------------------------------------------------------
      case "tasks/cancel": {
        const { id, params } = msg;
        forwardTaskRequest(TASKS_CANCEL_METHOD, params, CancelTaskResultSchema, id, appName).then(
          postToIframe,
        );
        break;
      }

      // -----------------------------------------------------------------
      // Spec: ui/message — { role, content: [{ type, text, _meta? }] }
      // -----------------------------------------------------------------
      case "ui/message":
        handleUiMessage(msg.params, callbacks);
        break;

      // -----------------------------------------------------------------
      // Spec: ui/open-link
      // -----------------------------------------------------------------
      case "ui/open-link": {
        window.open(msg.params.url, "_blank", "noopener");
        break;
      }

      // -----------------------------------------------------------------
      // Spec: ui/notifications/size-changed
      // -----------------------------------------------------------------
      case "ui/notifications/size-changed": {
        callbacks?.onResize?.(msg.params.height);
        break;
      }

      // -----------------------------------------------------------------
      // Spec: ui/update-model-context
      // -----------------------------------------------------------------
      case "ui/update-model-context":
        handleUpdateModelContext(msg.params, msg.id, appName, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: ui/download-file — hand the user a file, as MCP resource
      // blocks rather than an already-materialised Blob.
      // -----------------------------------------------------------------
      case "ui/download-file":
        handleDownloadFile(msg.params.contents, msg.id, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: ui/request-display-mode — answered with the mode actually in
      // effect, which is not necessarily the one requested.
      // -----------------------------------------------------------------
      case "ui/request-display-mode":
        postToIframe({
          jsonrpc: "2.0",
          id: msg.id,
          // The host decides placement from its own layout and never grants a
          // request, so the answer is the mode in effect — `inline`, which is
          // also the spec's own default. Derive it from the host context when
          // something starts publishing a `displayMode`; nothing does today,
          // and reading a key no producer sets is a branch that cannot be
          // exercised.
          result: { mode: "inline" },
        });
        break;

      // -----------------------------------------------------------------
      // Spec: notifications/message — an app's log line. The `logging`
      // capability is advertised, so this has to land somewhere.
      // -----------------------------------------------------------------
      case "notifications/message":
        logAppMessage(appName, msg.params);
        break;

      // -----------------------------------------------------------------
      // Extension: synapse/action — semantic host actions
      // -----------------------------------------------------------------
      case "synapse/action":
        handleSynapseAction(msg.params, callbacks);
        break;

      // -----------------------------------------------------------------
      // Extension: synapse/download-file — trigger browser download
      // -----------------------------------------------------------------
      case "synapse/download-file": {
        triggerDownload(msg.params.data, msg.params.filename, msg.params.mimeType);
        break;
      }

      // -----------------------------------------------------------------
      // Extension: synapse/persist-state — widget state persistence
      // -----------------------------------------------------------------
      case "synapse/persist-state": {
        const persistId = msg.id;
        widgetStateStore.set(appName, {
          state: msg.params.state,
          version: msg.params.version,
        });
        postToIframe({
          jsonrpc: "2.0",
          id: persistId,
          result: { ok: true },
        });
        break;
      }

      // -----------------------------------------------------------------
      // Extension: synapse/request-file — native file picker
      // -----------------------------------------------------------------
      case "synapse/request-file":
        handleRequestFile(msg.params, msg.id, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Extension: synapse/keydown — keyboard shortcut forwarding
      // -----------------------------------------------------------------
      case "synapse/keydown": {
        const { key, ctrlKey, metaKey, shiftKey, altKey } = msg.params;
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ctrlKey,
            metaKey,
            shiftKey,
            altKey,
            bubbles: true,
          }),
        );
        break;
      }

      // -----------------------------------------------------------------
      // Anything else: a method this host does not serve, or no method.
      // -----------------------------------------------------------------
      default:
        answerUnserved(msg, postToIframe);
        break;
    }
  }

  window.addEventListener("message", handleMessage);

  // ---------------------------------------------------------------------
  // Subscribe once to `notifications/tasks/status` on the MCP bridge
  // client and forward each one verbatim to this iframe as a JSON-RPC
  // notification. Multiple bridges share the singleton MCP client; each
  // subscribes independently so every iframe sees every status, filtered
  // on the iframe side by the taskId it owns. Teardown in `destroy()`
  // removes this bridge's handler so post-destroy notifications do not
  // reach the iframe.
  //
  // Notes:
  //   - `_meta` is preserved (per spec, status notifications don't
  //     require related-task meta, but we never strip what's there).
  //   - The SDK's `setNotificationHandler` replaces any prior handler
  //     for the same method; that's an intentional tradeoff — the most
  //     recent bridge wins, but because each handler only `postToIframe`s
  //     (and the bridge's own `destroyed` guard short-circuits after
  //     teardown), multi-bridge behavior is correct as long as handlers
  //     are added in the order they expect to receive.
  //
  // If the MCP client isn't available (e.g. token/workspace not ready),
  // we silently skip subscription and never throw — task notifications
  // are OPTIONAL in the spec and iframes fall back to polling via
  // `tasks/get`.
  // ---------------------------------------------------------------------
  let notificationTeardown: (() => void) | null = null;
  void subscribeTaskStatus();

  async function subscribeTaskStatus(): Promise<void> {
    try {
      const client = await getMcpBridgeClient();
      if (destroyed) return;
      const handler = (
        notification: Awaited<ReturnType<typeof TaskStatusNotificationSchema.parseAsync>>,
      ): void => {
        if (destroyed) return;
        // Forward verbatim — preserve params._meta, including any
        // progressToken or related-task entries the server attached.
        postToIframe({
          jsonrpc: "2.0",
          method: notification.method,
          params: notification.params,
        });
      };
      client.setNotificationHandler(TaskStatusNotificationSchema, handler);
      notificationTeardown = () => {
        client.removeNotificationHandler(TASK_STATUS_METHOD);
      };
    } catch {
      // Subscription is best-effort — polling is the contract.
    }
  }

  return {
    sendToolResult(result: {
      content: unknown[];
      structuredContent?: Record<string, unknown>;
    }): void {
      postToIframe({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: result.content,
          structuredContent: result.structuredContent,
        },
      } as UiToolResultMessage);
    },

    sendDataChanged(server: string, tool: string): void {
      const msg: UiDataChangedMessage = {
        jsonrpc: "2.0",
        method: "synapse/data-changed",
        params: { source: "agent", server, tool },
      };
      postToIframe(msg);
    },

    setHostContext(context: Record<string, unknown>): void {
      // Filter spec-allowed theme keys centrally so every caller
      // (SlotRenderer's theme toggle, future ones) can't bypass the
      // ext-apps strict-Zod contract. Sending `--nb-*` or out-of-spec
      // tokens to a strict client like Reboot tears down the connection
      // on every host-context-changed notification.
      const filtered = filterHostContextForSpec(context);
      const msg: ExtAppsHostContextChangedNotification = {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: filtered,
      };
      postToIframe(msg);
    },

    sendToolInput(params: { arguments: Record<string, unknown> }): void {
      const msg: ExtAppsToolInputNotification = {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params,
      };
      postToIframe(msg);
    },

    destroy(): void {
      destroyed = true;
      window.removeEventListener("message", handleMessage);
      iframe.removeEventListener("load", handleLoad);
      // Unsubscribe from notifications/tasks/status so post-destroy
      // emissions from the MCP client don't reach the iframe.
      if (notificationTeardown) {
        try {
          notificationTeardown();
        } catch {
          // Swallow — teardown is best-effort, the iframe is going away.
        }
        notificationTeardown = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Per-message handlers — one per app→host method the bridge routes. Each
// takes only the context it needs (`postToIframe` is a no-op after teardown),
// so `handleMessage` stays a thin, low-complexity dispatcher.
// ---------------------------------------------------------------------------

/** Delivers a host→iframe message; a no-op once the bridge is destroyed. */
type PostToIframe = (data: unknown) => void;

/**
 * Answer a message whose method this host does not serve. A request
 * (`prompts/list`, `sampling/createMessage`, …) gets JSON-RPC method-not-found,
 * so the view's call fails at once instead of waiting on a reply that never
 * comes. A notification needs no reply, and a message with no method is not a
 * request, so both are dropped.
 */
function answerUnserved(msg: { method?: unknown; id?: unknown }, postToIframe: PostToIframe): void {
  if (typeof msg.method !== "string") return;
  if (typeof msg.id !== "string" && typeof msg.id !== "number") return;
  postToIframe({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: ErrorCode.MethodNotFound, message: `Method not found: ${msg.method}` },
  });
}

/**
 * The NimbleBrain extensions merged into `hostContext` at handshake time.
 *
 * Wrapped because a throwing callback must not take the handshake with it: a
 * dropped `ui/initialize` response hangs the iframe at "Connecting…" with no
 * indication of why.
 */
function readHostExtensions(callbacks: BridgeCallbacks | undefined): Record<string, unknown> {
  try {
    return callbacks?.getHostExtensions?.() ?? {};
  } catch (err) {
    console.error("getHostExtensions threw — proceeding with no extensions:", err);
    return {};
  }
}

/**
 * Serve a spec `ui/download-file`: turn each MCP resource block into a browser
 * download.
 *
 * An `EmbeddedResource` carries the bytes inline, as `text` or base64 `blob`.
 * A `ResourceLink` carries only a URI and asks the host to fetch it — which
 * this does not do, because the URI comes from third-party iframe code and
 * fetching it would make the host an SSRF proxy with the user's cookies. The
 * result says `isError` in that case rather than failing silently, so an app
 * learns to embed instead.
 */
function handleDownloadFile(
  contents: Array<Record<string, unknown>>,
  id: string | number,
  postToIframe: PostToIframe,
): void {
  // Resolve every block before saving any. A request is answered all or
  // nothing: a mixed batch that saved what it could and still reported
  // `isError` would have an app retry the whole thing, and the user would get
  // the resolvable files twice.
  const files: Downloadable[] = [];
  for (const block of contents) {
    const file = toDownloadable(block);
    if (!file) break;
    files.push(file);
  }

  const complete = files.length === contents.length && files.length > 0;
  if (complete) {
    for (const file of files) triggerDownload(file.data, file.filename, file.mimeType);
  }

  postToIframe({ jsonrpc: "2.0", id, result: complete ? {} : { isError: true } });
}

interface Downloadable {
  data: string | Uint8Array;
  filename: string;
  mimeType: string;
}

/**
 * One `ui/download-file` content block as something saveable, or `null` when it
 * is not: a `ResourceLink` (the host does not fetch a URI the app supplied), a
 * payload that is not valid base64, or a block shape we do not model.
 */
function toDownloadable(block: Record<string, unknown>): Downloadable | null {
  const resource = block.resource as Record<string, unknown> | undefined;
  if (!resource) return null;

  const mimeType =
    typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
  const filename = filenameFor(resource.uri, block.name);

  if (typeof resource.text === "string") return { data: resource.text, filename, mimeType };
  const bytes = typeof resource.blob === "string" ? base64ToBytes(resource.blob) : null;
  return bytes ? { data: bytes, filename, mimeType } : null;
}

/**
 * Write an app's `notifications/message` to the console at its own severity.
 *
 * The levels are syslog's, per the spec's `LoggingLevel`. An app's `error`
 * arriving at info level is an error nobody filtering the console will see.
 */
function logAppMessage(appName: string, params: LoggingMessageNotification["params"]): void {
  const { level, logger, data } = params;
  const tag = `[app:${appName}${logger ? `/${logger}` : ""}] ${level}:`;
  if (level === "error" || level === "critical" || level === "alert" || level === "emergency") {
    console.error(tag, data);
  } else if (level === "warning") {
    console.warn(tag, data);
  } else {
    console.info(tag, data);
  }
}

/**
 * A filename for a downloaded resource: the block's own `name` when it has one,
 * else the last segment of the resource URI, else a generic fallback.
 */
function filenameFor(uri: unknown, name: unknown): string {
  if (typeof name === "string" && name.length > 0) return name;
  if (typeof uri === "string") {
    const last = uri.split(/[/\\]/).pop();
    if (last) return last;
  }
  return "download";
}

/** Decode a base64 resource payload, or `null` if it is not valid base64. */
function base64ToBytes(blob: string): Uint8Array | null {
  try {
    const binary = atob(blob);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function handleInitialize(
  id: unknown,
  appName: string,
  callbacks: BridgeCallbacks | undefined,
  postToIframe: PostToIframe,
): void {
  if (typeof id !== "string" && typeof id !== "number") return;

  const extMode = getHostThemeMode();
  // Filter to spec-valid keys only. Strict ext-apps SDK clients (Reboot's
  // React runtime validates via Zod) reject unknown keys on this field.
  // NB extensions and out-of-spec tokens still flow through the iframe's
  // injected `<style>` block — they just don't cross the protocol.
  const extTokens = getSpecThemeTokens(extMode);
  // Spec-standardized fields (theme, styles) take precedence over any
  // same-named keys returned by `getHostExtensions()`, so callers can
  // safely return arbitrary extension keys without colliding.
  //
  // Top-level extension keys (e.g. `workspace`) are spec-allowed: the
  // ext-apps `McpUiHostContextSchema` is `.passthrough()`, so strict
  // SDK clients (Reboot/Zod) preserve unknown keys at the hostContext
  // root. The strict-key concern documented above applies only to
  // `hostContext.styles.variables`, which is a typed enum of CSS
  // custom properties — extensions there would tear down the connection.
  //
  const extensions = readHostExtensions(callbacks);
  const tasks = {
    cancel: {},
    requests: { tools: { call: {} } },
  };
  const hostCapabilities = {
    openLinks: {},
    downloadFile: {},
    // The server's tool calls and resource reads/listings are proxied (above);
    // `listChanged` is set for each notification the host relays to the
    // server's views, and only those (relayed-notifications.ts).
    ...serverCapabilities(),
    logging: {},
    // The MCP tasks utility. `McpUiHostCapabilities` names no such field, so a
    // client that parses the handshake result against the spec's schema drops
    // it — but the SDK reads `hostCapabilities.tasks` off the raw result, so
    // this is what every app in the field actually sees.
    //
    // `experimental` looks like the spec-sanctioned home and is not one yet:
    // it only began preserving its contents after ext-apps 1.7.0, and `web/`
    // declares `^1.3.1` and resolves 1.7.0 — both of which strip it. Advertise
    // there when a client reads it and the floor has moved, not before.
    tasks,
  };
  const response: ExtAppsInitializeResponse = {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "nimblebrain", version: "1.0.0" },
      hostCapabilities,
      hostContext: {
        ...extensions,
        // `origin` is the platform's window.location.origin. SDK helpers
        // use it as `targetOrigin` on outbound postMessage and to
        // validate `event.origin` on inbound — closing the gap that
        // connectors can't otherwise discover the host origin from a
        // srcdoc iframe (which itself runs in the "null" origin).
        origin: window.location.origin,
        theme: extMode,
        styles: {
          variables: extTokens,
        },
      },
    },
  };
  postToIframe(response);

  // After handshake: send any persisted widget state
  const savedWidget = widgetStateStore.get(appName);
  if (savedWidget) {
    const loadMsg: UiStateLoadedMessage = {
      jsonrpc: "2.0",
      method: "synapse/state-loaded",
      params: { state: savedWidget.state, version: savedWidget.version },
    };
    postToIframe(loadMsg);
  }
}

/**
 * The MCP source a request is addressed to, held to the INTERNAL_APPS trust
 * list: an app that is not internal always talks to itself, whatever it asked
 * for.
 *
 * Two places carry the request, because two generations of the SDK put it in
 * different ones. `_meta[SERVER_META_KEY]` is where it belongs and the only
 * place it survives a spec client or host on the path — `params` is parsed
 * against the MCP request schema, which strips a field it does not name. The
 * top-level `server` is the pre-`_meta` home, and it is still read because a
 * published app inlines the SDK it was built against: apps sending it there
 * outlive by an indefinite margin the SDK release that stopped, and they are
 * not rebuilt by us.
 *
 * Both are read here rather than at each call site so the rule has one home,
 * and `resources/read` cannot drift from `tools/call`.
 */
function resolveTargetServer(
  params: { server?: string; _meta?: Record<string, unknown> },
  appName: string,
  internal: boolean,
): string {
  if (!internal) return appName;
  const fromMeta = params._meta?.[SERVER_META_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  return params.server || appName;
}

/**
 * Proxy a spec `tools/call` to the MCP bridge — scoping the target server per
 * the INTERNAL_APPS trust list — and forward the result (or a JSON-RPC error)
 * to the iframe.
 */
function handleToolsCall(
  params: ToolsCallParams,
  id: string,
  appName: string,
  postToIframe: PostToIframe,
): void {
  // Security: tool calls are scoped to appName by default. Internal
  // connectors (`INTERNAL_APPS`) can address another source instead.
  // The `/mcp` endpoint is workspace-scoped but doesn't know about the
  // "internal app" concept, so this authz check stays in the bridge.
  const internal = INTERNAL_APPS.has(appName);
  const server = resolveTargetServer(params, appName, internal);

  // A qualified tool name names a source too, so it is a second way to ask
  // for one — and it has to be held to the same rule as the `_meta` target.
  // `callToolViaMcp` only prefixes a BARE name, so without this an external
  // iframe reaches any tool in the workspace by sending the qualified form
  // it wants (`files__create`) instead of the bare one it is entitled to.
  // This is the only place the scope can be enforced: the browser holds ONE
  // `/mcp` session shared by every iframe and the agent, so the server sees
  // no caller to attribute a call to.
  const named = appNameFromToolName(params.name);
  if (!internal && named !== undefined && named !== server) {
    postToIframe({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `Tool calls from "${server}" are scoped to that server; "${params.name}" names another.`,
      },
    } satisfies UiToolResultError);
    return;
  }

  callToolViaMcp(server, params, id).then(postToIframe, (err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : "Tool call failed";
    const errorResponse: UiToolResultError = {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: errorMsg },
    };
    postToIframe(errorResponse);
  });
}

/**
 * Proxy a spec `resources/read` to the MCP bridge (same INTERNAL_APPS scoping
 * as tools/call) and forward the result or a JSON-RPC error to the iframe.
 */
function handleResourcesRead(
  params: ResourcesReadMessage["params"],
  id: string,
  appName: string,
  postToIframe: PostToIframe,
): void {
  // Same trust list and the same two request locations as tools/call: the
  // app's own server, unless an internal app names another. `/mcp` would
  // otherwise resolve the URI against every source in the workspace and the
  // user's identity sources, so the read is scoped by naming this server on
  // the wire (`readResourceViaMcp`). The URI itself passes through verbatim;
  // SSRF safety lives in the connector.
  const server = resolveTargetServer(params, appName, INTERNAL_APPS.has(appName));

  readResourceViaMcp(server, params.uri)
    .then((result) => {
      postToIframe({ jsonrpc: "2.0", id, result });
    })
    .catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : "Resource read failed";
      postToIframe({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: errorMsg },
      });
    });
}

/**
 * The `_meta` key that scopes a read, a listing or a task request on `/mcp` to
 * one source. Must equal
 * `RESOURCE_SOURCE_META_KEY` in `src/api/mcp-server.ts` (the runtime image ships
 * `src/` alone, so the two cannot share a module); pinned equal by
 * `test/unit/tools/server-notifications.test.ts`.
 */
export const RESOURCE_SOURCE_META_KEY = "ai.nimblebrain/source";

/**
 * Proxy a spec `resources/list` / `resources/templates/list` to the app's own
 * server and forward the result — pagination included — or a JSON-RPC error.
 *
 * Scoped like `resources/read` and `tools/call`: the app's own server, unless an
 * internal app names another. The bridge alone knows which iframe asked (every
 * iframe shares one `/mcp` session), so it names the server in the request's
 * `_meta` and `/mcp` lists that one source. The iframe's own `_meta` is not
 * forwarded; only its `cursor` is.
 */
function handleResourceListing(
  method: "resources/list" | "resources/templates/list",
  params: ResourcesListMessage["params"],
  id: string,
  appName: string,
  postToIframe: PostToIframe,
): void {
  // Same rule, same resolver as tools/call and resources/read: a listing may be
  // addressed to another source, in `_meta` or in the legacy top-level field,
  // and only a built-in app may address one at all.
  const server = resolveTargetServer(params ?? {}, appName, INTERNAL_APPS.has(appName));
  const request = {
    ...(typeof params?.cursor === "string" ? { cursor: params.cursor } : {}),
    _meta: { [RESOURCE_SOURCE_META_KEY]: server },
  };

  withSessionRetry(async () => {
    const client = await getMcpBridgeClient();
    return method === "resources/list"
      ? client.listResources(request)
      : client.listResourceTemplates(request);
  })
    .then((result) => {
      postToIframe({ jsonrpc: "2.0", id, result });
    })
    .catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : "Resource listing failed";
      postToIframe({ jsonrpc: "2.0", id, error: { code: -32000, message: errorMsg } });
    });
}

/**
 * Handle a spec `ui/message`: forward chat text (via onChat or an `nb:chat`
 * event) and any `prompt` suggestion action to the host.
 */
function handleUiMessage(
  params: UiMessageMessage["params"],
  callbacks: BridgeCallbacks | undefined,
): void {
  // Spec format: content is array of content blocks
  if (Array.isArray(params.content)) {
    const textBlock = params.content.find((b: Record<string, unknown>) => b.type === "text");
    if (textBlock?.text) {
      const context = textBlock._meta?.context as UiChatContext | undefined;
      if (callbacks?.onChat) {
        callbacks.onChat(textBlock.text, context);
      } else {
        window.dispatchEvent(
          new CustomEvent("nb:chat", {
            detail: { message: textBlock.text, context },
          }),
        );
      }
    }
  }
  // NimbleBrain extension: prompt suggestion action
  if (params.action === "prompt" && params.value) {
    callbacks?.onPromptAction?.(params.value);
  }
}

/**
 * Handle a spec `ui/update-model-context`: store the app's latest visible
 * state (with a text summary when present) and ack when the message had an id.
 */
function handleUpdateModelContext(
  params: UiUpdateModelContextMessage["params"],
  id: string | number | undefined,
  appName: string,
  postToIframe: PostToIframe,
): void {
  const { structuredContent, content } = params;
  const summary =
    Array.isArray(content) && content.length > 0 && content[0].type === "text"
      ? content[0].text
      : undefined;
  appStateStore.set(appName, {
    state: structuredContent ?? {},
    summary,
    updatedAt: new Date().toISOString(),
  });
  if (id) {
    postToIframe({ jsonrpc: "2.0", id, result: {} });
  }
}

/**
 * Handle a synapse/action: route `navigate` to onNavigate, otherwise invoke
 * onAction (or dispatch an `nb:action` event when no callback is wired).
 */
function handleSynapseAction(
  params: UiActionMessage["params"],
  callbacks: BridgeCallbacks | undefined,
): void {
  const { action, ...actionParams } = params;
  if (action === "navigate" && actionParams.route && callbacks?.onNavigate) {
    callbacks.onNavigate(actionParams.route as string);
    return;
  }
  if (callbacks?.onAction) {
    callbacks.onAction(action, actionParams);
  } else {
    window.dispatchEvent(new CustomEvent("nb:action", { detail: { action, ...actionParams } }));
  }
}

/**
 * Handle a synapse/request-file: open the native file picker and forward the
 * uploaded entries — or a JSON-RPC `-32602` error — back to the iframe.
 */
function handleRequestFile(
  params: SynapseRequestFileMessage["params"] | undefined,
  id: string,
  postToIframe: PostToIframe,
): void {
  const accept = params?.accept ?? "";
  const maxSize = params?.maxSize ?? 26_214_400; // 25 MB
  const multiple = params?.multiple ?? false;

  pickFiles(accept, maxSize, multiple)
    .then((result) => {
      postToIframe({ jsonrpc: "2.0", id, result });
    })
    .catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : "File pick failed";
      postToIframe({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: errorMsg },
      });
    });
}

// ---------------------------------------------------------------------------
// MCP transport helpers — wire `tools/call` / `resources/read` through the
// platform's `/mcp` streamable HTTP endpoint via the MCP SDK `Client`.
//
// Rules:
//   - All JSON-RPC dispatch goes through the SDK `Client` (no hand-crafted
//     method strings or wire payloads).
//   - Response shape forwarded to the iframe MUST match the spec'd MCP
//     path: `{ content, structuredContent }` for tools (non-task),
//     `{ contents }` for resources. For task-augmented calls the full
//     CreateTaskResult is preserved as-is (see §Non-Negotiable Rule 4:
//     CallToolResult / task results forwarded verbatim, never unwrapped).
//   - Errors translate to JSON-RPC `{ code: -32000, message }` envelopes
//     consistent with the REST path so iframes don't need to branch on
//     which transport ran.
//   - the target-source authz is handled at the call site — this helper
//     receives the already-resolved server name.
// ---------------------------------------------------------------------------

/**
 * Shape of a `tools/call` dispatched from an iframe. We don't rely on the
 * bridge's typed union here because ext-apps permits a task-augmented
 * envelope whose `task` field is forwarded through to `/mcp` verbatim.
 */
interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  /** When present, the call is task-augmented per MCP draft 2025-11-25. */
  task?: { ttl?: number; pollInterval?: number };
  /** Internal-only: cross-call target. Resolved to `server` before this runs. */
  server?: string;
  [key: string]: unknown;
}

/**
 * Forward a `tools/call` through the MCP SDK bridge client. Builds the
 * iframe-facing response envelope so the caller can `postToIframe` directly.
 *
 * Task-augmented calls (`params.task` present) route through the generic
 * `request()` path with `CreateTaskResultSchema` so the `CreateTaskResult`
 * reaches the iframe without being rejected by `CallToolResultSchema`.
 */
async function callToolViaMcp(
  server: string,
  params: ToolsCallParams,
  id: string,
): Promise<UiToolResultResponse | UiToolResultError | Record<string, unknown>> {
  // The `/mcp` endpoint expects a tool name whose shape encodes its scope.
  // Two transformations:
  //
  //   1. Qualified: iframes pass either `<tool>` (bare) or
  //      `<source>__<tool>` (already qualified). A bare name is qualified
  //      here with the post-INTERNAL_APPS-authz `server`; an already-qualified
  //      one passes through, having been held to that same authz by the call
  //      site (`handleToolsCall`) — which is where it must happen, because by
  //      here the app the call came from is no longer in scope.
  //   2. Scoped: BOTH doors dispatch the same bare `<source>__<tool>` form.
  //      Identity apps (conversations, …) always did. Workspace apps used to
  //      prefix `ws_<active>-`; they no longer do, because the workspace a call
  //      lands in comes from the request's validated `X-Workspace-Id`, not from
  //      the name. Restating it in the name only gave the model 39 opaque
  //      characters to echo — and drop.
  //
  //      The active-workspace check stays. The server refuses a workspace call
  //      on a session with no workspace anyway (`WorkspaceToolUnavailable`), but
  //      failing here is a clearer error and saves a round trip.
  //      A personal connector's marker needs no special handling here, and that
  //      is a property of the code rather than an assumption. `server` is the
  //      name the iframe was mounted under, which comes from
  //      `appNameFromToolName` — and that KEEPS the marker. So if a connector
  //      ever does mount an iframe, `my_gmail__send` goes out marked and lands on
  //      the identity door. Today none can: a `ui://` read resolves through
  //      `readIdentityAppResource` (kernel identity sources) or `readAppResource`
  //      (the workspace registry) and a connector is in neither, so
  //      `BlockTimeline` refuses to mount one. Both halves fail safe; neither
  //      relies on the other.
  const qualifiedName = params.name.includes("__") ? params.name : `${server}__${params.name}`;
  if (!isIdentityApp(server) && !getActiveWorkspaceId()) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "No active workspace; cannot dispatch tool call.",
      },
    } satisfies UiToolResultError;
  }

  return withSessionRetry(async () => {
    const client = await getMcpBridgeClient();

    if (params.task) {
      // Task-augmented: the server returns CreateTaskResult, not
      // CallToolResult. The typed `client.callTool()` would reject that;
      // use the generic `request()` path with the right schema and
      // forward the result verbatim (Non-Negotiable Rule 4).
      const method: CallToolRequest["method"] = "tools/call";
      const result = await client.request(
        {
          method,
          params: {
            name: qualifiedName,
            arguments: params.arguments ?? {},
            task: params.task,
          },
        },
        CreateTaskResultSchema,
      );
      return { jsonrpc: "2.0", id, result };
    }

    const result = await client.callTool(
      {
        name: qualifiedName,
        arguments: params.arguments ?? {},
      },
      CallToolResultSchema,
    );

    if (result.isError) {
      const errorText =
        (result.content as Array<{ text?: string }> | undefined)
          ?.map((b) => b.text ?? "")
          .filter(Boolean)
          .join("\n") || "Tool error";
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: errorText },
      } satisfies UiToolResultError;
    }

    // Forward the full CallToolResult shape (content + structuredContent).
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: result.content as UiToolResultResponse["result"]["content"],
        structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      },
    } satisfies UiToolResultResponse;
  });
}

/**
 * Forward a `resources/read` through the MCP SDK bridge client, scoped to
 * `server` — the target the call site resolved under the INTERNAL_APPS rule.
 * Returns the ReadResourceResult shape (`{ contents }`) so the caller can
 * assemble the JSON-RPC response envelope for the iframe.
 */
async function readResourceViaMcp(server: string, uri: string): Promise<{ contents: unknown[] }> {
  // `server` goes on the wire under `RESOURCE_SOURCE_META_KEY`, as it does for
  // listings, and `/mcp` reads from that one source. It is the only thing that
  // can: every iframe shares one `/mcp` session, so without it a read resolves
  // across the whole workspace and the user's files.
  return withSessionRetry(async () => {
    const client = await getMcpBridgeClient();
    const result = await client.readResource({
      uri,
      _meta: { [RESOURCE_SOURCE_META_KEY]: server },
    });
    return { contents: result.contents as unknown[] };
  });
}

// ---------------------------------------------------------------------------
// Tasks surface — `tasks/{get,result,cancel}` and status-notification
// forwarding.
//
// Method-literal types are derived from the SDK request schemas so a spec
// rename surfaces as a TypeScript error at the call sites rather than a
// runtime 404 against `/mcp`. Never hand-type these strings.
// ---------------------------------------------------------------------------

const TASKS_GET_METHOD: GetTaskRequest["method"] = "tasks/get";
const TASKS_RESULT_METHOD: GetTaskPayloadRequest["method"] = "tasks/result";
const TASKS_CANCEL_METHOD: CancelTaskRequest["method"] = "tasks/cancel";
/** Matches `TaskStatusNotificationSchema.method` — used for `removeNotificationHandler`. */
const TASK_STATUS_METHOD = "notifications/tasks/status" as const;

/** Params accepted on the three tasks/* iframe messages. */
interface TasksParams {
  taskId: string;
  /** Internal apps only: the server that ran the task (legacy location). */
  server?: string;
  /** Internal apps only: the server that ran the task, under `SERVER_META_KEY`. */
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Translate an unknown error from the MCP SDK's `client.request()` into the
 * JSON-RPC error shape the iframe expects. Spec §8 mandates `-32602` for
 * "invalid taskId" / "not found" / "terminal-task cancel"; `-32603` for
 * internal server errors; and `-32000` as the catch-all we use elsewhere
 * in the bridge.
 *
 * We pass through any explicit numeric `code` the SDK surfaced from the
 * server (so server-authored `-32602` stays `-32602`). Everything else
 * degrades to `-32603` / `-32000` depending on whether the message hints
 * at a server-side internal error.
 */
function translateTaskError(err: unknown): { code: number; message: string } {
  // SDK errors expose `.code` / `.message` mirrors of the JSON-RPC error
  // envelope when the server returned one. Preserve the server's code.
  const maybeCoded = err as { code?: unknown; message?: unknown } | null | undefined;
  if (maybeCoded && typeof maybeCoded.code === "number") {
    const code = maybeCoded.code;
    const message =
      typeof maybeCoded.message === "string" ? maybeCoded.message : "Task request failed";
    return { code, message };
  }
  const message = err instanceof Error ? err.message : "Task request failed";
  return { code: -32603, message };
}

/**
 * Forward a `tasks/*` request through the MCP bridge client, scoped to the
 * server that ran the task. Returns the full JSON-RPC response (success or
 * error) ready to `postToIframe`.
 *
 * The caller picks the method constant + result schema. What reaches `/mcp` is
 * the `taskId` and the scope, and nothing else the iframe sent. The scope is
 * the app's own server, unless an internal app names another — the same
 * resolver as `tools/call` — under `RESOURCE_SOURCE_META_KEY`, as for a
 * resource read. Every iframe shares one `/mcp` session, so without it `/mcp`
 * would answer for any task the session holds. Errors are mapped via
 * `translateTaskError`.
 */
async function forwardTaskRequest(
  method: GetTaskRequest["method"] | GetTaskPayloadRequest["method"] | CancelTaskRequest["method"],
  params: TasksParams,
  schema:
    | typeof GetTaskResultSchema
    | typeof GetTaskPayloadResultSchema
    | typeof CancelTaskResultSchema,
  id: string,
  appName: string,
): Promise<Record<string, unknown>> {
  const server = resolveTargetServer(params, appName, INTERNAL_APPS.has(appName));
  const scoped = { taskId: params.taskId, _meta: { [RESOURCE_SOURCE_META_KEY]: server } };
  try {
    // `withSessionRetry` only re-runs on the specific session-not-found
    // shape; any other error (incl. spec-mandated `-32602` for missing
    // tasks) propagates through this catch and gets translated to the
    // JSON-RPC error envelope the iframe expects.
    return await withSessionRetry(async () => {
      const client = await getMcpBridgeClient();
      const result = await client.request({ method, params: scoped }, schema);
      // Forward the result verbatim (Non-Negotiable Rule 4: never unwrap).
      return { jsonrpc: "2.0", id, result };
    });
  } catch (err) {
    return { jsonrpc: "2.0", id, error: translateTaskError(err) };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Filter `ui/notifications/host-context-changed` params so only spec-valid
 * theme variable keys cross the wire. Strict ext-apps SDK clients (Reboot's
 * React runtime validates via Zod) reject unknown keys on
 * `hostContext.styles.variables`; sending `--nb-*` or out-of-spec tokens
 * tears down the connection. Centralized here so callers can't skip it.
 *
 * Only the `styles.variables` branch is filtered — other host-context
 * fields (theme mode, future additions) pass through unchanged.
 */
function filterHostContextForSpec(ctx: Record<string, unknown>): Record<string, unknown> {
  const styles = ctx.styles as { variables?: Record<string, string> } | undefined;
  if (!styles?.variables) return ctx;
  const mode = (ctx.theme as "light" | "dark" | undefined) ?? getHostThemeMode();
  return {
    ...ctx,
    styles: {
      ...styles,
      variables: getSpecThemeTokens(mode),
    },
  };
}

/**
 * Open the OS file picker, then upload the selected files to the
 * workspace file store via `POST /v1/resources`. Returns the
 * persisted `WorkspaceFile` entries — bytes never traverse the
 * iframe-bridge boundary, so files of any size the server's
 * `maxFileSize` allows work without base64 inflation or hitting the
 * 1 MB tool-call JSON cap.
 *
 * `maxSize` is enforced client-side as a fast-fail; the server is
 * still the source of truth (`getFilesConfig().maxFileSize`).
 */
async function pickFiles(accept: string, maxSize: number, multiple: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    // User cancelled — no change event fires, detect via focus return
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        document.body.removeChild(input);
        resolve(multiple ? [] : null);
      }
    };

    // Fallback: if user cancels, focus returns to window
    window.addEventListener("focus", () => setTimeout(cleanup, 300), { once: true });

    input.addEventListener("change", () => {
      resolved = true;
      document.body.removeChild(input);
      // Validate + upload off-thread; settle the picker Promise with the
      // result (or the size/upload error) exactly as the change fires.
      processPickedFiles(input.files, maxSize, multiple).then(resolve, reject);
    });

    input.click();
  });
}

/**
 * Validate picked files against `maxSize`, upload them via `POST /v1/resources`,
 * and resolve to the persisted entries — or `[]`/`null` when nothing was chosen.
 * Throws on the first oversize file or an upload failure.
 */
async function processPickedFiles(
  files: FileList | null,
  maxSize: number,
  multiple: boolean,
): Promise<unknown> {
  if (!files || files.length === 0) return multiple ? [] : null;
  const selected = Array.from(files);
  for (const file of selected) {
    if (file.size > maxSize) {
      throw new Error(
        `File "${file.name}" exceeds maximum size of ${Math.round(maxSize / 1_048_576)} MB`,
      );
    }
  }
  const result = await uploadResource(selected);
  return multiple ? result.files : (result.files[0] ?? null);
}

/**
 * Trigger a browser file download via a temporary anchor tag.
 *
 * `data` is typed as `Blob` but the schema's `Type.Unknown()` (Blob isn't
 * a JSON shape; structured-clone postMessage carries it transparently)
 * means a malformed app could ship a plain object or null. Validate at
 * the consumer instead of at the schema — Blob/string/ArrayBuffer/
 * ArrayBufferView are all valid `BlobPart`s; everything else is rejected
 * with a console warning rather than throwing inside the Blob ctor.
 */
function triggerDownload(data: unknown, filename: string, mimeType: string): void {
  const isBlobPart =
    data instanceof Blob ||
    typeof data === "string" ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data);
  if (!isBlobPart) {
    console.warn(
      `[bridge] synapse/download-file: ignoring data of unsupported type (got ${typeof data})`,
    );
    return;
  }
  const blob =
    data instanceof Blob && data.type === mimeType
      ? data
      : new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(anchor);
  }, 100);
}
