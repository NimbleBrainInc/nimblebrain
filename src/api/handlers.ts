import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CallbackEventSink } from "../adapters/callback-events.ts";
import { log } from "../cli/log.ts";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { ingestFiles, type UploadedFile } from "../files/ingest.ts";
import { createFileStore } from "../files/store.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import { RunInProgressError } from "../runtime/errors.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { ChatRequest } from "../runtime/types.ts";
import type { HealthMonitor } from "../tools/health-monitor.ts";
import type { ResourceData } from "../tools/types.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import { bytesToBase64 } from "../util/base64.ts";
import type { ConversationEventManager } from "./conversation-events.ts";
import type { SseEventManager } from "./events.ts";
import { startSseHeartbeat } from "./sse-heartbeat.ts";
import { apiError } from "./types.ts";

const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
// Release builds inject the git tag via NB_VERSION (see Dockerfile). Local
// dev / non-release builds fall back to package.json, which is pinned to
// the sentinel "0.0.0-dev" and intentionally never bumped — the git tag
// is the sole source of truth for released versions (see RELEASING.md §1).
const VERSION = process.env.NB_VERSION || pkg.version;

/**
 * Interval between SSE comment heartbeats on /v1/chat/stream. Chosen to sit
 * safely below AWS ALB idle-timeout (60s default, raised to 900s in
 * `deployments/agent-platform/*`) while staying quiet enough to be
 * invisible to the user.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** Handle POST /v1/chat — synchronous chat request. */
export async function handleChat(
  request: Request,
  runtime: Runtime,
  features: ResolvedFeatures,
  identity?: UserIdentity,
  workspaceId?: string,
): Promise<Response> {
  const parsed = await parseChatBody(request, runtime, features, identity, workspaceId);
  if (parsed instanceof Response) return parsed;

  if (parsed.conversationId && runtime.isConversationActive(parsed.conversationId)) {
    return runInProgressResponse(parsed.conversationId);
  }

  try {
    const result = await runtime.chat(parsed);
    return json({
      ...result,
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    });
  } catch (err) {
    if (err instanceof RunInProgressError) {
      return runInProgressResponse(err.conversationId);
    }
    throw err;
  }
}

function runInProgressResponse(conversationId: string): Response {
  return apiError(
    409,
    "run_in_progress",
    "This conversation already has an active response. Wait for it to finish before sending another message.",
    { conversationId },
  );
}

/** Handle POST /v1/chat/stream — SSE streaming chat request. */
export async function handleChatStream(
  request: Request,
  runtime: Runtime,
  features: ResolvedFeatures,
  identity?: UserIdentity,
  workspaceId?: string,
  conversationEventManager?: ConversationEventManager,
): Promise<Response> {
  const parsed = await parseChatBody(request, runtime, features, identity, workspaceId);
  if (parsed instanceof Response) return parsed;

  if (parsed.conversationId && runtime.isConversationActive(parsed.conversationId)) {
    return runInProgressResponse(parsed.conversationId);
  }

  const convId = parsed.conversationId;

  const sink = new CallbackEventSink();
  let markClosed: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      // Keep the TCP connection alive during slow tool calls (Typst
      // compile, MCP task-augmented research) — ALB idle-timeout kills
      // silent streams. Must be created before `markClosed` captures it.
      const heartbeat = startSseHeartbeat(controller, HEARTBEAT_INTERVAL_MS);
      markClosed = () => {
        closed = true;
        heartbeat.stop();
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        heartbeat.stop();
        unsubscribe();
        controller.close();
      };

      // Defer the cross-participant user.message broadcast until the engine
      // confirms the run actually started (first chat.start). If the call
      // rejects with RunInProgressError, no broadcast fires and other
      // participants never see a phantom message with no assistant reply.
      let userMessageBroadcast = false;
      const broadcastUserMessageOnce = () => {
        if (userMessageBroadcast) return;
        userMessageBroadcast = true;
        if (convId && conversationEventManager && identity) {
          conversationEventManager.broadcastToConversation(
            convId,
            "user.message",
            {
              userId: identity.id,
              displayName: identity.displayName,
              content: parsed.message,
              timestamp: new Date().toISOString(),
            },
            identity.id,
          );
        }
      };

      const unsubscribe = sink.subscribe((event: EngineEvent) => {
        if (
          event.type === "chat.start" ||
          event.type === "text.delta" ||
          event.type === "tool.start" ||
          event.type === "tool.done" ||
          event.type === "llm.done" ||
          event.type === "data.changed"
        ) {
          if (event.type === "chat.start") {
            broadcastUserMessageOnce();
          }
          send(event.type, event.data);
          // Broadcast to other participants watching this conversation
          if (convId && conversationEventManager && identity) {
            conversationEventManager.broadcastToConversation(
              convId,
              event.type,
              event.data as Record<string, unknown>,
              identity.id,
            );
          }
        }
      });

      runtime
        .chat(parsed, sink)
        .then((result) => {
          const doneData = {
            response: result.response,
            conversationId: result.conversationId,
            ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
            skillName: result.skillName,
            toolCalls: result.toolCalls,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            stopReason: result.stopReason,
            usage: result.usage,
          };
          send("done", doneData);
          // Broadcast done to other participants
          if (conversationEventManager && identity) {
            const broadcastConvId = convId ?? result.conversationId;
            if (broadcastConvId) {
              conversationEventManager.broadcastToConversation(
                broadcastConvId,
                "done",
                doneData as Record<string, unknown>,
                identity.id,
              );
            }
          }
          finish();
        })
        .catch((err) => {
          if (err instanceof RunInProgressError) {
            send("error", {
              error: "run_in_progress",
              message: "This conversation already has an active response.",
            });
            finish();
            return;
          }
          console.error("[routes] handleChatStream failed:", err);
          const raw = err instanceof Error ? err.message : String(err);
          const friendly = friendlyError(raw);
          send("error", {
            error: friendly.code,
            message: friendly.message,
          });
          finish();
        });
    },
    cancel() {
      markClosed();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Translate raw API/engine errors into user-friendly messages.
 * Returns a machine-readable code and a human-readable message.
 */
export function friendlyError(raw: string): { code: string; message: string } {
  // Anthropic API validation errors
  if (raw.includes("text content blocks must be non-empty")) {
    return {
      code: "conversation_invalid",
      message:
        "Something went wrong with this conversation's history. Please start a new conversation.",
    };
  }
  if (raw.includes("messages: roles must alternate")) {
    return {
      code: "conversation_invalid",
      message: "This conversation got into an invalid state. Please start a new conversation.",
    };
  }
  // Rate limits
  if (raw.includes("rate_limit") || raw.includes("429")) {
    return {
      code: "rate_limited",
      message: "The AI service is temporarily rate-limited. Please wait a moment and try again.",
    };
  }
  // Auth errors
  if (raw.includes("authentication_error") || raw.includes("invalid x-api-key")) {
    return {
      code: "provider_auth_error",
      message: "The AI provider API key is invalid or expired. Check your configuration.",
    };
  }
  // Overloaded
  if (raw.includes("overloaded")) {
    return {
      code: "provider_overloaded",
      message: "The AI service is temporarily overloaded. Please try again in a moment.",
    };
  }
  return { code: "engine_error", message: raw };
}

/** Handle GET /v1/health */
export function handleHealth(healthMonitor: HealthMonitor | null): Response {
  const bundleHealth = healthMonitor?.getStatus() ?? [];
  return json({
    status: "ok",
    version: VERSION,
    buildSha: process.env.NB_BUILD_SHA || null,
    bundles: bundleHealth.map((b) => ({ name: b.name, state: b.state })),
  });
}

/** Handle GET /v1/apps/:name/resources/:path — fetch a ui:// resource. */
export async function handleResourceProxy(
  appName: string,
  resourcePath: string,
  runtime: Runtime,
  workspaceId?: string,
): Promise<Response> {
  // Workspace authorization — reject requests for servers not in the active workspace
  if (workspaceId) {
    const wsRegistry = await runtime.ensureWorkspaceRegistry(workspaceId);
    if (!wsRegistry.hasSource(appName)) {
      return apiError(
        403,
        "workspace_access_denied",
        `App "${appName}" is not available in this workspace`,
        { app: appName },
      );
    }
  }

  // Dev mode: redirect to local Vite dev server when --app flag is active
  const { isDevMode, getAppDevUrl } = await import("../runtime/dev-registry.ts");
  if (isDevMode(appName)) {
    const devUrl = getAppDevUrl(appName)!;
    const target = resourcePath === "primary" ? "/" : `/${resourcePath}`;
    return Response.redirect(`${devUrl}${target}`, 302);
  }

  // Both platform built-ins and user-installed bundles are now MCP servers
  // (in-process or subprocess); both go through the same `readAppResource`
  // path. The only branch is for "primary" → resourceUri resolution, which
  // platform sources expose via the source's mode metadata while external
  // bundles expose via their `instance.ui.placements`.
  if (!workspaceId) throw new Error("Workspace ID required");

  let resolvedPath = resourcePath;
  if (resourcePath === "primary") {
    const primaryUri = await resolvePrimaryResourceUri(runtime, appName, workspaceId);
    if (primaryUri) {
      resolvedPath = primaryUri.replace(/^ui:\/\//, "");
    }
  }

  const resource = await runtime.readAppResource(appName, resolvedPath, workspaceId);
  if (resource === null) {
    return apiError(404, "resource_not_found", `Resource "ui://${resourcePath}" not found`, {
      resource: `ui://${resourcePath}`,
    });
  }

  // Emit a JSON envelope mirroring the MCP `ReadResourceResult` shape so
  // clients see the protocol directly and can consume `_meta` (e.g. ext-apps
  // `_meta.ui.csp`) without a translation layer. Same shape as
  // `handleReadResource` (POST /v1/resources/read).
  return json({ contents: [buildResourceEnvelopeEntry(`ui://${resolvedPath}`, resource)] });
}

/**
 * Resolve "primary" — the virtual path used by the iframe shell when it
 * doesn't yet know the source's resourceUri — to the first declared
 * placement's `resourceUri`.
 *
 * Two sources of truth depending on the app's lineage:
 *
 *   - User-installed bundles publish placements via their manifest, which
 *     the bundle lifecycle exposes on `BundleInstance.ui.placements`.
 *   - Platform built-ins are in-process MCP sources whose placements live
 *     on the McpSource (`getPlacements()`); they have no lifecycle entry.
 *
 * Returns `null` when no placement with a `resourceUri` is found — the
 * caller falls back to using the literal path "primary".
 */
async function resolvePrimaryResourceUri(
  runtime: Runtime,
  appName: string,
  workspaceId: string,
): Promise<string | null> {
  const instance = runtime.getLifecycle().getInstance(appName, workspaceId);
  const fromInstance = instance?.ui?.placements?.find((p) => p.resourceUri)?.resourceUri;
  if (fromInstance) return fromInstance;

  const registry = await runtime.ensureWorkspaceRegistry(workspaceId);
  const source = registry.getSources().find((s) => s.name === appName);
  if (!source) return null;
  const fn = (source as { getPlacements?: () => unknown }).getPlacements;
  if (typeof fn !== "function") return null;
  const placements = fn.call(source);
  if (!Array.isArray(placements)) return null;
  const found = placements.find(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof (p as { resourceUri?: unknown }).resourceUri === "string",
  ) as { resourceUri?: string } | undefined;
  return found?.resourceUri ?? null;
}

/**
 * Build a single `contents[]` entry in the MCP `ReadResourceResult`
 * envelope shape. Shared between `handleResourceProxy` (GET /v1/apps/:name/
 * resources/:path) and `handleReadResource` (POST /v1/resources/read) so
 * both emit a byte-identical envelope — this is the exact drift that adding
 * `_meta` without a shared helper would create.
 *
 * Exactly one of `text` or `blob` is populated (blob wins when the resource
 * is binary); `blob` values are base64-encoded per spec. `_meta` is included
 * only when the source declared one.
 *
 * Exported for direct unit-test coverage — see
 * `test/unit/resource-envelope.test.ts`.
 */
export function buildResourceEnvelopeEntry(
  uri: string,
  resource: ResourceData,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { uri };
  if (resource.mimeType) entry.mimeType = resource.mimeType;
  if (resource.blob) {
    entry.blob = bytesToBase64(resource.blob);
  } else {
    entry.text = resource.text ?? "";
  }
  if (resource.meta) entry._meta = resource.meta;
  return entry;
}

/**
 * Handle POST /v1/resources/read — MCP resources/read proxy.
 *
 * Body: { server, uri }
 * Returns: MCP ReadResourceResult — { contents: [{ uri, mimeType?, text?, blob? }] }.
 * Binary payloads are returned as base64-encoded `blob` strings per spec.
 */
export async function handleReadResource(
  request: Request,
  runtime: Runtime,
  options?: { workspaceId?: string },
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const { server, uri } = body as { server?: string; uri?: string };
  if (!server || typeof server !== "string") {
    return apiError(400, "bad_request", "'server' is required");
  }
  if (!uri || typeof uri !== "string") {
    return apiError(400, "bad_request", "'uri' is required");
  }

  const workspaceId = options?.workspaceId;
  if (!workspaceId) {
    return apiError(400, "bad_request", "Workspace ID required");
  }

  // Workspace scoping — reject servers not in the active workspace.
  const wsRegistry = await runtime.ensureWorkspaceRegistry(workspaceId);
  if (!wsRegistry.hasSource(server)) {
    return apiError(
      403,
      "workspace_access_denied",
      `Server "${server}" is not available in this workspace`,
      { server },
    );
  }

  const resource = await runtime.readAppResource(server, uri, workspaceId);
  if (resource === null) {
    return apiError(404, "resource_not_found", `Resource "${uri}" not found`, {
      server,
      uri,
    });
  }

  return json({ contents: [buildResourceEnvelopeEntry(uri, resource)] });
}

/** Handle POST /v1/tools/call — direct tool invocation. */
export async function handleToolCall(
  request: Request,
  runtime: Runtime,
  features: ResolvedFeatures,
  options?: {
    sseManager?: SseEventManager;
    eventSink?: EventSink;
    identity?: UserIdentity;
    workspaceId?: string;
  },
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const {
    server,
    tool,
    arguments: args,
  } = body as {
    server?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  };

  if (!server || !tool) {
    return apiError(400, "bad_request", "'server' and 'tool' are required");
  }

  const { sseManager, eventSink, identity, workspaceId } = options ?? {};

  // Resolve registry: workspace-scoped when available, global otherwise
  if (!workspaceId) throw new Error("Workspace ID required");
  const registry = await runtime.ensureWorkspaceRegistry(workspaceId);

  // Check if server exists
  if (!registry.hasSource(server)) {
    return apiError(404, "tool_not_found", `Tool "${tool}" not found on server "${server}"`, {
      server,
      tool,
    });
  }

  // Check if tool exists on the server
  // The tool name may already be prefixed (e.g., "home__briefing" from the bridge)
  // or bare (e.g., "briefing"). Normalize to full name.
  const toolName = tool.startsWith(`${server}__`) ? tool : `${server}__${tool}`;

  const source = registry.getSources().find((s) => s.name === server);
  if (source) {
    try {
      const tools = await source.tools();
      const toolDef = tools.find((t) => t.name === toolName);
      if (!toolDef) {
        return apiError(404, "tool_not_found", `Tool "${tool}" not found on server "${server}"`, {
          server,
          tool,
        });
      }

      // Validate input against the tool's declared JSON Schema
      if (toolDef.inputSchema) {
        const validation = validateToolInput(args ?? {}, toolDef.inputSchema);
        if (!validation.valid) {
          return apiError(
            400,
            "invalid_input",
            `Invalid arguments for "${tool}": ${validation.error}`,
            {
              tool: toolName,
              errors: validation.errors,
            },
          );
        }
      }
    } catch {
      return json({ error: "tool_not_found", server, tool }, 404);
    }
  }

  // Feature flag gate — reject calls to disabled tools (defense-in-depth layer 2)
  if (!isToolEnabled(toolName, features)) {
    return apiError(403, "feature_disabled", `Tool "${toolName}" is disabled by feature flags`, {
      tool: toolName,
    });
  }

  // Role-based gate — reject calls to admin-only tools by non-admins
  if (!isToolVisibleToRole(toolName, identity?.orgRole)) {
    return apiError(403, "forbidden", `Insufficient permissions for tool "${toolName}"`, {
      tool: toolName,
    });
  }

  // Build per-request context for AsyncLocalStorage (concurrency-safe)
  const reqCtx: RequestContext = {
    identity: identity ?? null,
    workspaceId: workspaceId ?? null,
    workspaceAgents: null,
    workspaceModelOverride: null,
  };

  // Audit log
  log.info(`[api] tools/call server=${server} tool=${tool} identity=${identity?.id ?? "none"}`);
  const callId = `api_${crypto.randomUUID().slice(0, 8)}`;

  // Emit bridge.tool.call before execution (ephemeral SSE + durable event sink)
  const bridgeCallEvent = {
    type: "bridge.tool.call" as const,
    data: {
      name: toolName,
      id: callId,
      server,
      userId: identity?.id ?? null,
      workspaceId: workspaceId ?? null,
    },
  };
  sseManager?.emit(bridgeCallEvent);
  eventSink?.emit(bridgeCallEvent);

  const t0 = performance.now();
  let result: Awaited<ReturnType<typeof registry.execute>> | undefined;
  try {
    result = await runWithRequestContext(reqCtx, () =>
      registry.execute({
        id: callId,
        name: toolName,
        input: args ?? {},
      }),
    );
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const failEvent = {
      type: "bridge.tool.done" as const,
      data: {
        name: toolName,
        id: callId,
        ok: false,
        ms,
        userId: identity?.id ?? null,
        workspaceId: workspaceId ?? null,
      },
    };
    sseManager?.emit(failEvent);
    eventSink?.emit(failEvent);
    throw err;
  }

  const ms = Math.round(performance.now() - t0);
  // Emit bridge.tool.done after execution (ephemeral SSE + durable event sink)
  const doneEvent = {
    type: "bridge.tool.done" as const,
    data: {
      name: toolName,
      id: callId,
      ok: !result.isError,
      ms,
      userId: identity?.id ?? null,
      workspaceId: workspaceId ?? null,
    },
  };
  sseManager?.emit(doneEvent);
  eventSink?.emit(doneEvent);

  // NOTE: Do NOT emit data.changed here. This endpoint is the MCP App Bridge
  // proxy — tool calls initiated by iframes. The iframe already knows about
  // its own calls. Emitting data.changed here creates an infinite loop:
  // tool call → data.changed SSE → iframe refreshes → tool call → ...
  // Agent-initiated data.changed events are emitted by the engine event sink.

  return json({
    content: result.content,
    structuredContent: result.structuredContent,
    isError: result.isError,
  });
}

/** Handle GET /v1/bootstrap — single startup endpoint replacing multiple calls. */
export async function handleBootstrap(
  req: Request,
  runtime: Runtime,
  identity?: UserIdentity,
): Promise<Response> {
  if (!identity) {
    return apiError(401, "authentication_required", "Authentication is required");
  }

  // 1. Workspaces the user is a member of
  const allWorkspaces = await runtime.getWorkspaceStore().list();
  const userWorkspaces = allWorkspaces.filter((ws) =>
    ws.members.some((m) => m.userId === identity.id),
  );

  // Invariant (Phase 1): authenticated users have at least one workspace.
  // Provisioning runs at the identity boundary (provider.provisionUser →
  // ensureUserWorkspace). If we hit zero here, something upstream is broken
  // and we want to know loudly, not silently leak every workspace's apps.
  if (userWorkspaces.length === 0) {
    return apiError(
      500,
      "workspace_invariant_violation",
      "Authenticated user has no workspace. Provisioning should have run at login.",
    );
  }

  // 2. Resolve active workspace — permissive: honor X-Workspace-Id when it
  // matches a membership, otherwise pick the first. Bootstrap is the one
  // place the server defaults, because it's the only place a client can
  // legitimately not yet know a wsId. On data endpoints the same header is
  // authoritative (unknown wsId → 400); bootstrap is the discovery surface
  // so the contract is weaker here by design.
  const requested = req.headers.get("X-Workspace-Id");
  const activeWorkspace: string =
    requested && userWorkspaces.some((ws) => ws.id === requested)
      ? requested
      : userWorkspaces[0]!.id;

  // 3. Shell placements for the active workspace (ambient + scoped, merged).
  const placements = runtime.getPlacementRegistry().forWorkspace(activeWorkspace);

  // 4. Config
  const models = runtime.getModelSlots();
  const configuredProviders = runtime.getConfiguredProviders();
  const maxIterations = runtime.getMaxIterations();
  const maxInputTokens = runtime.getMaxInputTokens();
  const maxOutputTokens = runtime.getMaxOutputTokens();

  return json({
    user: {
      id: identity.id,
      email: identity.email,
      displayName: identity.displayName,
      orgRole: identity.orgRole,
      preferences: identity.preferences,
    },
    workspaces: userWorkspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      role: ws.members.find((m) => m.userId === identity.id)!.role,
      memberCount: ws.members.length,
      bundleCount: ws.bundles.length,
    })),
    activeWorkspace,
    shell: {
      placements,
      chatEndpoint: "/v1/chat/stream",
      eventsEndpoint: "/v1/events",
    },
    config: {
      models,
      configuredProviders,
      maxIterations,
      maxInputTokens,
      maxOutputTokens,
    },
    version: VERSION,
    buildSha: process.env.NB_BUILD_SHA || null,
  });
}

/**
 * Handle GET /v1/shell — placement registry for web client bootstrap.
 *
 * workspaceId comes from requireWorkspace middleware; by the time this
 * handler runs, it's resolved and membership-checked.
 */
export async function handleShell(runtime: Runtime, workspaceId: string): Promise<Response> {
  return json({
    placements: runtime.getPlacementRegistry().forWorkspace(workspaceId),
    chatEndpoint: "/v1/chat/stream",
    eventsEndpoint: "/v1/events",
  });
}

// --- SSE Event Stream (Task 006) ---

/** Handle GET /v1/events — workspace SSE event stream. */
export function handleEvents(sseManager: SseEventManager, workspaceId?: string): Response {
  const stream = sseManager.addClient(workspaceId);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Handle POST /v1/auth/logout — clear all session cookies. */
export function handleLogout(): Response {
  const res = json({ ok: true });
  // Clear nb_session for both SameSite modes (covers Strict and Lax)
  res.headers.append("Set-Cookie", "nb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.headers.append("Set-Cookie", "nb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  // Clear WorkOS refresh token
  res.headers.append("Set-Cookie", "nb_refresh=; HttpOnly; SameSite=Lax; Path=/v1/auth; Max-Age=0");
  return res;
}

// ── OAuth flow state (server-side, in-memory) ───────────────────

interface PendingAuth {
  codeVerifier: string;
  createdAt: number;
}

/** Server-side store for pending OAuth flows. Keyed by state parameter. */
const pendingAuthFlows = new Map<string, PendingAuth>();
const AUTH_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Remove expired entries. Called on every authorize/callback. */
function cleanupPendingFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pendingAuthFlows) {
    if (now - flow.createdAt > AUTH_FLOW_TTL_MS) {
      pendingAuthFlows.delete(state);
    }
  }
}

/** Generate a PKCE code_verifier (43-128 chars, URL-safe). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Compute code_challenge = base64url(SHA-256(code_verifier)). */
async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Handle GET /v1/auth/authorize — generate PKCE challenge + CSRF state,
 * store server-side, and redirect to the identity provider.
 *
 * Nothing is stored in cookies. The state parameter in the redirect URL
 * is the only client-visible artifact — the code_verifier stays on the server.
 */
export async function handleOidcAuthorize(provider: IdentityProvider): Promise<Response> {
  if (!provider.capabilities.authCodeFlow) {
    return apiError(400, "not_configured", "Auth code flow not configured");
  }
  const baseAuthUrl = provider.getAuthorizationUrl?.();
  if (!baseAuthUrl) {
    return apiError(400, "not_configured", "Auth code flow not configured");
  }

  cleanupPendingFlows();

  // Generate PKCE pair
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  // Generate state (CSRF token)
  const state = crypto.randomUUID();

  // Store server-side — only the callback can retrieve it via the state param
  pendingAuthFlows.set(state, { codeVerifier, createdAt: Date.now() });

  // Build authorization URL with state + PKCE
  const authUrl = new URL(baseAuthUrl);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return Response.redirect(authUrl.toString(), 302);
}

/**
 * Handle GET /v1/auth/callback — verify state against server-side store,
 * exchange code with PKCE verifier, and set session cookies.
 */
export async function handleOidcCallback(
  request: Request,
  provider: IdentityProvider,
  isLocalhost: boolean,
  appOrigin?: string,
): Promise<Response> {
  if (!provider.capabilities.authCodeFlow || !provider.exchangeCode) {
    return apiError(400, "not_configured", "Auth code flow not configured");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return apiError(400, "bad_request", "Missing authorization code");
  }

  // Verify state — must match a pending flow in server memory
  const returnedState = url.searchParams.get("state");
  if (!returnedState) {
    console.error("[nimblebrain] OAuth callback missing state parameter");
    const errorRedirect = appOrigin ?? url.origin;
    return Response.redirect(`${errorRedirect}?error=auth_failed`, 302);
  }

  cleanupPendingFlows();

  const pendingFlow = pendingAuthFlows.get(returnedState);
  if (!pendingFlow) {
    console.error("[nimblebrain] OAuth state mismatch — possible CSRF attack or expired flow");
    const errorRedirect = appOrigin ?? url.origin;
    return Response.redirect(`${errorRedirect}?error=auth_failed`, 302);
  }

  // Consume the state — one-time use
  pendingAuthFlows.delete(returnedState);

  try {
    // Exchange code with the PKCE verifier — provider forwards it to the authorization server
    const result = await provider.exchangeCode(code, pendingFlow.codeVerifier);

    const redirectUrl = appOrigin ?? url.origin;
    const secure = !isLocalhost;

    const sessionParts = [
      `nb_session=${result.accessToken}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=3600",
    ];
    if (secure) sessionParts.push("Secure");

    const mutableRes = new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
        "Set-Cookie": sessionParts.join("; "),
      },
    });

    if (result.refreshToken) {
      const refreshParts = [
        `nb_refresh=${result.refreshToken}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/v1/auth",
        "Max-Age=2592000",
      ];
      if (secure) refreshParts.push("Secure");
      mutableRes.headers.append("Set-Cookie", refreshParts.join("; "));
    }

    return mutableRes;
  } catch (err) {
    console.error("[nimblebrain] Auth callback failed:", err);
    const errorRedirect = appOrigin ?? url.origin;
    return Response.redirect(`${errorRedirect}?error=auth_failed`, 302);
  }
}

/** Handle POST /v1/auth/refresh — refresh access token using refresh cookie. */
export async function handleOidcRefresh(
  request: Request,
  provider: IdentityProvider,
  isLocalhost: boolean,
): Promise<Response> {
  if (!provider.capabilities.tokenRefresh || !provider.refreshToken) {
    return apiError(400, "not_configured", "OIDC auth not configured");
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  let refreshToken: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("nb_refresh=")) {
      refreshToken = trimmed.slice("nb_refresh=".length);
      break;
    }
  }

  if (!refreshToken) {
    return apiError(401, "no_refresh_token", "No refresh token");
  }

  try {
    const result = await provider.refreshToken(refreshToken);

    const secure = !isLocalhost;
    const sessionParts = [
      `nb_session=${result.accessToken}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=3600",
    ];
    if (secure) sessionParts.push("Secure");

    const res = json({ ok: true });
    res.headers.set("Set-Cookie", sessionParts.join("; "));

    if (result.refreshToken) {
      const refreshParts = [
        `nb_refresh=${result.refreshToken}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/v1/auth",
        "Max-Age=2592000",
      ];
      if (secure) refreshParts.push("Secure");
      res.headers.append("Set-Cookie", refreshParts.join("; "));
    }

    return res;
  } catch (err) {
    console.error("[nimblebrain] Token refresh failed:", err);
    return apiError(401, "refresh_failed", "Token refresh failed");
  }
}

// --- File Serve ---

/** Strip characters that could break or inject Content-Disposition headers. */
export function sanitizeFilename(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security sanitization
  return name.replace(/["\r\n\x00-\x1f]/g, "_");
}

/**
 * Regex for valid file IDs.
 *  - New scheme: `fl_<24 hex chars>` (randomBytes(12).hex).
 *  - Legacy scheme: `fl_<base36 timestamp>_<8 hex>` from the pre-unification
 *    chat ingest path; kept accepted so historical file links keep working
 *    while aliases.ts (migration) remaps them.
 */
const FILE_ID_RE = /^fl_(?:[a-f0-9]{24}|[a-z0-9]+_[a-f0-9]{8})$/;

/** Handle GET /v1/files/:fileId — serve a stored file. */
export async function handleFileServe(
  fileId: string,
  runtime: Runtime,
  features: ResolvedFeatures,
  workspaceId: string,
): Promise<Response> {
  if (!features.fileContext) {
    return apiError(404, "not_found", "Not found");
  }

  if (!FILE_ID_RE.test(fileId)) {
    return apiError(400, "bad_request", "Invalid file ID format");
  }

  const store = createFileStore(join(runtime.getWorkspaceScopedDir(workspaceId), "files"));
  try {
    const file = await store.readFile(fileId);
    const safeName = sanitizeFilename(file.filename);
    return new Response(new Uint8Array(file.data), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `inline; filename="${safeName}"`,
      },
    });
  } catch {
    return apiError(404, "not_found", "File not found");
  }
}

// --- Chat Body Parsing ---

/**
 * Parse a chat request body from either JSON or multipart/form-data.
 * Returns a fully constructed ChatRequest or an error Response.
 */
async function parseChatBody(
  request: Request,
  runtime: Runtime,
  features: ResolvedFeatures,
  identity?: UserIdentity,
  workspaceId?: string,
): Promise<ChatRequest | Response> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    if (!features.fileContext) {
      return apiError(415, "unsupported_media_type", "File uploads are not enabled");
    }
    return parseMultipartChatBody(request, runtime, identity, workspaceId);
  }

  // Default: JSON body
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const {
    message,
    conversationId,
    model,
    appContext,
    metadata,
    allowedTools,
    workspaceId: bodyWorkspaceId,
  } = body;
  if (typeof message !== "string" || !message) {
    return apiError(400, "bad_request", "message is required and must be a string");
  }

  // Validate metadata is a plain object if provided
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
  ) {
    return apiError(400, "bad_request", "metadata must be a JSON object");
  }

  // Validate allowedTools is a string array if provided
  if (allowedTools !== undefined) {
    if (
      !Array.isArray(allowedTools) ||
      !allowedTools.every((t: unknown) => typeof t === "string")
    ) {
      return apiError(400, "bad_request", "allowedTools must be an array of strings");
    }
  }

  // Middleware-resolved workspace takes precedence over body field
  const resolvedWorkspaceId =
    workspaceId ?? (typeof bodyWorkspaceId === "string" ? bodyWorkspaceId : undefined);

  return {
    message,
    conversationId: conversationId as string | undefined,
    model: model as string | undefined,
    ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
    appContext: appContext as { appName: string; serverName: string } | undefined,
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
    ...(allowedTools !== undefined ? { allowedTools: allowedTools as string[] } : {}),
    ...(identity ? { identity } : {}),
  };
}

/**
 * Parse a multipart/form-data chat request with file uploads.
 * Extracts message, optional fields, and uploaded files.
 */
async function parseMultipartChatBody(
  request: Request,
  runtime: Runtime,
  identity?: UserIdentity,
  workspaceId?: string,
): Promise<ChatRequest | Response> {
  let formData: Awaited<ReturnType<typeof request.formData>>;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "bad_request", "Invalid multipart form data");
  }

  const messageRaw = formData.get("message");
  // Allow empty/missing message when files are attached (validated after file collection)
  const message = typeof messageRaw === "string" ? messageRaw : "";

  const conversationId = formData.get("conversationId");
  const model = formData.get("model");

  let appContext: { appName: string; serverName: string } | undefined;
  const appContextRaw = formData.get("appContext");
  if (typeof appContextRaw === "string" && appContextRaw) {
    try {
      appContext = JSON.parse(appContextRaw);
    } catch {
      return apiError(400, "bad_request", "appContext must be a valid JSON string");
    }
  }

  // Collect uploaded files — FormDataEntryValue is string | File in Bun.
  // TypeScript without DOM lib doesn't know File, so we check via duck typing.
  const uploadedFiles: UploadedFile[] = [];
  for (const [_key, value] of formData.entries()) {
    if (typeof value === "string") continue;
    const entry = value as unknown as {
      arrayBuffer(): Promise<ArrayBuffer>;
      name?: string;
      type?: string;
    };
    if (typeof entry.arrayBuffer !== "function") continue;
    const buffer = Buffer.from(await entry.arrayBuffer());
    uploadedFiles.push({
      data: buffer,
      filename: entry.name || "unnamed",
      mimeType: entry.type || "application/octet-stream",
    });
  }

  // Require either a non-empty message or at least one uploaded file
  if (!message && uploadedFiles.length === 0) {
    return apiError(400, "bad_request", "message or file attachment is required");
  }

  // If no files, treat as a plain text request (no ingest needed)
  if (uploadedFiles.length === 0) {
    return {
      message,
      conversationId: typeof conversationId === "string" ? conversationId : undefined,
      model: typeof model === "string" ? model : undefined,
      appContext,
      ...(workspaceId ? { workspaceId } : {}),
      ...(identity ? { identity } : {}),
    };
  }

  // Ingest files: validate, store, extract text, build content parts.
  // Files MUST be workspace-scoped so the files__* tools can find them.
  const store = createFileStore(join(runtime.getWorkspaceScopedDir(workspaceId), "files"));
  const filesConfig = runtime.getFilesConfig();
  // Use conversationId if provided, otherwise a placeholder (will be replaced by runtime.chat)
  const convId = (typeof conversationId === "string" && conversationId) || "pending";
  const ingestResult = await ingestFiles(uploadedFiles, convId, store, filesConfig);

  if (ingestResult.errors.length > 0) {
    return apiError(400, "file_upload_error", "File upload failed", {
      errors: ingestResult.errors,
    });
  }

  return {
    message,
    conversationId: typeof conversationId === "string" ? conversationId : undefined,
    model: typeof model === "string" ? model : undefined,
    appContext,
    contentParts: ingestResult.contentParts,
    fileRefs: ingestResult.fileRefs,
    ...(workspaceId ? { workspaceId } : {}),
    ...(identity ? { identity } : {}),
  };
}

// --- Helpers ---

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return apiError(400, "bad_request", "Request body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    return apiError(400, "bad_request", "Invalid JSON body");
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
