import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps";
import type { ToolInput } from "../_generated/platform-schemas/catalog";
import { addAuthBreadcrumb, captureLogout, setSentryWorkspace } from "../sentry";
import type {
  ApiError,
  BootstrapResponse,
  ChatRequest,
  ChatResult,
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
 * Hooks fired on logout / auth-token change — used by stateful clients
 * that hold a session bound to the identity. Callers register via
 * `addAuthLifecycleHandler` and unsubscribe via the returned function;
 * `setAuthToken` iterates the set so multiple stateful clients (the MCP
 * bridge, the SSE event clients) each drop their identity-bound state
 * on logout independently. Stateless callers (REST helpers,
 * `fetchWithRefresh`) read the current token per-request and need no
 * hook.
 *
 * Stage 2 / Q3 (locked 2026-05-22): the `/mcp` session is identity-bound,
 * not workspace-bound. Workspace switches do NOT drop these hooks —
 * `setActiveWorkspaceId` therefore does not fire them. Cross-call
 * workspace context is supplied per-request via the `X-Workspace-Id`
 * header read fresh by callers (the MCP bridge, REST helpers).
 */
const authLifecycleHandlers = new Set<() => void>();

/**
 * Register a hook to fire whenever the auth token changes (login,
 * logout, refresh-to-different-token). Returns an unsubscribe function.
 *
 * Idempotent: registering the same callback twice has no effect (Set
 * semantics). Errors in a handler are caught so a buggy registration
 * can't break others or block the token update.
 */
export function addAuthLifecycleHandler(handler: () => void): () => void {
  authLifecycleHandlers.add(handler);
  return () => {
    authLifecycleHandlers.delete(handler);
  };
}

/**
 * @deprecated Use `addAuthLifecycleHandler`. Single-slot semantics
 * (clear-all-and-set) are preserved for external callers that haven't
 * migrated, but the multi-listener API is the supported path.
 */
export function setAuthLifecycleHandler(handler: (() => void) | null): void {
  authLifecycleHandlers.clear();
  if (handler) authLifecycleHandlers.add(handler);
}

function fireAuthLifecycle(): void {
  for (const handler of authLifecycleHandlers) {
    try {
      handler();
    } catch (err) {
      console.warn("[client] auth lifecycle handler threw:", err);
    }
  }
}

/** Set the bearer token used for all authenticated requests. */
export function setAuthToken(token: string | null): void {
  if (authToken === token) return;
  authToken = token;
  fireAuthLifecycle();
}

/**
 * Set the active workspace ID included as `X-Workspace-Id` header on REST
 * + bridge fetches. Does NOT fire the auth lifecycle hook — per Q3 the
 * `/mcp` bridge session survives workspace switches.
 */
export function setActiveWorkspaceId(id: string | null): void {
  if (activeWorkspaceId === id) return;
  activeWorkspaceId = id;
  // Single chokepoint for the focused workspace — keep the Sentry tag in sync
  // so crash reports are attributable to the right workspace (no-op if Sentry
  // is disabled).
  setSentryWorkspace(id);
}

/** Get the active workspace ID (for modules that build their own headers). */
export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

/**
 * Build the browser URL for the workspace-scoped file-serve endpoint. Files are
 * workspace-owned, so the endpoint requires `?ws=<workspaceId>` — a browser
 * `<img src>` or download anchor can't send the `X-Workspace-Id` header, so
 * the workspace rides in the URL (a request without it returns 400
 * `workspace_required`). Defaults to the active workspace; pass `workspaceId`
 * to target a specific workspace.
 */
export function fileUrl(
  fileId: string,
  workspaceId?: string | null,
  conversationId?: string | null,
): string {
  const ws = workspaceId ?? activeWorkspaceId;
  const params = new URLSearchParams();
  if (ws) params.set("ws", ws);
  // The conversation id lets the server resolve the file's authoritative
  // workspace even when the focused workspace differs (a cross-workspace
  // resume); `ws` is the fallback when there's no conversation.
  if (conversationId) params.set("conversationId", conversationId);
  const query = params.toString();
  return `${API_BASE}/v1/files/${encodeURIComponent(fileId)}${query ? `?${query}` : ""}`;
}

/** Register a callback invoked on 401 responses. */
export function setOnAuthError(callback: (() => void) | null): void {
  onAuthError = callback;
}

/**
 * Hook fired when any data call fails with `workspace_error` — the active
 * `X-Workspace-Id` names a workspace the server rejects (deleted, lost
 * membership, or malformed). The shell registers a handler that drops the
 * stale selection and bounces to `/`, where bootstrap re-resolves a valid
 * workspace. Symmetric to `onAuthError` for 401s: a bad workspace context is
 * recoverable by re-resolving, not by showing the raw error.
 */
let onWorkspaceError: (() => void) | null = null;
export function setOnWorkspaceError(callback: (() => void) | null): void {
  onWorkspaceError = callback;
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
  // Telemetry: breadcrumb every refresh outcome. captureLogout then emits a
  // single Sentry event only for the *reportable* logout (`retry_401`);
  // `refresh_rejected` is the expected end-of-session signal and stays
  // breadcrumb-only (see isReportableLogout in sentry.ts).
  onRefreshOutcome: (outcome) => addAuthBreadcrumb(`refresh:${outcome}`),
  onLogout: captureLogout,
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
    throw errorFromResponse(body, res.status);
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

/**
 * Build the `ApiClientError` for a non-ok response, firing the
 * workspace-error hook as a side effect when the failure is a stale/invalid
 * workspace. Centralized so every REST helper inherits the redirect-home
 * behavior rather than re-checking the code at each call site. The error is
 * still thrown so callers' local error handling runs unchanged; the hook is
 * additive recovery, not a replacement.
 *
 * Exported so the hook-firing seam is unit-testable directly. Driving it
 * through `callTool` → `request` → fetch is unreliable in the full suite
 * (the `mock.module("../api/client", ...)` stubs in other test files clobber
 * `callTool` depending on evaluation order), so tests assert on this pure
 * function instead.
 */
export function errorFromResponse(body: ApiError, status: number): ApiClientError {
  if (body.error === "workspace_error") onWorkspaceError?.();
  return new ApiClientError(body.error, body.message, status, body.details);
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
    throw errorFromResponse(body, res.status);
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
  // Use `files` (plural) — the server's multipart route accepts either
  // `files` or `file`, but one canonical spelling avoids surprises.
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  // Build headers WITHOUT Content-Type — let the browser set the
  // multipart boundary. Standard pattern for FormData uploads.
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
    throw errorFromResponse(body, res.status);
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

/**
 * Start a server-authoritative turn. Returns the conversation id immediately;
 * the turn runs to completion on the server regardless of this client. Watch
 * it via `connectConversationStream`.
 */
export async function startChatTurn(req: ChatRequest): Promise<{ conversationId: string }> {
  const res = await fetchWithRefresh(`${API_BASE}/v1/chat/start`, {
    method: "POST",
    credentials: "include",
    headers: headers(),
    body: JSON.stringify(req),
  });
  if (res.status === 401) throw new ApiClientError("unauthorized", "Unauthorized", 401);
  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw errorFromResponse(body, res.status);
  }
  return res.json() as Promise<{ conversationId: string }>;
}

/** Start a server-authoritative turn with file attachments (multipart). */
export async function startChatTurnMultipart(
  req: ChatRequest,
  files: File[],
): Promise<{ conversationId: string }> {
  const formData = new FormData();
  formData.append("message", req.message);
  if (req.conversationId) formData.append("conversationId", req.conversationId);
  if (req.model) formData.append("model", req.model);
  if (req.appContext) formData.append("appContext", JSON.stringify(req.appContext));
  for (const file of files) formData.append("files", file, file.name);

  const h: Record<string, string> = {};
  if (authToken && authToken !== "__cookie__") h.Authorization = `Bearer ${authToken}`;
  if (activeWorkspaceId) h["X-Workspace-Id"] = activeWorkspaceId;

  const res = await fetchWithRefresh(`${API_BASE}/v1/chat/start`, {
    method: "POST",
    credentials: "include",
    headers: h,
    body: formData,
  });
  if (res.status === 401) throw new ApiClientError("unauthorized", "Unauthorized", 401);
  if (!res.ok) {
    const body: ApiError = await res.json().catch(() => ({
      error: "unknown",
      message: res.statusText,
    }));
    throw errorFromResponse(body, res.status);
  }
  return res.json() as Promise<{ conversationId: string }>;
}

/** Explicitly stop an in-flight turn (the Stop button). */
export async function cancelChatTurn(conversationId: string): Promise<void> {
  await fetchWithRefresh(
    `${API_BASE}/v1/conversations/${encodeURIComponent(conversationId)}/cancel`,
    { method: "POST", credentials: "include", headers: headers() },
  ).catch(() => {
    // Best-effort — the turn may have already finished.
  });
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
 * Begin an OAuth flow for a Composio-backed connector. Parallel to
 * {@link initiateMcpOAuth} but keyed on the catalog connector id
 * (e.g. `com.google/gmail`) rather than the slugified server name,
 * because Composio's auth is per-toolkit and the catalog entry's
 * `_meta.composio` block is the authoritative source for the
 * `auth_config_id` env var and toolkit slug.
 *
 * Returns the URL the browser should navigate to (Composio's hosted
 * Connect Link, which 302s to the vendor's OAuth consent screen).
 */
export async function initiateComposioOAuth(
  connectorId: string,
): Promise<{ authorizationUrl: string; alreadyConnected?: boolean }> {
  return request<{ authorizationUrl: string; alreadyConnected?: boolean }>(
    "/v1/composio-auth/initiate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectorId }),
    },
  );
}

/**
 * Connectors catalog entry — one card on Settings → Connectors.
 * Mirrors the server-side `ConnectorCatalogEntry` shape.
 */
/**
 * One field collected from the user when connecting a non-redirect
 * (API-key) Composio connector. `key` is the Composio connection-field
 * name, sent verbatim; the value is handed to Composio at connect time
 * and never persisted by the platform. `sensitive` → render password.
 */
export interface ComposioField {
  key: string;
  title: string;
  description?: string;
  sensitive?: boolean;
  required?: boolean;
  placeholder?: string;
}

/** Composio connector config carried on catalog + directory entries. */
export interface ComposioConfig {
  toolkit: string;
  authConfigEnv: string;
  tools?: string[];
  /** Defaults to OAUTH2 (the redirect flow). API_KEY connectors collect `fields`. */
  authScheme?: "OAUTH2" | "API_KEY";
  fields?: ComposioField[];
}

export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Optional brand icon URL — omitted when the entry ships no icon; the UI falls back to a letter-avatar. */
  iconUrl?: string;
  url: string;
  auth: "dcr" | "static" | "composio" | "provider";
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
  /** Composio-backed connectors: toolkit slug + auth-config env var + optional tool allowlist. */
  composio?: ComposioConfig;
  tags?: string[];
  /** When true, the connector exposes a UI surface — render the "Interactive" badge. */
  interactive?: boolean;
  /** Optional connector-specific docs URL surfaced on the Configure page. */
  docsUrl?: string;
}

/**
 * Bundle `user_config` field descriptor as declared in the bundle's
 * manifest. Mirrors the server's `UserConfigFieldDef` — kept in sync by
 * convention because the server forwards manifest declarations
 * unchanged. Only `string` types appear in production today; the modal
 * renders any unknown type as disabled with a console warning.
 */
export interface BundleUserConfigField {
  type: string;
  title?: string;
  description?: string;
  sensitive?: boolean;
  required?: boolean;
  default?: unknown;
}

/**
 * Per-workspace installed view. Returns every bundle visible in the
 * workspace — local stdio servers, local URL bundles, Synapse apps, and
 * remote OAuth connectors. `type` distinguishes remote URL connectors
 * from local in-process / subprocess bundles. Personal connectors live
 * in the caller's personal workspace.
 *
 * Stage 2: `scope` is always `"workspace"`. The legacy `"user"` arm was
 * removed in T008/T009.
 */
export interface InstalledConnector {
  serverName: string;
  bundleName: string;
  /** Declared version — the catalog/manifest's stated version. */
  version: string;
  /**
   * The version the running server reports in its MCP `initialize` handshake
   * (serverInfo.version). What's *actually* connected, vs `version` (declared).
   * Absent when the source is stopped or the server reports none. Untrusted,
   * display-only.
   */
  handshakeVersion?: string;
  type: "remote" | "local";
  state: string;
  scope: "workspace";
  /** Whether this connector exposes a UI surface (auto-mounts a sidebar entry). */
  interactive: boolean;
  toolCount: number;
  trustScore: number | null;
  /**
   * Brand icon URL — one field for both remote (catalog.iconUrl) and
   * stdio (mpak `ServerDetail.icons[0].src` matched by package name).
   * Falls through to the deterministic letter avatar when unset
   * (bundle isn't in any active mpak registry, or the mpak fetch
   * failed). Replaces the old per-component fan-out across
   * `catalog?.iconUrl` (which only ever populated for remote bundles).
   */
  iconUrl?: string;
  // ── Optional fields, only populated for URL bundles / catalog-matched ──
  url?: string;
  catalogId?: string | null;
  catalog?: ConnectorCatalogEntry;
  authorizationUrl?: string;
  identity?: { sub?: string; email?: string; name?: string };
  missingOperatorSetup?: boolean;
  /** Last connection error for crashed / dead / reauth_required states. */
  lastError?: string;
  /**
   * Operator OAuth client config — present only for static-auth
   * connectors the workspace has configured. The Configure page reads
   * this to render the audit line + Edit affordance. Secret never
   * appears here.
   */
  operatorOAuth?: {
    clientId: string;
    configuredAt: string;
    configuredBy: string;
    /** Best-effort display name/email for configuredBy. */
    configuredByLabel?: string;
  };
  /**
   * Stdio bundle credential schema + per-field populated probe. The
   * Configure page's bundle-config section renders the schema and
   * uses `populated` to display configured / not-configured per row.
   * Values are never echoed.
   */
  userConfig?: {
    schema: Record<string, BundleUserConfigField>;
    populated: Record<string, boolean>;
  };
  /**
   * Generic, type-agnostic UI status. Derived server-side from the
   * underlying BundleState + credential probes so list-page pills,
   * detail-page hero, and any future surface read one value.
   *
   *   ready          — works
   *   needs_setup    — admin must configure (operator OAuth or user_config)
   *   needs_auth     — workspace member must (re)authenticate
   *   connecting     — OAuth flow in flight
   *   failed         — crashed / dead, no actionable next step
   *   starting       — subprocess booting
   */
  status: "ready" | "needs_setup" | "needs_auth" | "connecting" | "failed" | "starting";
  /** Human-readable detail for `status` (tooltip / banner copy). */
  statusReason?: string;
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

export async function getInstalledConnectors(opts?: {
  scope?: "all" | "workspace";
}): Promise<{ installed: InstalledConnector[] }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "list_installed",
    scope: opts?.scope ?? "all",
  });
  return unwrapStructured(result, "list_installed");
}

/**
 * Single-connector counterpart to {@link getInstalledConnectors}.
 * Returns one entry by serverName, or null if not installed in the
 * caller's scope. Saves the wire weight + server work of building
 * entries for every other connector when you only need one.
 */
export async function getInstalledConnector(
  serverName: string,
): Promise<{ installed: InstalledConnector | null }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "get_installed",
    serverName,
  });
  return unwrapStructured(result, "get_installed");
}

export async function disconnectConnector(
  serverName: string,
  scope?: "workspace",
): Promise<{
  ok: boolean;
  scope: "workspace";
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
 * Full uninstall — works for any bundle type. For OAuth connectors,
 * revokes tokens upstream first; for local bundles, just removes from
 * workspace.json. Drops tool permissions associated with the connector.
 */
export async function uninstallConnector(
  serverName: string,
  scope: "workspace",
): Promise<{ ok: boolean; scope: "workspace"; serverName: string }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "uninstall",
    serverName,
    scope,
  });
  return unwrapStructured(result, "uninstall");
}

/**
 * One installed registry app, aggregated org-wide (deduped by bundle name).
 * App version is org-global because the mpak cache is shared platform-wide —
 * see `src/tools/app-tools.ts`.
 */
export interface OrgApp {
  bundleName: string;
  version: string;
  trustScore: number | null;
  workspaceCount: number;
  workspaceIds: string[];
}

/** One available app update. */
export interface AppUpdate {
  bundleName: string;
  current: string;
  latest: string;
}

/** List installed registry apps across the org (org_admin). */
export async function listApps(): Promise<{ apps: OrgApp[] }> {
  const result = await callTool("nb", "manage_apps", { action: "list" });
  return unwrapStructured(result, "list");
}

/** Check the registry for newer app versions across the org (org_admin). */
export async function checkAppUpdates(): Promise<{ updates: AppUpdate[] }> {
  const result = await callTool("nb", "manage_apps", { action: "check_updates" });
  return unwrapStructured(result, "check_updates");
}

/**
 * Upgrade an app to its latest version across every workspace that has it
 * (org_admin). `upgraded` is false when already at latest; `workspaces` reports
 * per-workspace success.
 */
export async function upgradeApp(bundleName: string): Promise<{
  ok: boolean;
  upgraded: boolean;
  bundleName: string;
  from: string;
  to: string;
  workspaces: Array<{ wsId: string; ok: boolean; error?: string }>;
}> {
  const result = await callTool("nb", "manage_apps", { action: "upgrade", bundleName });
  return unwrapStructured(result, "upgrade");
}

/**
 * Install a connector. Pass the full `DirectoryEntry` the user clicked.
 * The connector installs into the workspace the shell is currently in —
 * the `X-Workspace-Id` header `callTool` already sends (set from the
 * `/w/<slug>` route). That's the same workspace every follow-up call
 * (`initiateMcpOAuth`, list_tools, status) reads, so install and connect
 * can't drift apart. Pass an explicit `wsId` only to install into a
 * different workspace than the one in view (not used by the shell today).
 * Idempotent; already-installed connectors return `alreadyInstalled: true`.
 * Does NOT start OAuth — caller follows up with `initiateMcpOAuth(serverName)`
 * for remote-OAuth installs.
 */
export async function installConnector(
  entry: DirectoryEntry,
  wsId?: string,
): Promise<{
  ok: boolean;
  alreadyInstalled: boolean;
  serverName: string;
  scope: "workspace";
  wsId: string;
}> {
  const result = await callTool("nb", "manage_connectors", {
    action: "install",
    entry,
    // Omit `wsId` so the server defaults to the request's workspace
    // (X-Workspace-Id). Only send it when the caller explicitly targets
    // a different workspace.
    ...(wsId ? { wsId } : {}),
  });
  return unwrapStructured(result, "install");
}

export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One row in the Browse directory — uniform shape across registry
 * sources (static, mpak, future). The `install` discriminator drives
 * the install-button behavior in the UI.
 */
export interface DirectoryEntry {
  id: string;
  registryId: string;
  registryType: "static" | "mpak" | "mcp" | "custom-url";
  name: string;
  description: string;
  iconUrl?: string;
  tags?: string[];
  /**
   * Static-auth entries: true when the workspace has both clientId and
   * client_secret configured. Undefined for entries where operator
   * setup doesn't apply (DCR remote-oauth, mpak, direct-url).
   */
  operatorConfigured?: boolean;
  install:
    | {
        kind: "remote-oauth";
        url: string;
        auth: "dcr" | "static" | "composio" | "provider";
        requiredScopes?: string[];
        additionalAuthorizationParams?: Record<string, string>;
        operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
        composio?: ComposioConfig;
      }
    | { kind: "mpak-bundle"; package: string }
    | { kind: "direct-url"; url: string };
}

export interface DirectoryResult {
  entries: DirectoryEntry[];
  errors: Array<{ registryId: string; message: string }>;
}

export async function listDirectory(): Promise<DirectoryResult> {
  const result = await callTool("nb", "manage_connectors", { action: "list_directory" });
  return unwrapStructured(result, "list_directory");
}

/**
 * Configure the workspace's OAuth app for a static-auth catalog
 * connector. Upsert — calling this on an already-configured connector
 * rotates both pieces. ws_admin gated.
 */
export async function setupConnectorOperator(
  catalogId: string,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; catalogId: string; clientId: string }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "setup_operator",
    catalogId,
    clientId,
    clientSecret,
  });
  return unwrapStructured(result, "setup_operator");
}

/**
 * Connect a non-redirect (API-key) Composio connector. Collects the
 * connector's declared `fields` (e.g. generic_api_key, subdomain) and
 * hands them to Composio at connect time; the platform persists only the
 * opaque connectedAccountId. A first connect is member-level; re-connect
 * (rotation, when a connection already exists) is ws_admin gated server-side.
 */
export async function connectComposioApiKey(
  catalogId: string,
  fields: Record<string, string>,
): Promise<{ connected: boolean; serverName: string; status: string }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "connect_api_key",
    catalogId,
    fields,
  });
  return unwrapStructured(result, "connect_api_key");
}

/**
 * Result envelope for set/clear bundle user_config calls. The
 * credential write itself is reported via `ok` + `populated`; the
 * implicit subprocess respawn that picks up the new env is reported
 * separately under `respawn` so the UI can surface a partial-success
 * state (creds saved, but bundle didn't come back up).
 */
export interface BundleUserConfigResult {
  ok: boolean;
  serverName: string;
  populated: Record<string, boolean>;
  respawn: { ok: boolean; error?: string };
}

/**
 * Set or clear individual `user_config` fields on a stdio bundle. Empty
 * string clears one field; absent fields are unchanged. Returns the
 * post-write `populated` map so the caller can refresh UI state without
 * a follow-up list_installed round-trip.
 *
 * Saving credentials triggers an automatic subprocess respawn so the
 * new env takes effect immediately — Mode 1 (env_inject) bundles
 * otherwise need a platform restart to pick up new values.
 */
export async function setBundleUserConfig(
  serverName: string,
  fields: Record<string, string>,
): Promise<BundleUserConfigResult> {
  const result = await callTool("nb", "manage_connectors", {
    action: "set_user_config",
    serverName,
    fields,
  });
  return unwrapStructured(result, "set_user_config");
}

/**
 * Drop the entire workspace credential file for a stdio bundle. Every
 * declared field reverts to not-configured. Triggers an automatic
 * Important caveat — the running subprocess is **not** restarted.
 * Clearing on a bundle with required fields would orphan the
 * connector (respawn would fail at prepareServer and the workspace
 * registry would lose the source, taking the connector off the UI),
 * so the server intentionally only zeroes the disk file. The bundle
 * keeps serving requests with whatever env it was launched with
 * until the next platform restart. Surface this to operators as
 * "credential rotated, takes effect next deploy" — it's not the same
 * as immediate revocation. (Active follow-up to give admins an
 * explicit Stop affordance for hard-revocation cases.)
 */
export async function clearBundleUserConfig(serverName: string): Promise<BundleUserConfigResult> {
  const result = await callTool("nb", "manage_connectors", {
    action: "clear_user_config",
    serverName,
  });
  return unwrapStructured(result, "clear_user_config");
}

/**
 * The exact redirect URI the platform sends to vendor OAuth servers.
 * OperatorSetupModal shows this to admins so they can register the
 * same value in the vendor's OAuth app config; a mismatch yields a
 * vendor-side `redirect_uri does not match` error after the user is
 * already redirected away.
 */
export async function getOAuthRedirectUri(): Promise<{ redirectUri: string }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "get_redirect_uri",
  });
  return unwrapStructured(result, "get_redirect_uri");
}

export interface RegistryConfig {
  id: string;
  name: string;
  type: "curated" | "mpak" | "directory" | "custom-url";
  enabled: boolean;
  url?: string;
  locked?: boolean;
}

export async function listRegistries(): Promise<{ registries: RegistryConfig[] }> {
  const result = await callTool("nb", "manage_registries", { action: "list" });
  return unwrapStructured(result, "list");
}

export async function setRegistryEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; registry: RegistryConfig }> {
  const result = await callTool("nb", "manage_registries", {
    action: enabled ? "enable" : "disable",
    id,
  });
  return unwrapStructured(result, enabled ? "enable" : "disable");
}

export type ToolPolicy = "allow" | "disallow";

/**
 * Combined fetch — returns the connector's tool list AND the policy
 * map in one round-trip. Used by ToolPermissionsTable, which needs
 * both on mount; the previous two-call shape doubled the page-load
 * REST traffic for no benefit.
 */
export async function listConnectorToolsWithPermissions(
  serverName: string,
  scope?: "workspace",
): Promise<{
  scope: "workspace";
  serverName: string;
  tools: ConnectorTool[];
  permissions: Record<string, ToolPolicy>;
}> {
  const result = await callTool("nb", "manage_connectors", {
    action: "list_tools_with_permissions",
    serverName,
    ...(scope ? { scope } : {}),
  });
  return unwrapStructured(result, "list_tools_with_permissions");
}

export async function setConnectorPermissions(
  serverName: string,
  scope: "workspace",
  tools: Record<string, ToolPolicy>,
): Promise<{ ok: boolean; scope: "workspace"; serverName: string }> {
  const result = await callTool("nb", "manage_connectors", {
    action: "set_permissions",
    serverName,
    scope,
    tools,
  });
  return unwrapStructured(result, "set_permissions");
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
 * Bootstrap carries NO `X-Workspace-Id`. Which workspace the user is in is
 * owned by the URL (`/w/:slug`), resolved AFTER bootstrap by the route
 * guard — not by a remembered selection. Sending a stale remembered id was
 * the cause of a hard lock-out: a workspace the user had lost access to made
 * the server reject bootstrap before its permissive default could run. The
 * server defaults the focus to the user's personal workspace on its own.
 */
export async function tryBootstrap(): Promise<BootstrapResponse | null> {
  try {
    // Strip any workspace scope — bootstrap is identity-level discovery.
    const h = headers();
    delete h["X-Workspace-Id"];
    const res = await fetchWithRefresh(`${API_BASE}/v1/bootstrap`, {
      credentials: "include",
      headers: h,
    });
    if (!res.ok) return null;
    return (await res.json()) as BootstrapResponse;
  } catch {
    return null;
  }
}
