import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps";
import type { ToolInput } from "../_generated/platform-schemas/catalog";
import type {
  ApiError,
  BootstrapResponse,
  ChatRequest,
  ChatResult,
  ChatStreamEventMap,
  ChatStreamEventType,
  HealthInfo,
  PlacementEntry,
  ToolCallResult,
} from "../types";
import { createFetchWithRefresh } from "./fetch-with-refresh";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

let authToken: string | null = null;
let onAuthError: (() => void) | null = null;
let activeWorkspaceId: string | null = null;
let platformVersion: string | null = null;
let platformBuildSha: string | null = null;

/** Get the current auth token. */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Hook fired whenever the auth token or active workspace changes — used by
 * stateful clients that hold a session bound to one of those values. The
 * MCP bridge client (`mcp-bridge-client.ts`) registers here at module load
 * so its cached transport (workspace-bound `Mcp-Session-Id`) gets dropped
 * on workspace switch / logout instead of silently servicing the wrong
 * tenant. Stateless callers (REST helpers, `fetchWithRefresh`) read the
 * current token / workspace ID per-request and need no hook.
 */
let onAuthLifecycleChange: (() => void) | null = null;
export function setAuthLifecycleHandler(handler: (() => void) | null): void {
  onAuthLifecycleChange = handler;
}

/** Set the bearer token used for all authenticated requests. */
export function setAuthToken(token: string | null): void {
  if (authToken === token) return;
  authToken = token;
  onAuthLifecycleChange?.();
}

/** Set the active workspace ID included as X-Workspace-Id header. */
export function setActiveWorkspaceId(id: string | null): void {
  if (activeWorkspaceId === id) return;
  activeWorkspaceId = id;
  onAuthLifecycleChange?.();
}

/** Get the active workspace ID (for modules that build their own headers). */
export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

/** Register a callback invoked on 401 responses. */
export function setOnAuthError(callback: (() => void) | null): void {
  onAuthError = callback;
}

/** Store platform version info from bootstrap. */
export function setPlatformVersion(version: string, buildSha: string | null): void {
  platformVersion = version;
  platformBuildSha = buildSha;
}

/** Get platform version info. */
export function getPlatformVersion(): { version: string | null; buildSha: string | null } {
  return { version: platformVersion, buildSha: platformBuildSha };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (authToken && authToken !== "__cookie__") {
    h.Authorization = `Bearer ${authToken}`;
  }
  if (activeWorkspaceId) {
    h["X-Workspace-Id"] = activeWorkspaceId;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Silent token refresh interceptor
// ---------------------------------------------------------------------------

const refreshInterceptor = createFetchWithRefresh({
  // Late-bind globalThis.fetch on each call so tests can swap in a mock; in
  // production globalThis.fetch is stable so this is equivalent to .bind().
  // Cast widens the call signature back to `typeof fetch` (the option type
  // includes the static .preconnect method, which the interceptor never calls).
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
  refreshUrl: `${API_BASE}/v1/auth/refresh`,
  onAuthError: () => onAuthError?.(),
});

const fetchWithRefresh = refreshInterceptor;

// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRefresh(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...headers(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unauthorized",
      message: "Unauthorized",
    }));
    throw new ApiClientError(body.error, body.message, 401);
  }

  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw new ApiClientError(body.error, body.message, res.status, body.details);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

// ---------------------------------------------------------------------------
// Resources & Tools
// ---------------------------------------------------------------------------

/**
 * Strip the `ui://` scheme prefix from a resource URI, returning the path
 * that `/v1/apps/:name/resources/*` expects. Single source of truth for
 * the transform — consumers rendering iframes from `resourceUri` call this
 * rather than redoing the regex locally.
 */
export function uiPathFromUri(uri: string): string {
  return uri.replace(/^ui:\/\//, "");
}

/**
 * Fetch an app's ui:// resource. Used by the iframe mounting path
 * (SlotRenderer, InlineAppView) to load app views into sandboxed frames.
 *
 * Returns the HTML text plus any `_meta.ui.*` the server attached (ext-apps
 * extension — CSP domain allowlists, permissions, layout hints). The endpoint
 * returns a JSON envelope mirroring the MCP `ReadResourceResult` shape so
 * callers see the protocol directly; callers that only want the HTML
 * destructure `{ html }` and ignore `metaUi`.
 *
 * For binary artifacts (PDFs, images, etc.), use {@link readResource}.
 */
export async function getResources(
  appName: string,
  path: string,
): Promise<{ html: string; metaUi?: McpUiResourceMeta }> {
  const res = await fetchWithRefresh(
    `${API_BASE}/v1/apps/${encodeURIComponent(appName)}/resources/${path}`,
    {
      credentials: "include",
      headers: headers(),
    },
  );

  if (res.status === 401) {
    throw new ApiClientError("unauthorized", "Unauthorized", 401);
  }

  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw new ApiClientError(body.error, body.message, res.status, body.details);
  }

  const envelope = (await res.json()) as {
    contents?: Array<{ text?: string; _meta?: { ui?: McpUiResourceMeta } }>;
  };
  const entry = envelope.contents?.[0];
  if (!entry) {
    throw new ApiClientError("invalid_response", "resource response missing `contents[0]`", 500);
  }
  return {
    html: entry.text ?? "",
    metaUi: entry._meta?.ui,
  };
}

/**
 * Invoke a tool directly.
 *
 * `args` is type-checked against the catalog at `@platform/schemas/catalog`.
 * For a `(server, tool)` pair registered there, callers must pass a payload
 * matching the schema-derived type. Unregistered pairs fall through to
 * `Record<string, unknown>` so untyped legacy callers continue to compile
 * while sources migrate one by one.
 */
export async function callTool<S extends string, T extends string>(
  server: S,
  tool: T,
  args?: ToolInput<S, T>,
): Promise<ToolCallResult> {
  return request<ToolCallResult>("/v1/tools/call", {
    method: "POST",
    body: JSON.stringify({ server, tool, arguments: args }),
  });
}

/**
 * MCP ReadResourceResult entry. Exactly one of `text` or `blob` is populated;
 * `blob` is a base64-encoded string per spec.
 */
export interface ReadResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ReadResourceResult {
  contents: ReadResourceContent[];
}

/** Read an MCP resource via POST /v1/resources/read. */
export async function readResource(server: string, uri: string): Promise<ReadResourceResult> {
  return request<ReadResourceResult>("/v1/resources/read", {
    method: "POST",
    body: JSON.stringify({ server, uri }),
  });
}

/**
 * A workspace file as returned by the upload endpoint. Mirrors the
 * server-side `FileEntry` (src/files/types.ts), narrowed to the fields
 * the client cares about — no `tags`/`source`/`description` here yet
 * because the picker flow doesn't set them and consumers don't read them.
 * Add fields when a consumer needs them.
 */
export interface WorkspaceFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface UploadResourceResult {
  files: WorkspaceFile[];
  errors?: string[];
}

/**
 * Upload one or more files to the workspace file store via multipart
 * POST. Bytes go over the right pipe (HTTP multipart, streamed) instead
 * of being base64-encoded into a tool-call argument.
 */
export async function uploadResource(files: File[]): Promise<UploadResourceResult> {
  const formData = new FormData();
  // Use `files` (plural) to match `streamChatMultipart`; the server
  // accepts either, but one canonical spelling avoids surprises.
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  // Build headers WITHOUT Content-Type — let the browser set the
  // multipart boundary. Same pattern as `streamChatMultipart`.
  const h: Record<string, string> = {};
  if (authToken && authToken !== "__cookie__") {
    h.Authorization = `Bearer ${authToken}`;
  }
  if (activeWorkspaceId) {
    h["X-Workspace-Id"] = activeWorkspaceId;
  }

  const res = await fetchWithRefresh(`${API_BASE}/v1/resources`, {
    method: "POST",
    credentials: "include",
    headers: h,
    body: formData,
  });

  if (res.status === 401) {
    throw new ApiClientError("unauthorized", "Unauthorized", 401);
  }
  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw new ApiClientError(body.error, body.message, res.status, body.details);
  }
  return res.json() as Promise<UploadResourceResult>;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Synchronous chat — waits for full agent turn. */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  return request<ChatResult>("/v1/chat", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

type ChatStreamCallback = <K extends ChatStreamEventType>(
  type: K,
  data: ChatStreamEventMap[K],
) => void;

/** Parse SSE events from a streaming response body. */
async function consumeSSEStream(res: Response, onEvent: ChatStreamCallback): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          onEvent(currentEvent as ChatStreamEventType, data);
        } catch {
          // Skip malformed data lines
        }
        currentEvent = "";
      }
    }
  }
}

/** Streaming chat via SSE. Calls onEvent for each event, resolves when done. */
export async function streamChat(req: ChatRequest, onEvent: ChatStreamCallback): Promise<void> {
  const res = await fetchWithRefresh(`${API_BASE}/v1/chat/stream`, {
    method: "POST",
    credentials: "include",
    headers: headers(),
    body: JSON.stringify(req),
  });

  if (res.status === 401) {
    throw new ApiClientError("unauthorized", "Unauthorized", 401);
  }

  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw new ApiClientError(body.error, body.message, res.status, body.details);
  }

  await consumeSSEStream(res, onEvent);
}

/**
 * Streaming chat via SSE with file attachments (multipart/form-data).
 * When files are present, sends a FormData body instead of JSON.
 * SSE streaming works identically for both content types.
 */
export async function streamChatMultipart(
  req: ChatRequest,
  files: File[],
  onEvent: ChatStreamCallback,
): Promise<void> {
  const formData = new FormData();
  formData.append("message", req.message);
  if (req.conversationId) formData.append("conversationId", req.conversationId);
  if (req.model) formData.append("model", req.model);
  if (req.appContext) formData.append("appContext", JSON.stringify(req.appContext));
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  // Build headers WITHOUT Content-Type — let the browser set multipart boundary
  const h: Record<string, string> = {};
  if (authToken && authToken !== "__cookie__") {
    h.Authorization = `Bearer ${authToken}`;
  }
  if (activeWorkspaceId) {
    h["X-Workspace-Id"] = activeWorkspaceId;
  }

  const res = await fetchWithRefresh(`${API_BASE}/v1/chat/stream`, {
    method: "POST",
    credentials: "include",
    headers: h,
    body: formData,
  });

  if (res.status === 401) {
    throw new ApiClientError("unauthorized", "Unauthorized", 401);
  }

  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw new ApiClientError(body.error, body.message, res.status, body.details);
  }

  await consumeSSEStream(res, onEvent);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Platform health check (unauthenticated). */
export async function getHealth(): Promise<HealthInfo> {
  const res = await fetch(`${API_BASE}/v1/health`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiClientError("health_error", res.statusText, res.status);
  }
  return res.json() as Promise<HealthInfo>;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/** Shell manifest returned by GET /v1/shell. */
export interface ShellData {
  placements: PlacementEntry[];
  chatEndpoint: string;
  eventsEndpoint: string;
}

/** Fetch the shell manifest (placement slots, endpoints). */
export async function getShell(): Promise<ShellData> {
  return request<ShellData>("/v1/shell");
}

/**
 * Fetch the bootstrap payload (user, workspaces, shell, config) in one call.
 * `workspaceId` is the client's remembered last-active workspace — sent as
 * a soft hint to the server (unified under X-Workspace-Id). Bootstrap
 * honors it if still valid, silently falls back to the first membership
 * otherwise. Data endpoints treat the same header as authoritative.
 */
export async function getBootstrap(workspaceId?: string): Promise<BootstrapResponse> {
  const extra: Record<string, string> = {};
  if (workspaceId) extra["X-Workspace-Id"] = workspaceId;
  return request<BootstrapResponse>("/v1/bootstrap", { headers: extra });
}

/** Attempt to refresh the session using the refresh token cookie. Exposed for SSE modules. */
export const refreshSession = refreshInterceptor.tryRefresh;

// ---------------------------------------------------------------------------
// Auth (session persistence)
// ---------------------------------------------------------------------------

/**
 * Initiate an interactive OAuth flow for a remote URL bundle that's in
 * `pending_auth`. Sets a session-bound `nb_oauth_state` cookie scoped
 * to `/v1/mcp-auth/callback` and returns the authorization URL the
 * caller must navigate the user's browser to (typically via
 * `window.location.assign(authorizationUrl)`).
 *
 * Pairs with the workspace's pending-auth banner — clicking "Connect"
 * calls this, then redirects.
 */
export async function initiateMcpOAuth(
  serverName: string,
  principalId?: string,
): Promise<{ authorizationUrl: string }> {
  return request<{ authorizationUrl: string }>("/v1/mcp-auth/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(principalId ? { serverName, principalId } : { serverName }),
  });
}

/**
 * Connectors catalog entry — one card on Settings → Connectors.
 * Mirrors the server-side `ConnectorCatalogEntry` shape.
 */
export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  url: string;
  auth: "dcr" | "static";
  defaultScope: "workspace" | "user";
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; credentialKey: string };
  tags?: string[];
}

/**
 * Per-(scope, principal) installed view. Both workspace-shared and the
 * caller's personal connectors are returned, distinguished by `scope`.
 */
export interface InstalledConnector {
  catalogId: string | null;
  serverName: string;
  url: string;
  scope: "workspace" | "user";
  catalog?: ConnectorCatalogEntry;
  state: string;
  authorizationUrl?: string;
  identity?: { sub?: string; email?: string; name?: string };
  missingOperatorSetup?: boolean;
}

/**
 * Connector management — all-in-one tool surface. The web shell calls
 * `nb__manage_connectors` (alias `manage_connectors` on the `nb`
 * source) for catalog browse, installed list, install, and disconnect.
 * No dedicated REST routes — the platform's tool-call surface is the
 * canonical first-party API.
 *
 * The OAuth flow itself stays on routes (`/v1/mcp-auth/initiate` +
 * `/callback`) because it sets a session-bound state cookie and the
 * callback is a browser redirect target — neither composes cleanly
 * over `/v1/tools/call`.
 */

function unwrapStructured<T>(result: ToolCallResult, what: string): T {
  if (result.isError) {
    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    throw new Error(text || `${what} failed.`);
  }
  return result.structuredContent as T;
}

export async function getConnectorsCatalog(): Promise<{ catalog: ConnectorCatalogEntry[] }> {
  const result = await callTool("nb", "manage_connectors", { action: "list_catalog" });
  return unwrapStructured(result, "list_catalog");
}

export async function getInstalledConnectors(opts?: {
  scope?: "all" | "workspace" | "user";
}): Promise<{ installed: InstalledConnector[] }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "list_installed",
    scope: opts?.scope ?? "all",
  });
  return unwrapStructured(result, "list_installed");
}

export async function disconnectConnector(
  serverName: string,
  scope?: "workspace" | "user",
): Promise<{
  ok: boolean;
  scope: "workspace" | "user";
  revoked: { access?: boolean; refresh?: boolean };
  deletedLocal: boolean;
  revokeError?: string;
}> {
  const result = await callTool("nb", "manage_connectors", {
    action: "disconnect",
    serverName,
    ...(scope ? { scope } : {}),
  });
  return unwrapStructured(result, "disconnect");
}

/**
 * Install a catalog entry. Routes to user-scope or workspace-scope
 * storage based on the catalog entry's `defaultScope`. Idempotent —
 * if already installed, returns `alreadyInstalled: true`. Does NOT
 * start OAuth — caller follows up with `initiateMcpOAuth(serverName)`.
 */
export async function installConnector(catalogId: string): Promise<{
  ok: boolean;
  alreadyInstalled: boolean;
  serverName: string;
  scope: "workspace" | "user";
}> {
  const result = await callTool("nb", "manage_connectors", {
    action: "install",
    catalogId,
  });
  return unwrapStructured(result, "install");
}

/** Clear the server-side session cookie. Fails silently on error. */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: headers(),
    });
  } catch {
    // Fail-open: clear local state even if server call fails
  }
}

/**
 * Try to bootstrap (unauthenticated-safe). Returns bootstrap data if
 * authenticated, null if 401 or network error. Used as the single auth check.
 *
 * Routes through {@link fetchWithRefresh} so a returning user with an expired
 * access-token cookie but a valid `nb_refresh` cookie is silently re-authed
 * on cold load instead of being bounced to the login screen. `onAuthError`
 * is null at this point in the App lifecycle (App.tsx wires it inside
 * initFromBootstrap, after this call) so a failed refresh just leaves the
 * 401 in place and we return null — same behavior as before.
 *
 * `workspaceId` is the client's remembered last-active workspace — see
 * {@link getBootstrap} for the server-side contract.
 */
export async function tryBootstrap(workspaceId?: string): Promise<BootstrapResponse | null> {
  try {
    const extra: Record<string, string> = {};
    if (workspaceId) extra["X-Workspace-Id"] = workspaceId;
    const res = await fetchWithRefresh(`${API_BASE}/v1/bootstrap`, {
      credentials: "include",
      headers: {
        ...headers(),
        ...extra,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as BootstrapResponse;
  } catch {
    return null;
  }
}
