// ---------------------------------------------------------------------------
// MCP App Bridge — postMessage Handler
//
// Implements the host side of the MCP Apps protocol (ext-apps spec 2026-01-26).
// Routes iframe messages to platform APIs and forwards events back to iframes.
//
// Spec-compliant methods:
//   tools/call, resources/read, tasks/get, tasks/result, tasks/cancel,
//   ui/initialize, ui/notifications/initialized,
//   ui/notifications/tool-result, ui/notifications/tool-input,
//   ui/notifications/host-context-changed, ui/notifications/size-changed,
//   ui/open-link, ui/message, ui/update-model-context
//
// Spec-compliant notifications forwarded host→iframe:
//   notifications/tasks/status (subscribed once per bridge instance)
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
  type GetTaskPayloadRequest,
  GetTaskPayloadResultSchema,
  type GetTaskRequest,
  GetTaskResultSchema,
  TaskStatusNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMcpBridgeClient } from "../mcp-bridge-client";
import { getHostThemeMode, getSpecThemeTokens, getThemeTokens } from "./theme";
import type {
  BridgeCallbacks,
  ExtAppsHostContextChangedNotification,
  ExtAppsInitializeResponse,
  ExtAppsToolInputNotification,
  UiDataChangedMessage,
  UiInitializeMessage,
  UiStateLoadedMessage,
  UiToolResultError,
  UiToolResultMessage,
  UiToolResultResponse,
} from "./types";

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
 * Internal bundle names allowed to cross-call other sources by setting
 * `params.server` on tools/call or resources/read. External iframe apps
 * are strictly scoped to their own server. Defined once at module scope so
 * both message-type cases share the same trust list.
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

    // --- ext-apps protocol: ui/initialize REQUEST (has id + method) ---
    // JSON-RPC 2.0 (and the ext-apps spec by extension) allows request IDs to
    // be strings OR numbers. Clients built on `@modelcontextprotocol/ext-apps`
    // (including `@reboot-dev/reboot-react`) send numeric IDs starting at 0.
    // An earlier string-only check here silently dropped those handshakes,
    // leaving the iframe stuck at "Connecting to MCP host...".
    if (
      msg.method === "ui/initialize" &&
      (typeof msg.id === "string" || typeof msg.id === "number")
    ) {
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
      // Wrapped in try/catch: a throwing callback would otherwise drop the
      // entire `ui/initialize` response and hang the iframe at "Connecting…".
      let extensions: Record<string, unknown> = {};
      try {
        extensions = callbacks?.getHostExtensions?.() ?? {};
      } catch (err) {
        console.error("getHostExtensions threw — proceeding with no extensions:", err);
      }
      const hostCapabilities = {
        openLinks: {},
        serverTools: {},
        logging: {},
        tasks: {
          cancel: {},
          requests: { tools: { call: {} } },
        },
      };
      const response: ExtAppsInitializeResponse = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "nimblebrain", version: "1.0.0" },
          hostCapabilities,
          hostContext: {
            ...extensions,
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
      return;
    }

    // --- ext-apps protocol: ui/notifications/initialized ---
    if (msg.method === "ui/notifications/initialized") {
      callbacks?.onInitialized?.();
      return;
    }

    // --- ext-apps protocol: ui/notifications/request-teardown ---
    if (msg.method === "ui/notifications/request-teardown") return;

    if (!("method" in msg)) return;

    switch (msg.method) {
      // -----------------------------------------------------------------
      // Spec: tools/call — standard MCP proxying
      // Returns CallToolResult: { content, structuredContent?, isError? }
      // -----------------------------------------------------------------
      case "tools/call": {
        const { id, params } = msg;

        // Security: tool calls are scoped to appName by default. Internal
        // bundles (`INTERNAL_APPS`) can specify `params.server` to
        // cross-call other sources. The `/mcp` endpoint is workspace-
        // scoped but doesn't know about the "internal app" concept, so
        // this authz check stays in the bridge.
        const server = INTERNAL_APPS.has(appName) && params.server ? params.server : appName;

        callToolViaMcp(server, params, id).then(postToIframe, (err: unknown) => {
          const errorMsg = err instanceof Error ? err.message : "Tool call failed";
          const errorResponse: UiToolResultError = {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: errorMsg },
          };
          postToIframe(errorResponse);
        });
        break;
      }

      // -----------------------------------------------------------------
      // Spec: resources/read — standard MCP resource reads
      // Returns ReadResourceResult: { contents: [{ uri, mimeType?, text?, blob? }] }
      // -----------------------------------------------------------------
      case "resources/read": {
        const { id, params } = msg;
        // Same trust list as tools/call. The URI itself passes through
        // verbatim to the server — SSRF safety lives in the bundle, not
        // the host, because only URIs the bundle advertises via
        // resources/list will resolve anyway.
        const server = INTERNAL_APPS.has(appName) && params.server ? params.server : appName;

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
        break;
      }

      // -----------------------------------------------------------------
      // Spec: tasks/get — non-blocking fetch of current task state.
      // Tasks surface is MCP-only; when the flag is off the iframe SDK
      // won't call it (capability isn't advertised), so there's no REST
      // fallback path here.
      // -----------------------------------------------------------------
      case "tasks/get": {
        const { id, params } = msg;
        forwardTaskRequest(TASKS_GET_METHOD, params, GetTaskResultSchema, id).then(postToIframe);
        break;
      }

      // -----------------------------------------------------------------
      // Spec: tasks/result — blocks until terminal; returns the payload
      // of the original request (for tools/call, a CallToolResult).
      // -----------------------------------------------------------------
      case "tasks/result": {
        const { id, params } = msg;
        forwardTaskRequest(TASKS_RESULT_METHOD, params, GetTaskPayloadResultSchema, id).then(
          postToIframe,
        );
        break;
      }

      // -----------------------------------------------------------------
      // Spec: tasks/cancel — best-effort cancel; returns the (final)
      // task state. Cancelling a terminal task surfaces as `-32602` per
      // SPEC_REFERENCE §8.
      // -----------------------------------------------------------------
      case "tasks/cancel": {
        const { id, params } = msg;
        forwardTaskRequest(TASKS_CANCEL_METHOD, params, CancelTaskResultSchema, id).then(
          postToIframe,
        );
        break;
      }

      // -----------------------------------------------------------------
      // Spec: ui/message — { role, content: [{ type, text, _meta? }] }
      // -----------------------------------------------------------------
      case "ui/message": {
        const params = msg.params;
        // Spec format: content is array of content blocks
        if (Array.isArray(params.content)) {
          const textBlock = params.content.find((b: Record<string, unknown>) => b.type === "text");
          if (textBlock?.text) {
            const context = textBlock._meta?.context;
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
        break;
      }

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
      case "ui/update-model-context": {
        const { structuredContent, content } = msg.params;
        const summary =
          Array.isArray(content) && content.length > 0 && content[0].type === "text"
            ? content[0].text
            : undefined;
        appStateStore.set(appName, {
          state: structuredContent ?? {},
          summary,
          updatedAt: new Date().toISOString(),
        });
        if (msg.id) {
          postToIframe({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
        break;
      }

      // -----------------------------------------------------------------
      // Extension: synapse/action — semantic host actions
      // -----------------------------------------------------------------
      case "synapse/action": {
        const { action, ...actionParams } = msg.params;
        if (action === "navigate" && actionParams.route && callbacks?.onNavigate) {
          callbacks.onNavigate(actionParams.route as string);
          break;
        }
        if (callbacks?.onAction) {
          callbacks.onAction(action, actionParams);
        } else {
          window.dispatchEvent(
            new CustomEvent("nb:action", { detail: { action, ...actionParams } }),
          );
        }
        break;
      }

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
      case "synapse/request-file": {
        const { id, params } = msg;
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
        break;
      }

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
//   - `params.server` authz is handled at the call site — this helper
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
  const client = await getMcpBridgeClient();

  // The `/mcp` endpoint advertises tool names as `<source>__<tool>`, so
  // the wire `tools/call` must use the qualified form (see
  // `mcp-server.ts::CallToolRequestSchema`). Iframes that already pass a
  // qualified name flow through unchanged; bare names get prefixed with
  // the resolved `server` (post-INTERNAL_APPS authz).
  const wireName = params.name.includes("__") ? params.name : `${server}__${params.name}`;

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
          name: wireName,
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
      name: wireName,
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
}

/**
 * Forward a `resources/read` through the MCP SDK bridge client. Returns the
 * ReadResourceResult shape (`{ contents }`) so the caller can assemble the
 * JSON-RPC response envelope for the iframe.
 */
async function readResourceViaMcp(server: string, uri: string): Promise<{ contents: unknown[] }> {
  const client = await getMcpBridgeClient();

  // Per spec, `resources/read` carries only the URI — the resource is
  // namespaced by the bundle that authored it, not by request params.
  // `server` is consumed by the INTERNAL_APPS authz at the call site
  // (cross-call permission); it doesn't appear on the wire here.
  void server;
  const result = await client.readResource({ uri });
  return { contents: result.contents as unknown[] };
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

/** Narrow set of params accepted on the three tasks/* iframe messages. */
interface TasksParams {
  taskId: string;
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
 * Forward a `tasks/*` request through the MCP bridge client. Returns the
 * full JSON-RPC response (success or error) ready to `postToIframe`.
 *
 * The caller picks the method constant + result schema; params are passed
 * through verbatim (we never invent fields). Errors are mapped via
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
): Promise<Record<string, unknown>> {
  try {
    const client = await getMcpBridgeClient();
    const result = await client.request({ method, params }, schema);
    // Forward the result verbatim (Non-Negotiable Rule 4: never unwrap).
    return { jsonrpc: "2.0", id, result };
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

/** Open native file picker, read selected file(s), and return base64-encoded results. */
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

    input.addEventListener("change", async () => {
      resolved = true;
      document.body.removeChild(input);

      const files = input.files;
      if (!files || files.length === 0) {
        resolve(multiple ? [] : null);
        return;
      }

      try {
        const results = [];
        for (const file of Array.from(files)) {
          if (file.size > maxSize) {
            reject(
              new Error(
                `File "${file.name}" exceeds maximum size of ${Math.round(maxSize / 1_048_576)} MB`,
              ),
            );
            return;
          }
          const buffer = await file.arrayBuffer();
          const base64 = btoa(
            new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
          );
          results.push({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            base64Data: base64,
          });
        }
        resolve(multiple ? results : (results[0] ?? null));
      } catch (err) {
        reject(err);
      }
    });

    input.click();
  });
}

/** Trigger a browser file download via a temporary anchor tag. */
function triggerDownload(data: Blob, filename: string, mimeType: string): void {
  const blob = data.type === mimeType ? data : new Blob([data], { type: mimeType });
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
