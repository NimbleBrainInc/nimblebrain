// ---------------------------------------------------------------------------
// MCP App Bridge — postMessage Handler
//
// Implements the host side of the MCP Apps protocol (ext-apps spec 2026-01-26).
// Routes iframe messages to platform APIs and forwards events back to iframes.
//
// Spec-compliant methods:
//   tools/call, resources/read, ui/initialize, ui/notifications/initialized,
//   ui/notifications/tool-result, ui/notifications/tool-input,
//   ui/notifications/host-context-changed, ui/notifications/size-changed,
//   ui/open-link, ui/message, ui/update-model-context
//
// NimbleBrain extensions (synapse/ namespace — no spec equivalent):
//   synapse/action, synapse/download-file, synapse/data-changed,
//   synapse/persist-state, synapse/state-loaded, synapse/keydown,
//   synapse/request-file
// ---------------------------------------------------------------------------

import { callTool, readResource } from "../api/client";
import { getHostThemeMode, getThemeTokens } from "./theme";
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
    if (msg.method === "ui/initialize" && typeof msg.id === "string") {
      const extMode = getHostThemeMode();
      const extTokens = getThemeTokens(extMode);
      const response: ExtAppsInitializeResponse = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "nimblebrain", version: "1.0.0" },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            logging: {},
          },
          hostContext: {
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

        // Security: tool/resource calls are scoped to appName by default.
        // Internal bundles can specify params.server to cross-call other
        // sources. INTERNAL_APPS is defined once at module scope so both
        // tools/call and resources/read share the same trust list.
        const server = INTERNAL_APPS.has(appName) && params.server ? params.server : appName;
        callTool(server, params.name, params.arguments)
          .then((result) => {
            if (result.isError) {
              const errorText =
                result.content
                  ?.map((b) => b.text ?? "")
                  .filter(Boolean)
                  .join("\n") || "Tool error";
              const errorResponse: UiToolResultError = {
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: errorText },
              };
              postToIframe(errorResponse);
              return;
            }
            // Forward the full CallToolResult per MCP spec
            const response: UiToolResultResponse = {
              jsonrpc: "2.0",
              id,
              result: {
                content: result.content,
                structuredContent: result.structuredContent,
              },
            };
            postToIframe(response);
          })
          .catch((err: unknown) => {
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
        // Same trust list as tools/call. The URI itself is passed through
        // verbatim to the server — SSRF safety lives in the bundle, not
        // the host, because only URIs the bundle advertises via
        // resources/list will resolve anyway.
        const server = INTERNAL_APPS.has(appName) && params.server ? params.server : appName;
        readResource(server, params.uri)
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
      const msg: ExtAppsHostContextChangedNotification = {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: context,
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
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
function triggerDownload(data: string, filename: string, mimeType: string): void {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    bytes[i] = data.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
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
