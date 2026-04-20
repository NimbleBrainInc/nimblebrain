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

/** Set the bearer token used for all authenticated requests. */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** Set the active workspace ID included as X-Workspace-Id header. */
export function setActiveWorkspaceId(id: string | null): void {
  activeWorkspaceId = id;
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
  fetch: globalThis.fetch.bind(globalThis),
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
 * Fetch an app's ui:// resource as HTML/text. Used by the iframe mounting
 * path (SlotRenderer, InlineAppView) to load app views into sandboxed frames.
 * For binary artifacts (PDFs, images, etc.), use {@link readResource}.
 */
export async function getResources(appName: string, path: string): Promise<string> {
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

  return res.text();
}

/** Invoke a tool directly. */
export async function callTool(
  server: string,
  tool: string,
  args?: Record<string, unknown>,
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

/** Fetch the bootstrap payload (user, workspaces, shell, config) in one call. */
export async function getBootstrap(preferredWorkspace?: string): Promise<BootstrapResponse> {
  const extra: Record<string, string> = {};
  if (preferredWorkspace) extra["X-Preferred-Workspace"] = preferredWorkspace;
  return request<BootstrapResponse>("/v1/bootstrap", { headers: extra });
}

/** Attempt to refresh the session using the refresh token cookie. Exposed for SSE modules. */
export const refreshSession = refreshInterceptor.tryRefresh;

// ---------------------------------------------------------------------------
// Auth (session persistence)
// ---------------------------------------------------------------------------

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
 */
export async function tryBootstrap(preferredWorkspace?: string): Promise<BootstrapResponse | null> {
  try {
    const extra: Record<string, string> = {};
    if (preferredWorkspace) extra["X-Preferred-Workspace"] = preferredWorkspace;
    const res = await fetch(`${API_BASE}/v1/bootstrap`, {
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
