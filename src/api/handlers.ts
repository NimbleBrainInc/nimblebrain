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
import { filterPlacementsForWorkspace } from "../runtime/workspace-access.ts";
import type { HealthMonitor } from "../tools/health-monitor.ts";
import { InlineSource } from "../tools/inline-source.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import type { ConversationEventManager } from "./conversation-events.ts";
import type { SseEventManager } from "./events.ts";
import { type SseHeartbeat, startSseHeartbeat } from "./sse-heartbeat.ts";
import { apiError } from "./types.ts";

const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

/**
 * Interval between SSE comment heartbeats on /v1/chat/stream. Chosen to sit
 * safely below AWS ALB idle-timeout (60s default, raised to 900s in
 * `deployments/agent-platform/*`) while staying quiet enough to be
 * invisible to the user.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

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
  let heartbeat: SseHeartbeat = { stop: () => {} };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      markClosed = () => {
        closed = true;
        heartbeat.stop();
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // Keep the TCP connection alive during slow tool calls (Typst
      // compile, MCP task-augmented research) — ALB idle-timeout kills
      // silent streams.
      heartbeat = startSseHeartbeat(controller, HEARTBEAT_INTERVAL_MS);
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
    version: pkg.version,
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

  // Check if this is an InlineSource (platform capabilities + nb core).
  // InlineSources serve ui:// resources directly from in-process HTML strings.
  if (!workspaceId) throw new Error("Workspace ID required");
  const registry = await runtime.ensureWorkspaceRegistry(workspaceId);
  const source = registry.getSources().find((s) => s.name === appName);

  if (source instanceof InlineSource) {
    // Resolve "primary" to the source's first placement resourceUri
    let resolvedPath = resourcePath;
    if (resourcePath === "primary") {
      const placements = source.getPlacements();
      const primaryUri = placements.find((p) => p.resourceUri)?.resourceUri;
      if (primaryUri) {
        resolvedPath = primaryUri.replace(/^ui:\/\//, "");
      }
    }

    const html = source.readResource(resolvedPath);
    if (html) {
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }
    return apiError(404, "resource_not_found", `Resource "ui://${resourcePath}" not found`, {
      resource: `ui://${resourcePath}`,
    });
  }

  // MCP-based apps (user-installed workspace bundles)
  const instance = runtime.getLifecycle().getInstance(appName, workspaceId);
  if (!instance) {
    return apiError(404, "not_found", `App "${appName}" not found`);
  }

  // "primary" is a virtual path that resolves to the first placement's resourceUri
  let resolvedPath = resourcePath;
  if (resourcePath === "primary" && instance.ui?.placements?.[0]?.resourceUri) {
    resolvedPath = instance.ui.placements[0].resourceUri.replace(/^ui:\/\//, "");
  }

  const resource = await runtime.readAppResource(appName, resolvedPath, workspaceId);
  if (resource === null) {
    return apiError(404, "resource_not_found", `Resource "ui://${resourcePath}" not found`, {
      resource: `ui://${resourcePath}`,
    });
  }

  // Binary resource (PDF, image, etc.)
  if (resource.blob) {
    return new Response(resource.blob.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": resource.mimeType || "application/octet-stream",
        "Content-Disposition": "inline",
      },
    });
  }

  // Text resource (HTML, JSON, etc.)
  return new Response(resource.text ?? "", {
    headers: { "Content-Type": resource.mimeType || "text/html" },
  });
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

  const entry: Record<string, unknown> = { uri };
  if (resource.mimeType) entry.mimeType = resource.mimeType;
  if (resource.blob) {
    entry.blob = bytesToBase64(resource.blob);
  } else {
    entry.text = resource.text ?? "";
  }

  return json({ contents: [entry] });
}

/**
 * Base64-encode a Uint8Array. Prefers Bun/Node's native Buffer (single C++
 * call, significantly faster on large binaries than the chunked btoa path).
 * Falls back to a stack-safe btoa loop for runtimes without Buffer.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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

  // 2. Resolve active workspace
  const preferred = req.headers.get("X-Preferred-Workspace");
  let activeWorkspace: string | undefined;
  if (preferred && userWorkspaces.some((ws) => ws.id === preferred)) {
    activeWorkspace = preferred;
  } else if (userWorkspaces.length === 1) {
    activeWorkspace = userWorkspaces[0]!.id;
  } else if (userWorkspaces.length > 0) {
    activeWorkspace = userWorkspaces[0]!.id;
  }

  // 3. Shell placements filtered by active workspace
  let placements = runtime.getPlacementRegistry().all();
  if (activeWorkspace) {
    const workspace = allWorkspaces.find((ws) => ws.id === activeWorkspace);
    if (workspace) {
      placements = filterPlacementsForWorkspace(placements, workspace);
    }
  }

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
    activeWorkspace: activeWorkspace ?? null,
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
    version: pkg.version,
    buildSha: process.env.NB_BUILD_SHA || null,
  });
}

/** Handle GET /v1/shell — placement registry for web client bootstrap. */
export async function handleShell(runtime: Runtime, workspaceId?: string): Promise<Response> {
  let placements = runtime.getPlacementRegistry().all();

  if (workspaceId) {
    const workspace = await runtime.getWorkspaceStore().get(workspaceId);
    if (workspace) {
      placements = filterPlacementsForWorkspace(placements, workspace);
    }
  }

  return json({
    placements,
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
