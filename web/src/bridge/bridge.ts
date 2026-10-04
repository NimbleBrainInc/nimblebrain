// ---------------------------------------------------------------------------
// MCP App Bridge — postMessage Handler
//
// Implements the host side of the MCP Apps protocol (ext-apps spec 2026-01-26).
// Routes iframe messages to platform APIs and forwards events back to iframes.
//
// Spec-compliant methods:
//   tools/call, resources/read, resources/list, resources/templates/list,
//   tasks/get, tasks/cancel (the tasks extension, io.modelcontextprotocol/tasks),
//   ui/initialize, ui/notifications/initialized,
//   ui/notifications/tool-result, ui/notifications/tool-input,
//   ui/notifications/host-context-changed, ui/notifications/size-changed,
//   ui/open-link, ui/message, ui/update-model-context,
//   ui/download-file, ui/request-display-mode, notifications/message
//
// Nothing is posted to the app before ui/notifications/initialized except the
// answers to its own requests; earlier notifications are held until then.
//
// Spec-compliant notifications forwarded host→iframe:
//   the app server's own notifications on RELAYED_TO_VIEWS
//     (relayed-notifications.ts), verbatim, via the `server.notification` SSE
//     relay in hooks/useServerNotificationRelay.ts
//
// NimbleBrain extensions (ai.nimblebrain/ namespace — no spec equivalent):
//   ai.nimblebrain/action, ai.nimblebrain/keydown, ai.nimblebrain/request-file,
//   ai.nimblebrain/location (in) and ai.nimblebrain/navigate (out)
//   Each is served only because it is declared: see host-capabilities.ts.
// ---------------------------------------------------------------------------

import { getActiveWorkspaceId, uploadResource } from "../api/client";
import { humanBytes } from "../api/format-error";
import { appNameFromToolName } from "../lib/namespaced-tool";
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpAnswer,
  type McpError,
  sendMcpRequest,
} from "../mcp-bridge-client";
import type { FileEntry } from "../types";
import { openAppChannel } from "./app-channel";
import {
  ACTION_METHOD,
  KEYDOWN_METHOD,
  LOCATION_METHOD,
  NAVIGATE_METHOD,
  NOTIFY_METHOD,
  REQUEST_FILE_METHOD,
  UPLOAD_FILES_APPS,
  UPLOAD_FILES_METHOD,
} from "./extensions";
import { buildHostCapabilities, TASKS_EXTENSION_ID } from "./host-capabilities";
import { buildHostStyles, type UploadLimits } from "./host-extensions";
import type { LoggingMessageNotification } from "./schemas";
import { getHostThemeMode, getSpecThemeTokens } from "./theme";
import type {
  AppNotice,
  BridgeCallbacks,
  ExtAppsHostContextChangedNotification,
  ExtAppsInitializeResponse,
  ExtAppsToolInputNotification,
  ExtAppsToolResultNotification,
  ResourcesListMessage,
  ResourcesReadMessage,
  SynapseRequestFileMessage,
  SynapseUploadFilesMessage,
  UiActionMessage,
  UiMessageMessage,
  UiToolResultError,
  UiToolResultResponse,
  UiUpdateModelContextMessage,
} from "./types";
import { validateAppToHostMessage } from "./validate";

// ---------------------------------------------------------------------------
// App state (ui/update-model-context), one entry per live bridge
// ---------------------------------------------------------------------------

interface AppStateEntry {
  state: Record<string, unknown>;
  summary?: string;
  updatedAt: string;
}

/**
 * State belongs to the view that pushed it: `ui/update-model-context` is that
 * view's current context (MCP Apps), not a durable record of the app. So each
 * bridge owns its entry and `destroy()` releases it, and a reopened view
 * reports nothing until it pushes. Entries are re-inserted on every push, so
 * iteration order is push order.
 */
const appStateByBridge = new Map<symbol, { appName: string; entry: AppStateEntry }>();

/**
 * Bridges whose iframe is out of the viewport (scrolled away in the chat, or
 * hidden). A bridge is on screen until its observer says otherwise, so a host
 * without `IntersectionObserver` treats every live view as on screen.
 */
const offScreenBridges = new Set<symbol>();

/**
 * The app state the prompt should carry for `appName`, from its live views.
 *
 * Several views of one app can be live at once (its full-page slot beside an
 * inline view in the chat, or two inline views), and the prompt has one state
 * slot. A view on screen beats one off screen: an inline view from an earlier
 * turn can push when it mounts, scrolled out of sight, after the slot the user
 * is looking at last pushed. Among views equally on or off screen, the most
 * recent push wins: it comes from the view the user last changed.
 */
export function getAppState(appName: string): AppStateEntry | undefined {
  let latestOnScreen: AppStateEntry | undefined;
  let latest: AppStateEntry | undefined;
  for (const [key, view] of appStateByBridge) {
    if (view.appName !== appName) continue;
    latest = view.entry;
    if (!offScreenBridges.has(key)) latestOnScreen = view.entry;
  }
  return latestOnScreen ?? latest;
}

/** Handle returned by createBridge. Used to send messages and tear down. */
export interface BridgeHandle {
  /**
   * Send a ui/notifications/tool-result notification (agent-side tool result).
   * The params are the tool's `CallToolResult`, `isError` included, so a view
   * can tell a refusal from a result.
   */
  sendToolResult(result: ExtAppsToolResultNotification["params"]): void;
  /** Send ui/notifications/host-context-changed (ext-apps spec). */
  setHostContext(context: Record<string, unknown>): void;
  /** Send ui/notifications/tool-input (ext-apps spec). */
  sendToolInput(params: { arguments: Record<string, unknown> }): void;
  /** Send ai.nimblebrain/navigate: ask the app to go to one of its trail entries. */
  navigate(id: string): void;
  /** Remove all event listeners and clean up. */
  destroy(): void;
}

/**
 * Create a bridge between the host page and an app iframe.
 *
 * Listens for postMessage events from the iframe and routes them per the
 * ext-apps spec, plus NimbleBrain ai.nimblebrain/* extensions.
 */
export function createBridge(
  iframe: HTMLIFrameElement,
  appName: string,
  callbacks?: BridgeCallbacks,
): BridgeHandle {
  let destroyed = false;
  // This app's notice budget; `ai.nimblebrain/notify` past it is refused.
  const notifyLimiter = createNoticeLimiter();
  // This bridge's key in `appStateByBridge`, released in `destroy()`.
  const stateKey = Symbol(appName);
  const screenObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          const last = entries[entries.length - 1];
          if (!last || destroyed) return;
          if (last.isIntersecting) offScreenBridges.delete(stateKey);
          else offScreenBridges.add(stateKey);
        });
  screenObserver?.observe(iframe);

  // Nothing reaches the app before it has sent `ui/notifications/initialized`
  // except the answers to its own requests — the `ui/initialize` response
  // first among them. Every notification posted earlier (host context, tool
  // input and result, task status, relayed server notifications) is held in
  // order and delivered once the handshake completes. A frame with an `id` is
  // a response: the host sends apps no requests.
  let initialized = false;
  const held: unknown[] = [];

  function postToIframe(data: unknown): void {
    if (destroyed) return;
    if (!initialized && !isResponse(data)) {
      hold(data);
      return;
    }
    // App iframes are srcdoc (see iframe.ts:createAppIframe), so their
    // origin is the opaque "null" origin. `postMessage`'s targetOrigin
    // only accepts "*", "/", or a serialised URL — literal "null" throws
    // DOMException at runtime. Tightening this requires the sandbox-proxy
    // work (iframe.ts TODO in createAppIframe) that gives iframes a real
    // origin. The iframe→parent direction (where the real leak lives) is
    // hardened via `hostContext.origin` in the handshake response below.
    iframe.contentWindow?.postMessage(data, "*");
  }

  // A frame that makes a held one redundant takes its place rather than
  // queueing behind it, so an app that never completes the handshake holds
  // one frame per thing the host has to say, not one per time it said it.
  function hold(data: unknown): void {
    const i = held.findIndex((prev) => supersedes(data, prev));
    if (i === -1) held.push(data);
    else held[i] = data;
  }

  function completeHandshake(): void {
    if (initialized) return;
    initialized = true;
    for (const data of held.splice(0)) postToIframe(data);
  }

  const closeChannel = openAppChannel(iframe, postToIframe);

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
    // lifecycle signals, and the ai.nimblebrain/* extensions are distinct `method`
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
        completeHandshake();
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
      // The tasks extension (io.modelcontextprotocol/tasks, SEP-2663):
      // tasks/get answers the flat task, its outcome inlined once terminal;
      // tasks/cancel acknowledges. tasks/result and tasks/list are not part
      // of it and fall through to `default` (-32601).
      // -----------------------------------------------------------------
      case "tasks/get":
      case "tasks/cancel":
        forwardTaskRequest(msg.method, msg.params, msg.id, appName).then(postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: ui/message — { role, content: [{ type, text, _meta? }] }
      // -----------------------------------------------------------------
      case "ui/message":
        serveUiMessage(msg, callbacks, postToIframe);
        break;

      // -----------------------------------------------------------------
      // Spec: ui/open-link
      // -----------------------------------------------------------------
      case "ui/open-link": {
        // Answered `{}` whatever happens. `noopener` makes the browser withhold
        // the handle, so `window.open` returns null on success as surely as on
        // a blocked popup — there is no failure here to report, and reporting
        // one would send every app down its fallback path. A real signal would
        // mean dropping `noopener`, which is not worth a diagnostic.
        window.open(msg.params.url, "_blank", "noopener");
        answerIfRequest(msg, {}, postToIframe);
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
        handleUpdateModelContext(msg.params, msg.id, stateKey, appName, postToIframe);
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
      // Extension: ai.nimblebrain/action — semantic host actions
      // -----------------------------------------------------------------
      case ACTION_METHOD:
        handleSynapseAction(msg.params, callbacks, appName);
        break;

      // -----------------------------------------------------------------
      // Extension: ai.nimblebrain/location — the app's trail, root first
      // -----------------------------------------------------------------
      case LOCATION_METHOD:
        callbacks?.onLocation?.(msg.params.trail);
        break;

      // -----------------------------------------------------------------
      // Extension: ai.nimblebrain/notify — a notice, labelled with the app
      // -----------------------------------------------------------------
      case NOTIFY_METHOD:
        postToIframe(handleNotify(msg.id, msg.params, notifyLimiter, callbacks));
        break;

      // -----------------------------------------------------------------
      // Extension: ai.nimblebrain/request-file — native file picker
      // -----------------------------------------------------------------
      case REQUEST_FILE_METHOD:
        handleRequestFile(msg.params, msg.id, postToIframe, readUploadLimits(callbacks));
        break;

      // -----------------------------------------------------------------
      // Extension: ai.nimblebrain/upload-files — files the app already holds
      // -----------------------------------------------------------------
      case UPLOAD_FILES_METHOD:
        if (!UPLOAD_FILES_APPS.has(appName)) {
          postToIframe({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `${UPLOAD_FILES_METHOD} is not offered to this app` },
          });
          break;
        }
        handleUploadFiles(msg.params, msg.id, postToIframe, readUploadLimits(callbacks));
        break;

      // -----------------------------------------------------------------
      // Extension: ai.nimblebrain/keydown — keyboard shortcut forwarding
      // -----------------------------------------------------------------
      case KEYDOWN_METHOD: {
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

  return {
    sendToolResult(result: ExtAppsToolResultNotification["params"]): void {
      postToIframe({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: result,
      } satisfies ExtAppsToolResultNotification);
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

    navigate(id: string): void {
      postToIframe({ jsonrpc: "2.0", method: NAVIGATE_METHOD, params: { id } });
    },

    destroy(): void {
      destroyed = true;
      held.length = 0;
      appStateByBridge.delete(stateKey);
      offScreenBridges.delete(stateKey);
      screenObserver?.disconnect();
      closeChannel();
      window.removeEventListener("message", handleMessage);
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

/** A JSON-RPC response carries the `id` of the request it answers. */
function isResponse(data: unknown): boolean {
  return typeof data === "object" && data !== null && "id" in data;
}

/**
 * Whether notification `next` says everything held notification `prev` does.
 * The host sends a host context whole, and any other notification repeated
 * verbatim adds nothing.
 */
function supersedes(next: unknown, prev: unknown): boolean {
  const a = next as { method?: unknown };
  const b = prev as { method?: unknown };
  if (a.method !== b.method) return false;
  if (a.method === "ui/notifications/host-context-changed") return true;
  return JSON.stringify(next) === JSON.stringify(prev);
}

const NOTICE_LEVELS = new Set(["success", "info", "warning", "error"]);
const MAX_NOTICE_TITLE = 120;
const MAX_NOTICE_DESCRIPTION = 500;
/** At most this many notices per app in any window of `NOTICE_WINDOW_MS`. */
const NOTICE_BURST = 5;
const NOTICE_WINDOW_MS = 10_000;

/** A per-bridge limiter: true while the app is within its notice budget. */
export function createNoticeLimiter(now: () => number = Date.now): () => boolean {
  const sent: number[] = [];
  return () => {
    const t = now();
    while (sent.length > 0 && t - (sent[0] as number) >= NOTICE_WINDOW_MS) sent.shift();
    if (sent.length >= NOTICE_BURST) return false;
    sent.push(t);
    return true;
  };
}

/**
 * Answer an `ai.nimblebrain/notify` request. Level and lengths are checked
 * here, not by the schema, so a bad value is answered with the reason rather
 * than dropped and left waiting. A burst past the limit is refused, so one app
 * cannot fill the screen.
 */
function handleNotify(
  id: string | number,
  params: { level: string; title: string; description?: string },
  withinLimit: () => boolean,
  callbacks: BridgeCallbacks | undefined,
): Record<string, unknown> {
  const refuse = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  if (!NOTICE_LEVELS.has(params.level)) {
    return refuse(-32602, "level must be one of success, info, warning, error");
  }
  const title = params.title.trim();
  if (title.length === 0 || title.length > MAX_NOTICE_TITLE) {
    return refuse(-32602, `title must be 1 to ${MAX_NOTICE_TITLE} characters`);
  }
  if (params.description !== undefined && params.description.length > MAX_NOTICE_DESCRIPTION) {
    return refuse(-32602, `description must be at most ${MAX_NOTICE_DESCRIPTION} characters`);
  }
  if (!callbacks?.onNotify) return refuse(-32601, `${NOTIFY_METHOD} is not served here`);
  if (!withinLimit()) {
    return refuse(
      -32000,
      `Too many notices: at most ${NOTICE_BURST} in ${NOTICE_WINDOW_MS / 1000} seconds`,
    );
  }
  callbacks.onNotify({
    level: params.level as AppNotice["level"],
    title,
    ...(params.description ? { description: params.description } : {}),
  });
  return { jsonrpc: "2.0", id, result: {} };
}

/**
 * Answer a request the host has just served.
 *
 * A frame with no id is a notification, and a notification takes no response:
 * an app on an older SDK sends `ui/message` and `ui/update-model-context` that
 * way, and posting a response with `id: undefined` would be a malformed frame
 * rather than a harmless one.
 */
function answerIfRequest(
  msg: { id?: unknown },
  result: Record<string, unknown>,
  postToIframe: PostToIframe,
): void {
  if (typeof msg.id !== "string" && typeof msg.id !== "number") return;
  postToIframe({ jsonrpc: "2.0", id: msg.id, result });
}

/** JSON-RPC: the method does not exist or is not served. */
const METHOD_NOT_FOUND = -32601;

/**
 * Answer a message whose method this host does not serve. A request
 * (`prompts/list`, `sampling/createMessage`, `tasks/result`, …) gets JSON-RPC
 * method-not-found, so the view's call fails at once instead of waiting on a
 * reply that never comes. A notification needs no reply, and a message with no
 * method is not a request, so both are dropped.
 */
function answerUnserved(msg: { method?: unknown; id?: unknown }, postToIframe: PostToIframe): void {
  if (typeof msg.method !== "string") return;
  if (typeof msg.id !== "string" && typeof msg.id !== "number") return;
  postToIframe({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` },
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
  const hostCapabilities = buildHostCapabilities(appName);
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
        styles: buildHostStyles(extTokens),
      },
    },
  };
  postToIframe(response);
}

/**
 * Proxy a spec `tools/call` to the app's own server through the MCP bridge and
 * forward the result (or a JSON-RPC error) to the iframe.
 *
 * Every app is scoped to its own server, whatever its name. A server the app
 * names in `_meta` or in a top-level `server` is ignored, and a qualified tool
 * name naming another server is refused. Every iframe's requests reach `/mcp`
 * as one client with one credential, so the server sees no caller to
 * attribute a call to; the bridge names the app's server on the call
 * (`callToolViaMcp`), and `/mcp` holds it to that server and to tools whose
 * `ui.visibility` includes "app".
 */
function handleToolsCall(
  params: ToolsCallParams,
  id: string,
  appName: string,
  postToIframe: PostToIframe,
): void {
  // A qualified tool name names a server, so it is a way to ask for one.
  // `callToolViaMcp` only prefixes a BARE name, so without this an iframe
  // reaches any tool in the workspace by sending the qualified form it wants
  // (`files__create`) instead of the bare one it is entitled to.
  const named = appNameFromToolName(params.name);
  if (named !== undefined && named !== appName) {
    postToIframe({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `Tool calls from "${appName}" are scoped to that server; "${params.name}" names another.`,
      },
    } satisfies UiToolResultError);
    return;
  }

  callToolViaMcp(appName, params, id).then(postToIframe, (err: unknown) => {
    postToIframe({
      jsonrpc: "2.0",
      id,
      error: toolCallError(err),
    } satisfies UiToolResultError);
  });
}

/**
 * The JSON-RPC error for a `tools/call` that got no JSON-RPC answer from `/mcp`
 * (a network failure, a body that is not one): `-32000` with its message. The
 * call may have run.
 */
function toolCallError(err: unknown): UiToolResultError["error"] {
  return { code: -32000, message: err instanceof Error ? err.message : "Tool call failed" };
}

/**
 * Proxy a spec `resources/read` to the app's own server through the MCP bridge
 * and forward the result or a JSON-RPC error to the iframe.
 */
function handleResourcesRead(
  params: ResourcesReadMessage["params"],
  id: string,
  appName: string,
  postToIframe: PostToIframe,
): void {
  // Scoped like tools/call: the app's own server, whatever it names. `/mcp`
  // would otherwise resolve the URI against every source in the workspace and
  // the user's identity sources, so the read is scoped by naming this server on
  // the wire (`readResourceViaMcp`). The URI itself passes through verbatim;
  // SSRF safety lives in the connector.
  readResourceViaMcp(appName, params.uri)
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
 * The `_meta` key that scopes a read, a listing, a task request or a tool call
 * on `/mcp` to one source. Must equal
 * `RESOURCE_SOURCE_META_KEY` in `src/api/mcp-server.ts` (the runtime image ships
 * `src/` alone, so the two cannot share a module); pinned equal by
 * `test/unit/tools/server-notifications.test.ts`.
 */
export const RESOURCE_SOURCE_META_KEY = "ai.nimblebrain/source";

/**
 * Proxy a spec `resources/list` / `resources/templates/list` to the app's own
 * server and forward the result — pagination included — or a JSON-RPC error.
 *
 * Scoped like `resources/read` and `tools/call`: the app's own server, whatever
 * it names. The bridge alone knows which iframe asked (every iframe's requests
 * reach `/mcp` as one client), so it names the server in the request's `_meta` and `/mcp`
 * lists that one source. The iframe's own `_meta` is not forwarded; only its
 * `cursor` is.
 */
function handleResourceListing(
  method: "resources/list" | "resources/templates/list",
  params: ResourcesListMessage["params"],
  id: string,
  appName: string,
  postToIframe: PostToIframe,
): void {
  const request = {
    ...(typeof params?.cursor === "string" ? { cursor: params.cursor } : {}),
    _meta: { [RESOURCE_SOURCE_META_KEY]: appName },
  };

  sendMcpRequest(method, request)
    .then((answer) => {
      if ("error" in answer) throw new Error(answer.error.message);
      postToIframe({ jsonrpc: "2.0", id, result: answer.result });
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
      if (callbacks?.onChat) {
        callbacks.onChat(textBlock.text);
      } else {
        window.dispatchEvent(new CustomEvent("nb:chat", { detail: { message: textBlock.text } }));
      }
    }
  }
}

/**
 * Serve a spec `ui/message`, and answer it when it came as a request.
 *
 * Answered either way. A request the host serves and never answers is worse
 * than one it refuses: the app waits on it, and a client with a deadline
 * reports a timeout rather than what went wrong.
 */
function serveUiMessage(
  msg: UiMessageMessage,
  callbacks: BridgeCallbacks | undefined,
  postToIframe: PostToIframe,
): void {
  let delivered = true;
  try {
    handleUiMessage(msg.params, callbacks);
  } catch (err) {
    delivered = false;
    console.error("[bridge] ui/message handler threw:", err);
  }
  answerIfRequest(msg, delivered ? {} : { isError: true }, postToIframe);
}

/**
 * Handle a spec `ui/update-model-context`: store this view's latest visible
 * state (with a text summary when present) and ack when the message had an id.
 */
function handleUpdateModelContext(
  params: UiUpdateModelContextMessage["params"],
  id: string | number | undefined,
  stateKey: symbol,
  appName: string,
  postToIframe: PostToIframe,
): void {
  const { structuredContent, content } = params;
  const summary =
    Array.isArray(content) && content.length > 0 && content[0].type === "text"
      ? content[0].text
      : undefined;
  // Delete first so the re-insert moves this view to the end of push order.
  appStateByBridge.delete(stateKey);
  appStateByBridge.set(stateKey, {
    appName,
    entry: { state: structuredContent ?? {}, summary, updatedAt: new Date().toISOString() },
  });
  // The same helper the served requests use: id `0` is an id, and a frame
  // without one is a notification that takes no answer.
  answerIfRequest({ id }, {}, postToIframe);
}

/**
 * Handle an ai.nimblebrain/action: invoke onAction, or dispatch an `nb:action`
 * event when no callback is wired. The shell resolves the action by name.
 *
 * `serverName` is the server whose view sent the action, set here and last so
 * a param of the same name from the app cannot replace it. An action about
 * "this connector" reads it; the app never names itself.
 */
function handleSynapseAction(
  params: UiActionMessage["params"],
  callbacks: BridgeCallbacks | undefined,
  appName: string,
): void {
  const { action, ...rest } = params;
  const actionParams = { ...rest, serverName: appName };
  if (callbacks?.onAction) {
    callbacks.onAction(action, actionParams);
  } else {
    window.dispatchEvent(new CustomEvent("nb:action", { detail: { action, ...actionParams } }));
  }
}

/** The picker's per-file cap when the host supplies no upload limits. */
const DEFAULT_PICKER_MAX_SIZE = 26_214_400; // 25 MB

/**
 * The host's upload limits, or `undefined` when it supplies none. Wrapped for
 * the same reason as `readHostExtensions`: a throwing callback must not leave
 * the app's picker call unanswered.
 */
function readUploadLimits(callbacks: BridgeCallbacks | undefined): UploadLimits | undefined {
  try {
    return callbacks?.getUploadLimits?.();
  } catch (err) {
    console.error("getUploadLimits threw — the picker applies no host limits:", err);
    return undefined;
  }
}

/**
 * Handle an ai.nimblebrain/request-file: open the native file picker and forward the
 * uploaded entries — or a JSON-RPC `-32602` error — back to the iframe. A refusal
 * carries `data: { files, errors }` so the app learns which files were refused and
 * which were stored anyway.
 */
function handleRequestFile(
  params: SynapseRequestFileMessage["params"] | undefined,
  id: string,
  postToIframe: PostToIframe,
  limits: UploadLimits | undefined,
): void {
  const accept = params?.accept ?? "";
  // An app may ask for less than the instance allows, never more.
  const requested = params?.maxSize ?? limits?.maxFileSize ?? DEFAULT_PICKER_MAX_SIZE;
  const maxSize = limits ? Math.min(requested, limits.maxFileSize) : requested;
  const multiple = params?.multiple ?? false;

  pickFiles(accept, maxSize, multiple, limits?.maxTotalSize)
    .then((result) => {
      postToIframe({ jsonrpc: "2.0", id, result });
    })
    .catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : "File pick failed";
      postToIframe({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: errorMsg,
          ...(err instanceof FilesRefusedError ? { data: err.data } : {}),
        },
      });
    });
}

/**
 * Store files the app already holds (`ai.nimblebrain/upload-files`), such as
 * files dropped on it. They take the picker's path from the point a pick has
 * its files: the same limits, the same upload, the same answer and refusal.
 * An entry that is not a `File` (the schema can only say "an array") refuses
 * the whole request before anything is stored.
 */
function handleUploadFiles(
  params: SynapseUploadFilesMessage["params"],
  id: string,
  postToIframe: PostToIframe,
  limits: UploadLimits | undefined,
): void {
  const answer = (promise: Promise<RequestFileResult>) =>
    promise
      .then((result) => postToIframe({ jsonrpc: "2.0", id, result }))
      .catch((err: unknown) => postToIframe({ jsonrpc: "2.0", id, error: uploadError(err) }));

  if (!params.files.every((file) => file instanceof File)) {
    answer(Promise.reject(new Error("Every entry in `files` must be a File.")));
    return;
  }
  const requested = params.maxSize ?? limits?.maxFileSize ?? DEFAULT_PICKER_MAX_SIZE;
  const maxSize = limits ? Math.min(requested, limits.maxFileSize) : requested;
  answer(processPickedFiles(params.files as File[], maxSize, limits?.maxTotalSize));
}

/** The JSON-RPC error a failed pick or upload answers, carrying a refusal's `data`. */
function uploadError(err: unknown): { code: number; message: string; data?: RequestFileRefusal } {
  return {
    code: -32602,
    message: err instanceof Error ? err.message : "File upload failed",
    ...(err instanceof FilesRefusedError ? { data: err.data } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP transport helpers — every request an app makes of its server goes to the
// 2026-07-28 leg of `/mcp/<wsId>` through `sendMcpRequest`.
//
// Rules:
//   - What reaches `/mcp` is built here from the fields the method needs, plus
//     the app's own server under `RESOURCE_SOURCE_META_KEY`. Nothing else the
//     iframe put in `_meta` is forwarded.
//   - What reaches the iframe is the server's answer verbatim: a
//     `CallToolResult` (`isError` and `structuredContent` included), a flat
//     task, a `ReadResourceResult`. Never unwrapped or rebuilt.
//   - A tool execution error is a result, never a JSON-RPC error. A JSON-RPC
//     error means no result came back: a server's refusal keeps its code and
//     `data`; a timeout (`-32001`) may follow a call that ran; no JSON-RPC
//     answer at all is `-32000`.
//   - the target-source authz is handled at the call site — these helpers
//     receive the already-resolved server name.
// ---------------------------------------------------------------------------

/**
 * Shape of a `tools/call` dispatched from an iframe. A 2025-era `task` field,
 * or anything else beside `name` and `arguments`, is not forwarded.
 */
interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Whether an app's `tools/call` opts in to the tasks extension: its `_meta`
 * client capabilities name `io.modelcontextprotocol/tasks`. Without that
 * claim the call is an ordinary one, answered with a `CallToolResult`.
 */
function optsInToTasks(meta: Record<string, unknown> | undefined): boolean {
  const capabilities = meta?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const extensions = capabilities?.extensions;
  return (
    typeof extensions === "object" &&
    extensions !== null &&
    extensions[TASKS_EXTENSION_ID] !== undefined
  );
}

/** The iframe-facing JSON-RPC response for an answer from `/mcp`. */
function toIframe(id: string | number, answer: McpAnswer): Record<string, unknown> {
  return "error" in answer
    ? { jsonrpc: "2.0", id, error: answer.error }
    : { jsonrpc: "2.0", id, result: answer.result };
}

/**
 * Forward a `tools/call` to `/mcp`. Builds the iframe-facing response envelope
 * so the caller can `postToIframe` directly.
 *
 * An app that opts in to the tasks extension is answered either a complete
 * `CallToolResult` or a flat task (`resultType: "task"`), whichever the server
 * chose; both pass through as they came.
 */
async function callToolViaMcp(
  server: string,
  params: ToolsCallParams,
  id: string,
): Promise<UiToolResultResponse | UiToolResultError | Record<string, unknown>> {
  // The `/mcp` endpoint expects a tool name whose shape encodes its scope.
  // Three transformations:
  //
  //   1. Qualified: iframes pass either `<tool>` (bare) or
  //      `<source>__<tool>` (already qualified). A bare name is qualified
  //      here with `server`, the calling app's own; an already-qualified one
  //      passes through, having been held to that same server by the call
  //      site (`handleToolsCall`) — which is where it must happen, because by
  //      here the app the call came from is no longer in scope.
  //   2. Scoped: BOTH doors dispatch the same bare `<source>__<tool>` form.
  //      The workspace a call lands in is the one in the URL (`/mcp/<wsId>`),
  //      not the name.
  //
  //      The active-workspace check stays: with no workspace there is no MCP
  //      endpoint to call, and failing here is a clearer error.
  //   3. Named: `server` goes on the wire under `RESOURCE_SOURCE_META_KEY`, as
  //      it does for reads, so `/mcp` knows the call is this app's and holds it
  //      to the MCP Apps app scope: a tool whose `ui.visibility` lacks "app" is
  //      refused there, since only the runtime knows each tool's visibility.
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
  if (!getActiveWorkspaceId()) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "No active workspace; cannot dispatch tool call.",
      },
    } satisfies UiToolResultError;
  }

  const answer = await sendMcpRequest(
    "tools/call",
    {
      name: qualifiedName,
      arguments: params.arguments ?? {},
      _meta: { [RESOURCE_SOURCE_META_KEY]: server },
    },
    { tasks: optsInToTasks(params._meta) },
  );
  return toIframe(id, answer);
}

/**
 * Forward a `resources/read` to `/mcp`, scoped to `server` — the calling app's
 * own. Resolves the ReadResourceResult (`{ contents }`); a JSON-RPC error from
 * `/mcp` rejects with its message.
 */
async function readResourceViaMcp(server: string, uri: string): Promise<Record<string, unknown>> {
  // `server` goes on the wire under `RESOURCE_SOURCE_META_KEY`, as it does for
  // listings, and `/mcp` reads from that one source. It is the only thing that
  // can: the bridge sends every iframe's requests as one client, so without it
  // a read resolves across the whole workspace and the user's files.
  const answer = await sendMcpRequest("resources/read", {
    uri,
    _meta: { [RESOURCE_SOURCE_META_KEY]: server },
  });
  if ("error" in answer) throw new Error(answer.error.message);
  return answer.result;
}

// ---------------------------------------------------------------------------
// Tasks — `tasks/get` and `tasks/cancel` of the tasks extension
// ---------------------------------------------------------------------------

/** The task methods the bridge forwards. */
type TaskMethod = "tasks/get" | "tasks/cancel";

/** Params accepted on the two tasks/* iframe messages. */
interface TasksParams {
  taskId: string;
  [key: string]: unknown;
}

/**
 * Forward a `tasks/get` or `tasks/cancel` to `/mcp`, scoped to the app's own
 * server. Returns the full JSON-RPC response (success or error) ready to
 * `postToIframe`.
 *
 * What reaches `/mcp` is the `taskId` and the scope, and nothing else the
 * iframe sent. The scope is the app's own server, whatever it names, under
 * `RESOURCE_SOURCE_META_KEY`, as for a resource read: `/mcp` answers only a
 * task that server ran, and any other as not found (`-32602`). The answer
 * passes through: `tasks/get` the flat task, with `result` or `error` inlined
 * once it is `completed` or `failed`; an `input_required` status too, which
 * the app handles. A request that got no JSON-RPC answer is `-32000`.
 */
async function forwardTaskRequest(
  method: TaskMethod,
  params: TasksParams | undefined,
  id: string | number,
  appName: string,
): Promise<Record<string, unknown>> {
  const scoped = { taskId: params?.taskId, _meta: { [RESOURCE_SOURCE_META_KEY]: appName } };
  try {
    return toIframe(id, await sendMcpRequest(method, scoped));
  } catch (err) {
    const error: McpError = {
      code: -32000,
      message: err instanceof Error ? err.message : "Task request failed",
    };
    return { jsonrpc: "2.0", id, error };
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
 * workspace file store via `POST /v1/workspaces/:wsId/resources`. Returns the
 * persisted `FileEntry` entries — bytes never traverse the
 * iframe-bridge boundary, so files of any size the server's
 * `maxFileSize` allows work without base64 inflation or hitting the
 * 1 MB tool-call JSON cap.
 *
 * `maxSize` and `maxTotalSize` are enforced client-side as a fast-fail; the
 * server is still the source of truth (`getFilesConfig()`).
 */
async function pickFiles(
  accept: string,
  maxSize: number,
  multiple: boolean,
  maxTotalSize: number | undefined,
): Promise<RequestFileResult> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    // A cancel fires no `change`, so the picker settles on the input's own
    // `cancel` event, which fires exactly when the user dismisses the dialog
    // without choosing.
    //
    // Never a `window` focus heuristic. This dialog is opened from a click
    // inside an app iframe, and dismissing it does not reliably give the
    // shell's window a matching `focus`, so a focus-gated settle can simply
    // never fire — leaving the caller's picker pending with no error and
    // nothing in the console. Installing one before `click()` is worse: a
    // `focus` delivered as the dialog opens consumes it and answers
    // `{ files: [] }` while the dialog is still on screen, so the selection the
    // user then makes is swallowed by the already-settled promise.
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        document.body.removeChild(input);
        resolve({ files: [] });
      }
    };

    input.addEventListener("cancel", cleanup, { once: true });

    input.addEventListener("change", () => {
      resolved = true;
      document.body.removeChild(input);
      // Validate + upload off-thread; settle the picker Promise with the
      // result (or the size/upload error) exactly as the change fires.
      processPickedFiles(input.files, maxSize, maxTotalSize).then(resolve, reject);
    });

    input.click();
  });
}

/**
 * The `ai.nimblebrain/request-file` result. A JSON-RPC result is an object, and MCP
 * types it as one, so the entries are wrapped rather than sent as a bare array
 * — a client that validates against the spec cannot parse a bare array or
 * `null` and never settles the call. One shape covers both pickers: the SDK's
 * `pickFile` takes the first entry, `pickFiles` takes them all, and a cancel is
 * an empty list rather than a second shape.
 *
 * The call resolves only when every picked file was stored. When any was refused
 * it rejects with this shape as the JSON-RPC `error.data`: `files` are the entries
 * that were stored anyway, `errors` name each refused file and why. It is an error
 * rather than an extra result field because the SDK's `pickFiles` returns
 * `result.files` alone, so a result field would never reach the app.
 */
interface RequestFileResult {
  files: FileEntry[];
}

interface RequestFileRefusal extends RequestFileResult {
  errors: string[];
}

/** How many refusals the error message names before summarising the rest. */
const REFUSALS_IN_MESSAGE = 3;

/** Some picked files were refused. `data` becomes the JSON-RPC `error.data`. */
class FilesRefusedError extends Error {
  readonly data: RequestFileRefusal;

  constructor(picked: number, data: RequestFileRefusal) {
    const named = data.errors.slice(0, REFUSALS_IN_MESSAGE).join("; ");
    const more = data.errors.length - REFUSALS_IN_MESSAGE;
    const stored = data.files.length > 0 ? ` ${data.files.length} stored.` : "";
    super(
      `${data.errors.length} of ${picked} ${picked === 1 ? "file" : "files"} refused: ${named}${more > 0 ? `; and ${more} more` : ""}.${stored}`,
    );
    this.name = "FilesRefusedError";
    this.data = data;
  }
}

/**
 * The per-file reasons the upload route puts in `details.errors` when it refuses
 * every file. Any other failure (auth, a request over the total limit, the
 * network) names no file, and answers `undefined`.
 */
function refusedFileErrors(err: unknown): string[] | undefined {
  const errors = (err as { details?: { errors?: unknown } } | null)?.details?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  return errors.every((e) => typeof e === "string") ? errors : undefined;
}

/**
 * Validate picked files against `maxSize` and `maxTotalSize`, upload them via
 * `POST /v1/workspaces/:wsId/resources`, and resolve to the persisted entries —
 * an empty list when nothing was chosen. Throws `FilesRefusedError` when any
 * file was refused: every oversize file, before anything is uploaded, or the
 * files the server refused, after it stored the rest. A set over the total is
 * refused before upload with an error naming the limit. Any other upload
 * failure is rethrown as is.
 */
async function processPickedFiles(
  files: FileList | readonly File[] | null,
  maxSize: number,
  maxTotalSize: number | undefined,
): Promise<RequestFileResult> {
  if (!files || files.length === 0) return { files: [] };
  const selected = Array.from(files);
  const oversize = selected
    .filter((file) => file.size > maxSize)
    .map((file) => `File "${file.name}" exceeds maximum size of ${humanBytes(maxSize)}`);
  if (oversize.length > 0) {
    throw new FilesRefusedError(selected.length, { files: [], errors: oversize });
  }
  // Over the total, the server refuses the whole request before reading it, so
  // no file is at fault and nothing is stored: a plain error, not a refusal.
  const total = selected.reduce((sum, file) => sum + file.size, 0);
  if (maxTotalSize !== undefined && total > maxTotalSize) {
    throw new Error(
      `The selected files total ${humanBytes(total)}; an upload can be up to ${humanBytes(maxTotalSize)}.`,
    );
  }
  let result: Awaited<ReturnType<typeof uploadResource>>;
  try {
    result = await uploadResource(selected);
  } catch (err) {
    const errors = refusedFileErrors(err);
    if (errors) throw new FilesRefusedError(selected.length, { files: [], errors });
    throw err;
  }
  if (result.errors && result.errors.length > 0) {
    throw new FilesRefusedError(selected.length, { files: result.files, errors: result.errors });
  }
  return { files: result.files };
}

/** Trigger a browser file download via a temporary anchor tag. */
function triggerDownload(data: string | Uint8Array, filename: string, mimeType: string): void {
  const blob = new Blob([data as BlobPart], { type: mimeType });
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
