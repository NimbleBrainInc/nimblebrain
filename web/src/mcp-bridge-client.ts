// ---------------------------------------------------------------------------
// MCP Bridge Client — one JSON-RPC request at a time to the active workspace's
// `/mcp/<wsId>`, on MCP 2026-07-28
//
// The iframe bridge sends every request it forwards for an app (`tools/call`,
// `resources/read`, `resources/list`, `resources/templates/list`, `tasks/get`,
// `tasks/cancel`) through `sendMcpRequest`. Each request carries the 2026-07-28
// `_meta` envelope (protocol version, client info, client capabilities), the
// only revision `/mcp/<wsId>` serves. It is stateless: there is no handshake
// and no session, so nothing here is cached between requests, and a workspace
// switch or a logout needs no teardown. The URL is read from the active
// workspace and the credentials from the auth state on every request.
//
// The wire is driven here rather than by the SDK `Client` because the tasks
// extension (`io.modelcontextprotocol/tasks`, SEP-2663) answers an opted-in
// `tools/call` with a flat task (`resultType: "task"`), which the SDK v2
// `Client` refuses, and the SDK sends no `tasks/*` request at all
// (typescript-sdk#2189). The runtime's own task client
// (`src/tools/mcp-task-client.ts`) drives the same wire for the same reason.
// ---------------------------------------------------------------------------

import type { JSONRPCErrorResponse } from "@modelcontextprotocol/client";
import { fetchWithRefresh, getActiveWorkspaceId, getAuthToken } from "./api/client";
import { TASKS_EXTENSION_ID } from "./bridge/host-capabilities";

/** The protocol revision `/mcp/<wsId>` serves, named in every request's `_meta` envelope. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * The reserved `_meta` keys of the 2026-07-28 envelope. Spelled here, not
 * imported from the SDK, so the backend unit suite (which loads this module
 * through the bridge on root dependencies alone) gets no SDK value import.
 */
export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Who sends the bridge's requests. */
const CLIENT_INFO = { name: "nimblebrain-web", version: "1.0.0" } as const;

/**
 * How long a request waits for its answer. A call that outlasts it may still
 * have run; it answers `-32001`, the code the MCP SDKs use for a request
 * timeout. A long call is meant to run as a task, whose `tools/call` answers
 * as soon as the task exists.
 */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

/** JSON-RPC error codes this module answers with. */
const REQUEST_TIMEOUT = -32001;

/** A JSON-RPC error object. */
export type McpError = JSONRPCErrorResponse["error"];

/**
 * What `/mcp` answered: the result, or the JSON-RPC error it sent instead. A
 * request that got no answer at all (a network failure, a non-JSON-RPC body)
 * rejects instead.
 */
export type McpAnswer = { result: Record<string, unknown> } | { error: McpError };

export interface McpRequestOptions {
  /** Opt this request in to the tasks extension, so the server may answer a `tools/call` with a task. */
  tasks?: boolean;
  /** Overrides {@link MCP_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

let nextId = 0;

/**
 * Send one request to the active workspace's `/mcp/<wsId>` and
 * resolve with its answer.
 *
 * Resolves `{ result }` or `{ error }` for every JSON-RPC answer, the server's
 * refusals included, and `{ error: { code: -32001 } }` when no answer came
 * within the timeout. Rejects when there is no active workspace or no
 * JSON-RPC answer came back (a network failure, an unparseable body).
 */
export async function sendMcpRequest(
  method: string,
  params: Record<string, unknown>,
  options: McpRequestOptions = {},
): Promise<McpAnswer> {
  const workspaceId = getActiveWorkspaceId();
  if (!workspaceId) throw new Error("No active workspace; there is no MCP endpoint to call.");

  // Resolve `/mcp/<wsId>` against the page origin. In dev, Vite proxies
  // `/mcp/*` to the API; in prod the web shell is served from the same origin.
  const url = new URL(
    mcpEndpointPath(workspaceId),
    globalThis.location?.origin ?? "http://localhost",
  );
  const { headers, body } = buildMcpRequest(`nb-bridge-${++nextId}`, method, params, options);

  const timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await mcpFetch(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return await readMcpAnswer(response);
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        error: { code: REQUEST_TIMEOUT, message: `Request timed out after ${timeoutMs}ms` },
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The workspace's MCP endpoint path. */
export function mcpEndpointPath(workspaceId: string): string {
  return `/mcp/${encodeURIComponent(workspaceId)}`;
}

/**
 * The headers and body of one 2026-07-28 request: the `_meta` envelope merged
 * under the caller's own `_meta`, and the standard headers the server checks
 * against the body (`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for a
 * method that names its target). No credentials: `sendMcpRequest` adds them.
 */
export function buildMcpRequest(
  id: string,
  method: string,
  params: Record<string, unknown>,
  options: Pick<McpRequestOptions, "tasks"> = {},
): { headers: Record<string, string>; body: string } {
  const callerMeta = params._meta as Record<string, unknown> | undefined;
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...callerMeta,
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: CLIENT_INFO,
        [CLIENT_CAPABILITIES_META_KEY]: options.tasks
          ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
          : {},
      },
    },
  };
  const name = mcpNameOf(method, params);
  return {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": encodeHeaderValue(name) } : {}),
    },
    body: JSON.stringify(body),
  };
}

/**
 * The answer in a `/mcp` response: a JSON body, or the JSON-RPC response among
 * the events of an SSE body. A JSON-RPC error is answered whatever the HTTP
 * status (`/mcp` answers a header mismatch `400` with one); a response
 * that carries none rejects with its status.
 */
export async function readMcpAnswer(response: Response): Promise<McpAnswer> {
  const text = await response.text();
  const message = jsonRpcResponseIn(text, response.headers.get("content-type") ?? "");
  if (message && "error" in message && isJsonRpcError(message.error)) {
    return { error: message.error };
  }
  if (message && response.ok && "result" in message && isObject(message.result)) {
    return { result: message.result };
  }
  throw new Error(
    `MCP request failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The target a method names, for `Mcp-Name`: a tool, a resource, a task. */
function mcpNameOf(method: string, params: Record<string, unknown>): string | undefined {
  const value =
    method === "resources/read"
      ? params.uri
      : method.startsWith("tasks/")
        ? params.taskId
        : params.name;
  return typeof value === "string" ? value : undefined;
}

/**
 * An HTTP header value for `value`: verbatim when it is visible ASCII with no
 * surrounding space, otherwise base64 of its UTF-8 inside the `=?base64?…?=`
 * sentinel the server decodes (SEP-2243).
 */
function encodeHeaderValue(value: string): string {
  const plain =
    value.length > 0 &&
    value === value.trim() &&
    !(value.startsWith("=?base64?") && value.endsWith("?=")) &&
    /^[\t\x20-\x7e]*$/.test(value);
  if (plain) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

type JsonRpcMessage = { id?: unknown; result?: unknown; error?: unknown };

function jsonRpcResponseIn(text: string, contentType: string): JsonRpcMessage | null {
  if (!contentType.includes("text/event-stream")) return parseObject(text);
  // An SSE body: the response is the event that carries a result or an error.
  // Any notification the server sent first is not the answer.
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const message = parseObject(data);
    if (message && ("result" in message || "error" in message)) return message;
  }
  return null;
}

function parseObject(text: string): JsonRpcMessage | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcError(value: unknown): value is McpError {
  return isObject(value) && typeof value.code === "number" && typeof value.message === "string";
}

/**
 * Fetch with the caller's credentials, read per request: tokens rotate, and the
 * browser tab outlives any one of them. The workspace is in the URL, not a
 * header.
 *
 * Cookie mode (`authToken === "__cookie__"`) sends no `Authorization` header;
 * `credentials: "include"` carries the session cookie.
 *
 * Goes through the SHARED `fetchWithRefresh`, not `globalThis.fetch`. Reading
 * the token per request only picks up a refresh somebody else performed. A
 * user parked on a rendered app generates nothing but bridge traffic, so with a
 * bare `fetch` the session expires underneath them and every `/mcp` call 401s
 * until a page reload. The REST client's instance coalesces concurrent
 * refreshes through one in-flight promise, so bridge and REST traffic hitting
 * 401 together perform one refresh, not two racing a rotating refresh token.
 */
async function mcpFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getAuthToken();
  if (token && token !== "__cookie__") headers.set("Authorization", `Bearer ${token}`);
  return fetchWithRefresh(url, { ...init, headers, credentials: "include" });
}
