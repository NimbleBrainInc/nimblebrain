import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CallbackEventSink } from "../adapters/callback-events.ts";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import { CONVERSATION_ID_RE } from "../conversation/types.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { ingestFiles, isAllowedMime, type UploadedFile } from "../files/ingest.ts";
import { resolveMimeType } from "../files/mime.ts";
import type { FileEntry } from "../files/types.ts";
import { FILE_ID_RE } from "../files/uri.ts";
import {
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  getArtifactResolver,
  InvalidArtifactUriError,
  isArtifactUri,
} from "../host-resources/artifacts/index.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import { RefreshTokenError } from "../identity/provider.ts";
import { DEV_IDENTITY } from "../identity/providers/dev.ts";
import { log } from "../observability/log.ts";
import {
  ConversationAccessDeniedError,
  ConversationCorruptedError,
  RunInProgressError,
} from "../runtime/errors.ts";
import {
  type RequestContext,
  type RequestScope,
  runWithRequestContext,
} from "../runtime/request-context.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { ChatRequest } from "../runtime/types.ts";
import { coerceInputForSchema } from "../tools/coerce-input.ts";
import type { HealthMonitor } from "../tools/health-monitor.ts";
import { parseNamespacedSourceName } from "../tools/namespace.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ResourceData, ToolSource } from "../tools/types.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import { estimateCost } from "../usage/cost.ts";
import { bytesToBase64 } from "../util/base64.ts";
import { PersonalWorkspaceInvariantError } from "../workspace/errors.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { personalWorkspaceIdFor } from "../workspace/workspace-store.ts";
import type { ConversationEventManager } from "./conversation-events.ts";
import type { SseEventManager } from "./events.ts";
import { artifactResolutionsTotal } from "./metrics.ts";
import { ChatRequestBody, ToolCallRequestEnvelope } from "./schemas/rest.ts";
import { validateAgainst } from "./schemas/validate.ts";
import { startSseHeartbeat } from "./sse-heartbeat.ts";
import { apiError } from "./types.ts";

const pkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
// Deployments inject NB_VERSION at deploy time via env — the image itself is
// version-agnostic, so releases promote-by-retag instead of rebuilding (see
// release.yml). Local dev / non-deployed builds leave it unset and fall back to
// package.json, which is pinned to the sentinel "0.0.0-dev" and intentionally
// never bumped — the git tag is the sole source of truth for released versions
// (see RELEASING.md §1).
const VERSION = process.env.NB_VERSION || pkg.version;

/**
 * Interval between SSE comment heartbeats on /v1/chat/stream. Chosen to sit
 * safely below a typical proxy/load-balancer idle-timeout (60s on AWS ALB
 * by default) while staying quiet enough to be invisible to the user.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** Handle POST /v1/chat — synchronous chat request. */
export async function handleChat(
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

  // Same self-echo-suppression contract as /v1/chat/stream: if the
  // caller has an open conv-events SSE on this conversation, they can
  // pass its server-issued subscriber id so the broadcast skips it.
  const originSubscriberId = request.headers.get("x-origin-subscriber-id") ?? undefined;

  try {
    // The run is owned by the runtime, not by this HTTP request — we do
    // NOT pass `request.signal`. A client disconnect (mobile screen-lock,
    // backgrounded tab, network blip) must not cancel the in-flight
    // engine loop; the run completes server-side, persists, and is
    // replayed to any reconnecting /v1/conversations/:id/events
    // subscriber. (The automations executor's deadline cancellation is
    // unaffected — that path supplies its own AbortController.)
    const result = await runtime.chat(parsed);
    // Cost is derived at the boundary, never stored. Same wire shape as
    // the streaming `done` event so clients see one consistent contract.
    const wireUsage = {
      ...result.usage,
      costUsd: estimateCost(result.usage.model, result.usage),
    };
    // Stage 2: chat is identity-bound, so there is no `ChatResult.workspaceId`
    // — per-tool-call workspace attribution lives on each `tool.done` event's
    // `workspaceId` field (stamped from the orchestrator's resolved
    // namespace), not on the response envelope. (`ChatRequest.workspaceId`
    // exists as the focused workspace for prompt scoping, but it's an input,
    // not part of the result.)
    const responseBody = {
      ...result,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      usage: wireUsage,
    };

    // Same-user cross-tab broadcast — parity with /v1/chat/stream. A
    // peer tab on /v1/conversations/:id/events sees the user.message
    // (so the visible chat updates immediately) and the `done`
    // payload (final response + usage). The synchronous caller still
    // gets the full result inline; this just keeps any peer tabs in
    // sync. Subscriber-keyed exclusion prevents echo to the sender
    // (see conversation-events.ts::broadcastToConversation docblock).
    if (conversationEventManager && identity) {
      const broadcastConvId = parsed.conversationId ?? result.conversationId;
      if (broadcastConvId) {
        conversationEventManager.broadcastToConversation(
          broadcastConvId,
          "user.message",
          {
            userId: identity.id,
            displayName: identity.displayName,
            content: parsed.message,
            timestamp: new Date().toISOString(),
          },
          originSubscriberId,
        );
        conversationEventManager.broadcastToConversation(
          broadcastConvId,
          "done",
          responseBody as Record<string, unknown>,
          originSubscriberId,
        );
      }
    }

    return json(responseBody);
  } catch (err) {
    const mapped = mapChatTurnError(err);
    if (mapped) return mapped;
    throw err;
  }
}

/** Map a chat-turn error to its HTTP response, or null to rethrow. */
function mapChatTurnError(err: unknown): Response | null {
  if (err instanceof RunInProgressError) {
    return runInProgressResponse(err.conversationId);
  }
  if (err instanceof ConversationAccessDeniedError) {
    return conversationAccessDeniedResponse(err.conversationId);
  }
  if (err instanceof ConversationCorruptedError) {
    return conversationCorruptedResponse(err);
  }
  return null;
}

function runInProgressResponse(conversationId: string): Response {
  return apiError(
    409,
    "run_in_progress",
    "This conversation already has an active response. Wait for it to finish before sending another message.",
    { conversationId },
  );
}

/**
 * Handle POST /v1/chat/start — kick off a detached, server-authoritative turn
 * and return the conversation id immediately. The turn runs to completion on
 * the server regardless of this request's lifecycle (closing the tab does NOT
 * cancel it). Clients watch the turn via GET /v1/conversations/:id/events,
 * which replays the in-flight turn then tails live.
 */
export async function handleChatStart(
  request: Request,
  runtime: Runtime,
  features: ResolvedFeatures,
  identity?: UserIdentity,
  workspaceId?: string,
): Promise<Response> {
  const parsed = await parseChatBody(request, runtime, features, identity, workspaceId);
  if (parsed instanceof Response) return parsed;
  try {
    const { conversationId } = await runtime.startTurn(parsed);
    return Response.json({ conversationId });
  } catch (err) {
    if (err instanceof RunInProgressError) {
      return runInProgressResponse(parsed.conversationId ?? "");
    }
    if (err instanceof ConversationAccessDeniedError) {
      return apiError(
        403,
        "conversation_access_denied",
        "You do not have access to this conversation.",
        { conversationId: parsed.conversationId },
      );
    }
    // startTurn → store.load can throw on a pre-migration (ownerless)
    // conversation. Map to 422 — parity with handleChat / handleChatCancel —
    // instead of leaking a raw 500.
    if (err instanceof ConversationCorruptedError) {
      return conversationCorruptedResponse(err);
    }
    throw err;
  }
}

/**
 * Handle POST /v1/conversations/:id/cancel — the explicit Stop button. The
 * ONLY thing that aborts generation; client disconnect does not. Ownership is
 * enforced (same posture as the events route).
 */
export async function handleChatCancel(
  conversationId: string,
  runtime: Runtime,
  identity?: UserIdentity,
): Promise<Response> {
  // Reject a malformed id with 400 before it reaches the store, where
  // `validateConversationId` would throw a plain Error that bubbles to a 500.
  // Mirrors the `/v1/chat/start` schema guard and the events route.
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return apiError(400, "bad_request", "Invalid conversationId format");
  }
  const callerId = identity?.id ?? (runtime.getIdentityProvider() ? null : DEV_IDENTITY.id);
  if (!callerId) {
    return apiError(401, "authentication_required", "Authentication required.");
  }
  const conversation = await runtime.findConversation(conversationId).catch((err) => {
    if (err instanceof ConversationCorruptedError) return err;
    throw err;
  });
  if (conversation instanceof ConversationCorruptedError) {
    return apiError(422, "conversation_corrupted", conversation.message, {
      conversationId: conversation.conversationId,
      reason: conversation.reason,
    });
  }
  if (!conversation) {
    return apiError(404, "not_found", "Conversation not found");
  }
  if (conversation.ownerId !== callerId) {
    return apiError(
      403,
      "conversation_access_denied",
      "You do not have access to this conversation.",
      {
        conversationId,
      },
    );
  }
  const cancelled = runtime.cancelTurn(conversationId);
  return Response.json({ cancelled });
}

function conversationAccessDeniedResponse(conversationId: string): Response {
  return apiError(
    403,
    "conversation_access_denied",
    "You do not have access to this conversation.",
    { conversationId },
  );
}

function conversationCorruptedResponse(err: ConversationCorruptedError): Response {
  // 422 (Unprocessable Entity) over 500: the request is well-formed
  // but the server-side state can't process it until an operator
  // runs the migration. Surfacing the migration command in the
  // message gives the operator the next step instead of a stack
  // trace in the logs.
  return apiError(422, "conversation_corrupted", err.message, {
    conversationId: err.conversationId,
    reason: err.reason,
  });
}

/**
 * Map `PersonalWorkspaceInvariantError` to a structured 422 response.
 * Mirrors `conversationCorruptedResponse` — 422 over 500 because the
 * request is well-formed; the state it would produce isn't. The
 * `reason` field is the structured handle clients use to react (e.g.
 * surface "cannot remove members from a personal workspace" without
 * parsing the human message).
 */
function personalWorkspaceInvariantResponse(err: PersonalWorkspaceInvariantError): Response {
  return apiError(422, "personal_workspace_invariant", err.message, {
    workspaceId: err.workspaceId,
    reason: err.reason,
  });
}

/**
 * Recognize the structuredContent shape that the workspace-mgmt tool
 * handlers emit when they catch `PersonalWorkspaceInvariantError`.
 * `structuredContent` rides through the in-process MCP serialization
 * intact, so we can re-detect the original invariant violation from the
 * tool result on the HTTP side without preserving the typed class
 * across the boundary. See `workspace-mgmt-tools.ts::personalWorkspaceInvariantToolResult`.
 */
function isPersonalWorkspaceInvariantToolResult(structured: unknown): structured is {
  error: "personal_workspace_invariant";
  workspaceId: string;
  reason: string;
  message?: string;
} {
  if (!structured || typeof structured !== "object") return false;
  const obj = structured as Record<string, unknown>;
  return (
    obj.error === "personal_workspace_invariant" &&
    typeof obj.workspaceId === "string" &&
    typeof obj.reason === "string"
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

  // The sender's own /v1/conversations/:id/events subscription (if any)
  // is indistinguishable from peer-tab subscriptions by userId post-
  // Stage-1. The client passes its subscription's `subscriberId` here
  // so the broadcast skips it and the sender's tab doesn't double-
  // process the event (once via this chat-stream response, once via
  // its conv-events subscription). Optional — clients that aren't
  // subscribed get full fan-out, which is correct.
  const originSubscriberId = request.headers.get("x-origin-subscriber-id") ?? undefined;

  const convId = parsed.conversationId;

  const sink = new CallbackEventSink();
  // This HTTP stream is a detachable *observer* of the run, not its
  // owner. `markTransportClosed` lets the stream's cancel() (client
  // disconnect) stop writing to this response without touching the run.
  let markTransportClosed: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Tracks whether THIS response is still writable. It does not track
      // the run — the run's lifecycle is the sink subscription, torn down
      // in `endRun()` when the run actually ends (see the .chat() call).
      let transportOpen = true;
      // Keep the TCP connection alive during slow tool calls (Typst
      // compile, MCP task-augmented research) — ALB idle-timeout kills
      // silent streams. Must be created before `markTransportClosed`
      // captures it.
      const heartbeat = startSseHeartbeat(controller, HEARTBEAT_INTERVAL_MS);
      markTransportClosed = () => {
        if (!transportOpen) return;
        transportOpen = false;
        heartbeat.stop();
      };
      // Write to this response. No-op once the client has detached — the
      // run keeps producing events, which still reach other observers via
      // the broadcast below and the persisted conversation.
      const send = (event: string, data: unknown) => {
        if (!transportOpen) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // Close this response's stream (run finished while the client was
      // still connected — the happy path). If the client already left,
      // this is a no-op; the controller is already torn down by cancel().
      const closeTransport = () => {
        if (!transportOpen) return;
        transportOpen = false;
        heartbeat.stop();
        controller.close();
      };

      // Cross-subscriber broadcast: streams chat-stream events to other
      // SSE subscribers on /v1/conversations/:id/events. After Stage 1's
      // single-owner cutover, the only legitimate consumer is the same
      // user across browser tabs / devices (no "other participants" — the
      // sharing primitives are gone). The broadcast survives as
      // same-user cross-tab sync; Stage 4 reintroduces sharing with
      // policy gates and a real multi-user audience.
      //
      // Deferred until chat.start so RunInProgressError doesn't produce a
      // phantom user.message broadcast with no assistant reply.
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
            originSubscriberId,
          );
        }
      };

      const unsubscribe = sink.subscribe((event: EngineEvent) => {
        if (
          event.type === "chat.start" ||
          event.type === "text.delta" ||
          event.type === "reasoning.delta" ||
          event.type === "tool.preparing" ||
          event.type === "tool.preparing.done" ||
          event.type === "tool.start" ||
          event.type === "tool.done" ||
          event.type === "llm.done" ||
          event.type === "data.changed"
        ) {
          if (event.type === "chat.start") {
            broadcastUserMessageOnce();
          }
          send(event.type, event.data);
          // Same-user cross-tab broadcast. The exclude key is the
          // sender's own subscriber id (if any) — see the
          // `originSubscriberId` block above for why subscriber-keyed
          // exclusion is correct and userId-keyed exclusion isn't.
          if (convId && conversationEventManager && identity) {
            conversationEventManager.broadcastToConversation(
              convId,
              event.type,
              event.data as Record<string, unknown>,
              originSubscriberId,
            );
          }
        }
      });

      // Called exactly once when the run terminates (success or error),
      // independent of transport state. Releasing the sink subscription
      // here — not on client disconnect — is what lets a run finish in
      // the background after the phone locks or the tab is backgrounded.
      const endRun = () => {
        unsubscribe();
        closeTransport();
      };

      runtime
        // The run is deliberately NOT bound to this HTTP request: we do
        // not pass `request.signal`. A client disconnect closes the
        // stream (cancel() → markTransportClosed) but must not cancel the
        // engine loop. The run completes server-side, persists to the
        // conversation store, and replays to any reconnecting
        // /v1/conversations/:id/events subscriber — the "leave and come
        // back" contract. Binding the run to the connection would silently
        // abandon a prompt the moment a mobile client dropped. The one
        // caller that must cancel on a deadline — the automations executor —
        // owns its own AbortController in bundles/automations/src/executor.ts.
        .chat(parsed, sink)
        .then((result) => {
          // Cost is computed at the API boundary — never stored. The
          // wire-format `usage.costUsd` is what clients display; deriving
          // it here means there is exactly one place this number is
          // produced for live responses.
          const wireUsage = {
            ...result.usage,
            costUsd: estimateCost(result.usage.model, result.usage),
          };
          // Stage 2 (T006): no `workspaceId` on the chat-level done
          // envelope — per-tool-call attribution lives on each
          // `tool.done` event's payload above. See `ChatResult`'s
          // doc comment for the rationale.
          const doneData = {
            response: result.response,
            conversationId: result.conversationId,
            skillName: result.skillName,
            toolCalls: result.toolCalls,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            stopReason: result.stopReason,
            usage: wireUsage,
          };
          send("done", doneData);
          // Same-user cross-tab broadcast (Stage 1 single-owner).
          // Subscriber-keyed exclude — see docblock.
          if (conversationEventManager && identity) {
            const broadcastConvId = convId ?? result.conversationId;
            if (broadcastConvId) {
              conversationEventManager.broadcastToConversation(
                broadcastConvId,
                "done",
                doneData as Record<string, unknown>,
                originSubscriberId,
              );
            }
          }
          endRun();
        })
        .catch((err) => {
          if (err instanceof RunInProgressError) {
            send("error", {
              error: "run_in_progress",
              message: "This conversation already has an active response.",
            });
            endRun();
            return;
          }
          if (err instanceof ConversationAccessDeniedError) {
            send("error", {
              error: "conversation_access_denied",
              message: "You do not have access to this conversation.",
            });
            endRun();
            return;
          }
          if (err instanceof ConversationCorruptedError) {
            send("error", {
              error: "conversation_corrupted",
              message: err.message,
            });
            endRun();
            return;
          }
          log.error("[routes] handleChatStream failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          const raw = err instanceof Error ? err.message : String(err);
          const friendly = friendlyError(raw);
          send("error", {
            error: friendly.code,
            message: friendly.message,
          });
          endRun();
        });
    },
    cancel() {
      // The client went away (disconnect / phone lock / tab close).
      // Detach this observer ONLY — the run continues to completion.
      markTransportClosed();
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

/**
 * Serve a ui:// resource from an identity app (conversations, …) for GET
 * /v1/apps/:name/resources/:path. Identity apps live OUTSIDE any workspace and
 * read from the kernel identity source; "primary" resolves to the source's
 * first declared placement.
 */
async function serveIdentityAppResource(
  runtime: Runtime,
  appName: string,
  resourcePath: string,
  identitySource: ToolSource,
): Promise<Response> {
  let resolvedPath = resourcePath;
  if (resourcePath === "primary") {
    const primaryUri = resolveSourcePrimaryResourceUri(identitySource);
    if (primaryUri) resolvedPath = primaryUri.replace(/^ui:\/\//, "");
  }
  const resource = await runtime.readIdentityAppResource(appName, resolvedPath);
  if (resource === null) {
    return apiError(404, "resource_not_found", `Resource "ui://${resourcePath}" not found`, {
      resource: `ui://${resourcePath}`,
    });
  }
  return json({ contents: [buildResourceEnvelopeEntry(`ui://${resolvedPath}`, resource)] });
}

/** Handle GET /v1/apps/:name/resources/:path — fetch a ui:// resource. */
export async function handleResourceProxy(
  appName: string,
  resourcePath: string,
  runtime: Runtime,
  workspaceId?: string,
  identity?: UserIdentity,
): Promise<Response> {
  // Dev mode: redirect to local Vite dev server when --app flag is active.
  // Applies to both identity and workspace apps, so it runs first.
  const { isDevMode, getAppDevUrl } = await import("../runtime/dev-registry.ts");
  if (isDevMode(appName)) {
    const devUrl = getAppDevUrl(appName)!;
    const target = resourcePath === "primary" ? "/" : `/${resourcePath}`;
    return Response.redirect(`${devUrl}${target}`, 302);
  }

  // Identity apps (conversations, …) live OUTSIDE any workspace. They are
  // authorized by the authenticated session (requireAuth already ran on this
  // route) and read from the kernel identity source — never a workspace
  // registry. A stale `X-Workspace-Id` (the last active workspace the shell
  // sent) is ignored: location is scope, and an identity app has no workspace
  // location to authorize against.
  const identitySource = runtime.getIdentitySource(appName);
  if (identitySource) {
    return serveIdentityAppResource(runtime, appName, resourcePath, identitySource);
  }

  // Workspace apps — resolve the workspace and authorize membership. Both
  // platform built-ins and user-installed bundles are MCP servers reachable
  // through the workspace registry; registry membership is the authoritative
  // "is this app available to this workspace?" check. A qualified
  // `ws_<id>-<app>` (a cross-workspace app icon / primary preview surfaced
  // from another workspace) resolves to its own workspace by name + member-
  // ship; a bare app name uses the ambient X-Workspace-Id.
  const resolved = await resolveRestSourceWorkspace(runtime, appName, identity, workspaceId, () =>
    apiError(400, "workspace_required", `App "${appName}" requires a workspace`, { app: appName }),
  );
  if (!resolved.ok) return resolved.response;
  const { workspaceId: wsId, sourceName } = resolved;
  const wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
  if (!wsRegistry.hasSource(sourceName)) {
    return apiError(
      403,
      "workspace_access_denied",
      `App "${appName}" is not available in this workspace`,
      { app: appName },
    );
  }

  let resolvedPath = resourcePath;
  if (resourcePath === "primary") {
    const primaryUri = await resolvePrimaryResourceUri(runtime, sourceName, wsId);
    if (primaryUri) {
      resolvedPath = primaryUri.replace(/^ui:\/\//, "");
    }
  }

  const resource = await runtime.readAppResource(sourceName, resolvedPath, wsId);
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
  return resolveSourcePrimaryResourceUri(source);
}

/**
 * Resolve a source's "primary" `resourceUri` by scanning the placements it
 * declares via `getPlacements()` (the in-process `McpSource` duck-type). Used
 * directly by the identity-app host (no workspace, no lifecycle instance) and
 * as the fallback tier of {@link resolvePrimaryResourceUri} for workspace
 * apps. Returns `null` when the source declares no placement with a
 * `resourceUri`.
 */
function resolveSourcePrimaryResourceUri(source: unknown): string | null {
  const fn = (source as { getPlacements?: () => unknown } | undefined)?.getPlacements;
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
 * Resolve which workspace + bare source a REST resource/tool request targets.
 *
 * The first-party web shell speaks stateless REST and names a source one of
 * two ways:
 *
 *   - **Qualified** `ws_<id>-<source>` — the shell names a source in a
 *     specific workspace directly (e.g. reading back a preview / citation link
 *     minted in another workspace). The NAME is authoritative: resolve the
 *     owning workspace from it and authorize by MEMBERSHIP — exactly as the
 *     engine's `routeToolCall` does ("derived ONLY from the parsed wsId; we
 *     never reach for any ambient current-workspace pointer"). The ambient
 *     `X-Workspace-Id` is irrelevant here — a preview link minted in one
 *     workspace must read back from a conversation focused on another. This is
 *     the same principle that already lets identity sources (`files`,
 *     `conversations`) ignore the header. This is a trusted first-party REST
 *     surface gated to the caller's own workspaces; the agent never dispatches
 *     here (it uses the walled in-process `IdentityToolRouter`).
 *
 *   - **Bare** `<source>` — a focused-workspace tool; its workspace is the
 *     ambient `X-Workspace-Id` (unchanged legacy behavior).
 *
 * Returns the bare source name the workspace registry is keyed on (registry
 * sources keep their bare name; only tool names get the `ws_<id>-` prefix), so
 * callers must use `sourceName` — never the raw qualified `server` — for
 * `hasSource` / `getSources` / `readAppResource`.
 *
 * Identity sources are handled by the caller BEFORE this and never reach here.
 */
async function resolveRestSourceWorkspace(
  runtime: Runtime,
  server: string,
  identity: UserIdentity | null | undefined,
  ambientWorkspaceId: string | undefined,
  // Each endpoint had its own error for "bare source, no ambient workspace"
  // before this resolver existed (read: `bad_request`; tool-call / proxy:
  // `workspace_required` with a server/app detail). Let callers keep their
  // original contract so this refactor doesn't silently change error codes.
  missingWorkspaceError?: () => Response,
): Promise<
  { ok: true; workspaceId: string; sourceName: string } | { ok: false; response: Response }
> {
  let qualified: { wsId: string; sourceName: string } | null;
  try {
    qualified = parseNamespacedSourceName(server);
  } catch {
    // A `ws_`-prefixed but malformed id is a probe/typo, not a bare name.
    return {
      ok: false,
      response: apiError(400, "bad_request", `Invalid server "${server}"`, { server }),
    };
  }

  if (!qualified) {
    // Bare source — ambient-workspace behavior.
    if (!ambientWorkspaceId) {
      return {
        ok: false,
        response:
          missingWorkspaceError?.() ?? apiError(400, "bad_request", "Workspace ID required"),
      };
    }
    return { ok: true, workspaceId: ambientWorkspaceId, sourceName: server };
  }

  // Qualified — the name names its workspace; authorize by membership and
  // ignore the ambient X-Workspace-Id.
  if (!identity) {
    return { ok: false, response: apiError(401, "unauthorized", "Authentication required") };
  }
  const accessible = await runtime.getWorkspaceStore().getWorkspacesForUser(identity.id);
  if (!accessible.some((w) => w.id === qualified.wsId)) {
    return {
      ok: false,
      response: apiError(
        403,
        "workspace_access_denied",
        `Server "${server}" is not available in this workspace`,
        { server },
      ),
    };
  }
  return { ok: true, workspaceId: qualified.wsId, sourceName: qualified.sourceName };
}

/**
 * Read an `artifact://` URI as the viewing workspace for POST /v1/resources/read.
 * RLS in the data plane is the enforcement point — a second workspace's read is
 * denied and surfaces as 404 (absent and forbidden are indistinguishable).
 */
async function readArtifactResource(
  uri: string,
  workspaceId: string | undefined,
): Promise<Response> {
  if (!workspaceId) {
    return apiError(400, "bad_request", "artifact:// reads require a workspace context");
  }
  const resolver = getArtifactResolver();
  try {
    const result = await resolver.read(uri, workspaceId);
    artifactResolutionsTotal.inc({ result: "ok" });
    return json(result as Record<string, unknown>);
  } catch (err) {
    return mapArtifactReadError(err, uri, workspaceId);
  }
}

/** Map an artifact-resolver read error to its HTTP response, tagging the resolution metric. */
function mapArtifactReadError(err: unknown, uri: string, workspaceId: string): Response {
  // A malformed `artifact://` id is client input, not a server fault: 400,
  // and never warn-log it — a hostile/typo'd URI must not spam the logs.
  if (err instanceof InvalidArtifactUriError) {
    artifactResolutionsTotal.inc({ result: "malformed" });
    log.debug("host-resources", `[artifact] rejected malformed URI ${uri}: ${err.message}`);
    return apiError(400, "bad_request", "Malformed artifact:// URI", { uri });
  }
  if (err instanceof ArtifactNotFoundError) {
    // High-signal: the host emitted this link and now can't resolve it —
    // most often a cross-workspace reference RLS-denied at the data plane.
    // The 404 is otherwise silent; this counter is the fleet-level signal.
    artifactResolutionsTotal.inc({ result: "not_found" });
    return apiError(404, "resource_not_found", `Resource "${uri}" not found`, { uri });
  }
  if (err instanceof ArtifactTooLargeError) {
    artifactResolutionsTotal.inc({ result: "too_large" });
    return apiError(413, "resource_too_large", err.message, { uri });
  }
  artifactResolutionsTotal.inc({ result: "error" });
  log.warn(
    `[artifact] read ${uri} (ws=${workspaceId}) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  return apiError(502, "resource_read_failed", "Failed to resolve artifact", { uri });
}

/**
 * Read a resource from a kernel identity source (conversations, files,
 * automations) for POST /v1/resources/read. Files are workspace-owned, so a
 * `files://<id>` read resolves in the request's focused workspace (or the
 * caller's personal workspace when unfocused); conversations/automations ignore it.
 */
async function readIdentitySourceResource(
  runtime: Runtime,
  server: string,
  uri: string,
  options: { workspaceId?: string; identity?: UserIdentity } | undefined,
): Promise<Response> {
  const identity = options?.identity;
  const reqCtx: RequestContext = {
    identity: identity ?? null,
    scope: { kind: "identity" },
    fileWorkspaceId:
      options?.workspaceId ?? personalWorkspaceIdFor(runtime.resolveRequestUserId(identity)),
  };
  const resource = await runWithRequestContext(reqCtx, () =>
    runtime.readIdentityAppResource(server, uri),
  );
  if (resource === null) {
    return apiError(404, "resource_not_found", `Resource "${uri}" not found`, { server, uri });
  }
  return json({ contents: [buildResourceEnvelopeEntry(uri, resource)] });
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
  options?: { workspaceId?: string; identity?: UserIdentity },
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const { server, uri } = body as { server?: string; uri?: string };
  if (!uri || typeof uri !== "string") {
    return apiError(400, "bad_request", "'uri' is required");
  }

  // `artifact://` is host-resolved against the shared data plane, not against
  // any producing bundle — the bundle is never in the read path. It carries no
  // `server`, and resolution is uniform across every capability. Intercept it
  // here, before per-source routing, and read as the VIEWING USER: the verified
  // workspace from the request scopes the minted read token, and RLS in the data
  // plane is the enforcement point. A second workspace cannot read another's
  // artifact — the read is denied and surfaces as 404 (absent and forbidden are
  // intentionally indistinguishable, so a guessed id can't probe inventory).
  if (isArtifactUri(uri)) {
    return readArtifactResource(uri, options?.workspaceId);
  }

  if (!server || typeof server !== "string") {
    return apiError(400, "bad_request", "'server' is required");
  }

  // Identity sources (conversations, files, automations) live OUTSIDE any
  // workspace registry — they're reached through the identity door, the same
  // decision the orchestrator and `handleToolCall` make. But files are
  // workspace-owned, so a `files://<id>` read resolves in the request's focused
  // workspace (`options.workspaceId`, or the caller's personal workspace when
  // unfocused), set via `fileWorkspaceId`. conversations/automations ignore it.
  const { identity } = options ?? {};
  if (runtime.getIdentitySource(server)) {
    return readIdentitySourceResource(runtime, server, uri, options);
  }

  // Workspace scoping. A qualified `ws_<id>-<source>` server resolves to its
  // OWN workspace by name + membership (cross-workspace preview links); a bare
  // source uses the ambient X-Workspace-Id. `sourceName` is the bare name the
  // registry is keyed on.
  const resolved = await resolveRestSourceWorkspace(
    runtime,
    server,
    identity,
    options?.workspaceId,
  );
  if (!resolved.ok) return resolved.response;
  const { workspaceId, sourceName } = resolved;

  const wsRegistry = await runtime.ensureWorkspaceRegistry(workspaceId);
  if (!wsRegistry.hasSource(sourceName)) {
    return apiError(
      403,
      "workspace_access_denied",
      `Server "${server}" is not available in this workspace`,
      { server },
    );
  }

  // Wrap the source's read in a request-scoped context so the
  // AsyncLocalStorage-backed `runtime.requireWorkspaceId()` is available
  // to any callback-form resource (e.g. `instructions://workspace`'s
  // `text: () => store.read({ wsId: runtime.requireWorkspaceId() })`).
  // Without this wrapper, those callbacks throw and `McpSource.readResource`
  // catches the exception, returning null → 404 to the caller.
  const reqCtx: RequestContext = {
    identity: null,
    scope: { kind: "workspace", workspaceId, workspaceAgents: null, workspaceModelOverride: null },
  };
  const resource = await runWithRequestContext(reqCtx, () =>
    runtime.readAppResource(sourceName, uri, workspaceId),
  );
  if (resource === null) {
    return apiError(404, "resource_not_found", `Resource "${uri}" not found`, {
      server,
      uri,
    });
  }

  return json({ contents: [buildResourceEnvelopeEntry(uri, resource)] });
}

/** Parse + validate a POST /v1/tools/call envelope, or return an error Response. */
function parseToolCallEnvelope(
  body: Record<string, unknown>,
): { server: string; tool: string; args?: Record<string, unknown> } | Response {
  const envelopeCheck = validateAgainst(body, ToolCallRequestEnvelope);
  if (!envelopeCheck.ok) {
    return apiError(400, "bad_request", envelopeCheck.reason ?? "Invalid request envelope");
  }
  const {
    server,
    tool,
    arguments: args,
  } = body as {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
  };
  return { server, tool, args };
}

interface ToolCallTarget {
  source: ToolSource | undefined;
  scope: RequestScope;
  workspaceRegistry: ToolRegistry | undefined;
  /**
   * The bare source name the registry is keyed on. For a qualified
   * `ws_<id>-<source>` server it's the `<source>` portion; for a bare
   * identity/workspace source it's `server` unchanged.
   */
  resolvedSourceName: string;
}

/**
 * Resolve the source through the two doors — the same decision the orchestrator
 * makes for `/mcp` (`routeToolCall`). Identity sources dispatch with identity
 * scope; everything else resolves through the workspace registry (membership +
 * per-workspace permission gating on execute). Returns an error Response for the
 * bare-source-no-workspace and unknown-source cases.
 */
async function resolveToolCallTarget(
  runtime: Runtime,
  server: string,
  tool: string,
  identitySource: ToolSource | undefined,
  identity: UserIdentity | undefined,
  workspaceId: string | undefined,
): Promise<{ ok: true; target: ToolCallTarget } | { ok: false; response: Response }> {
  if (identitySource) {
    return {
      ok: true,
      target: {
        source: identitySource,
        scope: { kind: "identity" },
        workspaceRegistry: undefined,
        resolvedSourceName: server,
      },
    };
  }
  // A qualified `ws_<id>-<source>` resolves to its own workspace by name +
  // membership (cross-workspace tool surfaced via nb__search); a bare source
  // uses the ambient X-Workspace-Id. Same resolution as the resource read.
  const resolved = await resolveRestSourceWorkspace(runtime, server, identity, workspaceId, () =>
    apiError(400, "workspace_required", `Tool "${tool}" requires a workspace`, { server, tool }),
  );
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const workspaceRegistry = await runtime.ensureWorkspaceRegistry(resolved.workspaceId);
  if (!workspaceRegistry.hasSource(resolved.sourceName)) {
    return {
      ok: false,
      response: apiError(404, "tool_not_found", `Tool "${tool}" not found on server "${server}"`, {
        server,
        tool,
      }),
    };
  }
  const source = workspaceRegistry.getSources().find((s) => s.name === resolved.sourceName);
  return {
    ok: true,
    target: {
      source,
      scope: {
        kind: "workspace",
        workspaceId: resolved.workspaceId,
        workspaceAgents: null,
        workspaceModelOverride: null,
      },
      workspaceRegistry,
      resolvedSourceName: resolved.sourceName,
    },
  };
}

/**
 * Normalize `tool` to the registry's `<bareSource>__<tool>` form. It may arrive
 * bare, source-prefixed, or fully qualified (`ws_<id>-…` from the bridge) — strip
 * a leading qualified-server prefix first, then ensure the bare-source prefix.
 */
function normalizeRestToolName(tool: string, server: string, resolvedSourceName: string): string {
  let innerTool = tool;
  if (innerTool.startsWith(`${server}__`)) innerTool = innerTool.slice(server.length + 2);
  return innerTool.startsWith(`${resolvedSourceName}__`)
    ? innerTool
    : `${resolvedSourceName}__${innerTool}`;
}

/**
 * Validate a REST tools/call against the source's declared JSON Schema, coercing
 * nested string-encoded values first (see src/tools/coerce-input.ts). Returns the
 * coerced arguments, or an error Response (tool-not-found / invalid-input).
 */
async function validateRestToolInput(
  source: ToolSource,
  toolName: string,
  tool: string,
  server: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; coercedArgs: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const tools = await source.tools();
    const toolDef = tools.find((t) => t.name === toolName);
    if (!toolDef) {
      return {
        ok: false,
        response: apiError(
          404,
          "tool_not_found",
          `Tool "${tool}" not found on server "${server}"`,
          {
            server,
            tool,
          },
        ),
      };
    }
    if (!toolDef.inputSchema) return { ok: true, coercedArgs: args };
    const coercedArgs = coerceInputForSchema(args, toolDef.inputSchema);
    const validation = validateToolInput(coercedArgs, toolDef.inputSchema);
    if (!validation.valid) {
      return {
        ok: false,
        response: apiError(
          400,
          "invalid_input",
          `Invalid arguments for "${tool}": ${validation.error}`,
          {
            tool: toolName,
            errors: validation.errors,
          },
        ),
      };
    }
    return { ok: true, coercedArgs };
  } catch {
    return { ok: false, response: json({ error: "tool_not_found", server, tool }, 404) };
  }
}

/** Build the per-request AsyncLocalStorage context for a REST tools/call. */
function buildRestToolCallContext(
  identity: UserIdentity | undefined,
  scope: RequestScope,
  workspaceId: string | undefined,
  runtime: Runtime,
): RequestContext {
  return {
    identity: identity ?? null,
    scope,
    // Files are workspace-owned: an identity-door `files__*` call lands in the
    // focused workspace (validated `X-Workspace-Id`) or the caller's personal
    // workspace when unfocused. Ignored by the other identity tools.
    fileWorkspaceId: workspaceId ?? personalWorkspaceIdFor(runtime.resolveRequestUserId(identity)),
  };
}

/**
 * Dispatch a resolved REST tools/call: identity door straight to the source with
 * the bare tool name (owner-gated in the handler); workspace door through the
 * registry (per-workspace permission gating).
 */
function dispatchRestToolCall(
  identitySource: ToolSource | undefined,
  workspaceRegistry: ToolRegistry | undefined,
  toolName: string,
  callId: string,
  coercedArgs: Record<string, unknown>,
): Promise<Awaited<ReturnType<ToolRegistry["execute"]>>> {
  if (identitySource) {
    return identitySource.execute(toolName.slice(toolName.indexOf("__") + 2), coercedArgs);
  }
  // A non-identity source always resolved a workspace registry above (or we
  // 400'd); the guard narrows the type without a non-null assertion.
  if (!workspaceRegistry) throw new Error("workspace registry missing for workspace tool");
  return workspaceRegistry.execute({ id: callId, name: toolName, input: coercedArgs });
}

/** Emit bridge.tool.call (pre-execution) to the ephemeral SSE + durable event sinks. */
function emitBridgeToolCall(
  sseManager: SseEventManager | undefined,
  eventSink: EventSink | undefined,
  toolName: string,
  callId: string,
  server: string,
  identity: UserIdentity | undefined,
  scope: RequestScope,
): void {
  const event = {
    type: "bridge.tool.call" as const,
    data: {
      name: toolName,
      id: callId,
      server,
      userId: identity?.id ?? null,
      workspaceId: scope.kind === "workspace" ? scope.workspaceId : null,
    },
  };
  sseManager?.emit(event);
  eventSink?.emit(event);
}

/** Emit bridge.tool.done (post-execution) to the ephemeral SSE + durable event sinks. */
function emitBridgeToolDone(
  sseManager: SseEventManager | undefined,
  eventSink: EventSink | undefined,
  toolName: string,
  callId: string,
  ok: boolean,
  ms: number,
  identity: UserIdentity | undefined,
  scope: RequestScope,
): void {
  const event = {
    type: "bridge.tool.done" as const,
    data: {
      name: toolName,
      id: callId,
      ok,
      ms,
      userId: identity?.id ?? null,
      workspaceId: scope.kind === "workspace" ? scope.workspaceId : null,
    },
  };
  sseManager?.emit(event);
  eventSink?.emit(event);
}

/**
 * Recognize a PersonalWorkspaceInvariantError encoded in the tool result and map
 * it to a clean 422 (same body as the direct-throw path), or null when the result
 * isn't that shape. The error class doesn't survive the in-process MCP
 * serialization boundary, so workspace-mgmt tool handlers encode it as
 * `structuredContent.error === "personal_workspace_invariant"`.
 */
function personalWorkspaceInvariantResultResponse(
  result: Awaited<ReturnType<ToolRegistry["execute"]>>,
): Response | null {
  if (!result.isError || !isPersonalWorkspaceInvariantToolResult(result.structuredContent)) {
    return null;
  }
  const sc = result.structuredContent;
  return apiError(
    422,
    "personal_workspace_invariant",
    typeof sc.message === "string" ? sc.message : "Personal-workspace invariant violated",
    {
      workspaceId: sc.workspaceId,
      reason: sc.reason,
    },
  );
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

  const envelope = parseToolCallEnvelope(body);
  if (envelope instanceof Response) return envelope;
  const { server, tool, args } = envelope;

  const sseManager = options?.sseManager;
  const eventSink = options?.eventSink;
  const identity = options?.identity;
  const workspaceId = options?.workspaceId;

  // Resolve the source through the two doors — the same decision the
  // orchestrator makes for `/mcp` (`routeToolCall`). Identity sources
  // (conversations, …) are owned by the user and live OUTSIDE any workspace:
  // they dispatch with identity scope, regardless of any (stale) X-Workspace-Id.
  // Everything else resolves through the workspace registry and keeps its
  // per-workspace permission gating on execute.
  const identitySource = runtime.getIdentitySource(server);
  const targetResult = await resolveToolCallTarget(
    runtime,
    server,
    tool,
    identitySource,
    identity,
    workspaceId,
  );
  if (!targetResult.ok) return targetResult.response;
  const { source, scope, workspaceRegistry, resolvedSourceName } = targetResult.target;

  const toolName = normalizeRestToolName(tool, server, resolvedSourceName);

  // Coerced args flow through to execute below — validation and execution must
  // see the same shape. Defaults to the raw args; replaced with the
  // schema-coerced version once we resolve the tool definition.
  let coercedArgs: Record<string, unknown> = args ?? {};

  if (source) {
    const validated = await validateRestToolInput(source, toolName, tool, server, coercedArgs);
    if (!validated.ok) return validated.response;
    coercedArgs = validated.coercedArgs;
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

  // Build per-request context for AsyncLocalStorage (concurrency-safe). The
  // scope is the resolved door — identity for a kernel identity source,
  // workspace otherwise — never a nullable workspace.
  const reqCtx = buildRestToolCallContext(identity, scope, workspaceId, runtime);

  // Audit log
  log.info(`[api] tools/call server=${server} tool=${tool} identity=${identity?.id ?? "none"}`);
  const callId = `api_${crypto.randomUUID().slice(0, 8)}`;

  // Emit bridge.tool.call before execution (ephemeral SSE + durable event sink)
  emitBridgeToolCall(sseManager, eventSink, toolName, callId, server, identity, scope);

  const t0 = performance.now();
  let result: Awaited<ReturnType<ToolRegistry["execute"]>> | undefined;
  try {
    // Identity flows through AsyncLocalStorage via `reqCtx`. Sources that
    // need the caller's identity read it from `getRequestContext()`.
    //
    // Workspace tools dispatch through the registry (which applies the
    // per-workspace permission gating wired via `setPermissionContext`).
    // Identity tools have no workspace registry — dispatch straight to the
    // source with the bare tool name (owner-gated in the handler), mirroring
    // the `/mcp` identity branch.
    result = await runWithRequestContext(reqCtx, () =>
      dispatchRestToolCall(identitySource, workspaceRegistry, toolName, callId, coercedArgs),
    );
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    emitBridgeToolDone(sseManager, eventSink, toolName, callId, false, ms, identity, scope);
    // Typed invariant errors get mapped to clean HTTP status codes
    // (mirrors how /v1/chat handles ConversationCorruptedError). The
    // direct-throw path (in-process tool that bubbles up to here without
    // crossing the MCP serialization boundary) preserves the typed
    // class. The structuredContent-marker path below handles the case
    // where the error already became a ToolResult inside an in-process
    // MCP source.
    if (err instanceof PersonalWorkspaceInvariantError) {
      return personalWorkspaceInvariantResponse(err);
    }
    throw err;
  }

  // Recognize a PersonalWorkspaceInvariantError encoded in the tool result so
  // callers (web shell, external MCP clients) see a clean 422 with the same
  // structured body as the direct-throw path above.
  const invariantResponse = personalWorkspaceInvariantResultResponse(result);
  if (invariantResponse) return invariantResponse;

  const ms = Math.round(performance.now() - t0);
  // Emit bridge.tool.done after execution (ephemeral SSE + durable event sink)
  emitBridgeToolDone(sseManager, eventSink, toolName, callId, !result.isError, ms, identity, scope);

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

  // 2. Identify the user's personal workspace. Stage 1 invariant:
  //    every user has exactly one personal workspace where
  //    `isPersonal === true && ownerUserId === identity.id`. If for any
  //    reason there are multiple (data corruption — shouldn't happen),
  //    pick the earliest-created and log a warning so operators notice.
  //    If there are zero (pre-migration deployment), `personalWorkspaceId`
  //    is `null` — the active-workspace fallback below uses the first
  //    membership instead.
  const personalCandidates = userWorkspaces.filter(
    (ws) => ws.isPersonal === true && ws.ownerUserId === identity.id,
  );
  let personalWorkspaceId: string | null = null;
  if (personalCandidates.length === 1) {
    personalWorkspaceId = personalCandidates[0]!.id;
  } else if (personalCandidates.length > 1) {
    // Earliest by createdAt — list() already sorts ascending, but be
    // explicit so a future change to list ordering doesn't silently
    // change which workspace counts as "the" personal one.
    const earliest = personalCandidates
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
    personalWorkspaceId = earliest.id;
    log.warn(
      `[bootstrap] user ${identity.id} has ${personalCandidates.length} personal workspaces; ` +
        `picking earliest-created ${earliest.id}. This is data corruption — investigate.`,
    );
  } else {
    // Zero personal workspaces. Expected for legacy tenants in the
    // pre-migration window — `ensureUserWorkspace` creates one on the
    // next login, or the operator runs `migrate:personal-workspaces`.
    // Per-login bootstrap is high-volume; `log.info` (dim, greppable)
    // is enough — `console.warn` would create alarming yellow noise
    // for an expected pre-migration state.
    log.info(
      `[bootstrap] user ${identity.id} has no personal workspace. ` +
        `Run \`bun run migrate:personal-workspaces\` or trigger a re-login.`,
    );
  }

  // 3. Resolve the active (focused) workspace. The single source of truth
  // for "which workspace am I in" is the client's URL (`/w/:slug`); the
  // web shell no longer persists or sends a remembered selection. Bootstrap
  // therefore just provides a sane default focus for workspace-agnostic
  // routes (home, conversations): the user's personal workspace, falling
  // back to the first membership pre-migration. `X-Workspace-Id` is still
  // honored when present and valid (e.g. a deep-link cold-load) but is no
  // longer required — its absence is the normal case, not an error. On data
  // endpoints the same header remains authoritative (unknown wsId → 400).
  const requested = req.headers.get("X-Workspace-Id");
  const activeWorkspace: string =
    requested && userWorkspaces.some((ws) => ws.id === requested)
      ? requested
      : (personalWorkspaceId ?? userWorkspaces[0]!.id);

  // 4. Shell placements for the active workspace (ambient + scoped, merged).
  const placements = runtime.getPlacementRegistry().forWorkspace(activeWorkspace);

  // 5. Config
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
      // `isPersonal` defaults to `false` on disk for pre-Stage-1 workspaces;
      // backfilled eagerly by the personal-workspace migration.
      isPersonal: ws.isPersonal === true,
    })),
    personalWorkspaceId,
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

// --- SSE Event Stream ---

/**
 * Handle GET /v1/events — identity-scoped SSE event stream.
 *
 * The stream is bound to the caller's identity, not their active
 * workspace. The manager fans out workspace-scoped events to this
 * connection only when the wsId is in the identity's current membership
 * set (cached in the manager, refreshed by membership-change events from
 * the workspace store). Workspace switches in the UI are a no-op on this
 * transport — the same shape as `/mcp` (identity-bound session, workspace
 * context per request).
 */
export async function handleEvents(
  sseManager: SseEventManager,
  workspaceStore: WorkspaceStore,
  identityId: string,
): Promise<Response> {
  const workspaces = await workspaceStore.getWorkspacesForUser(identityId);
  const memberships = new Set(workspaces.map((ws) => ws.id));
  const stream = sseManager.addIdentityClient(identityId, memberships);
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

/** Build the `nb_session` Set-Cookie value (adds `Secure` when serving over HTTPS). */
function sessionCookie(accessToken: string, secure: boolean): string {
  const parts = [`nb_session=${accessToken}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=3600"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build the `nb_refresh` Set-Cookie value (adds `Secure` when serving over HTTPS). */
function refreshCookie(refreshToken: string, secure: boolean): string {
  const parts = [
    `nb_refresh=${refreshToken}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/v1/auth",
    "Max-Age=2592000",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Read the `nb_refresh` token from the request Cookie header, or null. */
function readRefreshCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("nb_refresh=")) return trimmed.slice("nb_refresh=".length);
  }
  return null;
}

/** Map a token-refresh failure to its HTTP response: rejected → 401, transient → 503. */
function mapOidcRefreshError(err: unknown): Response {
  // The provider classifies the failure (it owns its SDK's error shapes); we
  // only map that verdict to a status. A `rejected` refresh means the session
  // is genuinely dead → 401, the client logs out and re-authenticates. Any
  // other failure is transient/infrastructural → 503 `refresh_unavailable`,
  // which the client treats as "keep the session and retry" rather than
  // logging a valid user out over a network blip or a deploy-time 5xx. (This
  // is the server-side half of the same fix as fetch-with-refresh.ts.)
  if (err instanceof RefreshTokenError && err.kind === "rejected") {
    // Expected (session expired/revoked). Log terse, no stack.
    log.warn(
      "[nimblebrain] Token refresh rejected (session expired) — client will re-authenticate",
    );
    return apiError(401, "refresh_failed", "Token refresh failed");
  }
  // Transient: log at error so a misconfig (e.g. invalid_client) or an
  // unmapped code surfaces to an operator instead of hiding in the client's
  // soft-retry loop. Retry-After completes the 503's HTTP semantics.
  const reason = err instanceof Error ? err.message : String(err);
  const code = err instanceof RefreshTokenError ? err.code : undefined;
  log.error("[nimblebrain] Token refresh unavailable", { reason, code });
  return apiError(503, "refresh_unavailable", "Token refresh temporarily unavailable", undefined, {
    "Retry-After": "1",
  });
}

/**
 * Handle GET /v1/auth/callback — verify state against server-side store,
 * exchange code with PKCE verifier, and set session cookies.
 */
export async function handleOidcCallback(
  request: Request,
  provider: IdentityProvider,
  secureCookies: boolean,
  appOrigin?: string,
): Promise<Response> {
  if (!provider.capabilities.authCodeFlow || !provider.exchangeCode) {
    return apiError(400, "not_configured", "Auth code flow not configured");
  }

  const url = new URL(request.url);
  // Where the browser lands on any failure (or success): the caller-supplied app
  // origin, else the request origin.
  const fallbackRedirect = appOrigin ?? url.origin;

  const code = url.searchParams.get("code");
  if (!code) {
    return apiError(400, "bad_request", "Missing authorization code");
  }

  // Verify state — must match a pending flow in server memory
  const returnedState = url.searchParams.get("state");
  if (!returnedState) {
    log.error("[nimblebrain] OAuth callback missing state parameter");
    return Response.redirect(`${fallbackRedirect}?error=auth_failed`, 302);
  }

  cleanupPendingFlows();

  const pendingFlow = pendingAuthFlows.get(returnedState);
  if (!pendingFlow) {
    log.error("[nimblebrain] OAuth state mismatch — possible CSRF attack or expired flow");
    return Response.redirect(`${fallbackRedirect}?error=auth_failed`, 302);
  }

  // Consume the state — one-time use
  pendingAuthFlows.delete(returnedState);

  try {
    // Exchange code with the PKCE verifier — provider forwards it to the authorization server
    const result = await provider.exchangeCode(code, pendingFlow.codeVerifier);

    const mutableRes = new Response(null, {
      status: 302,
      headers: {
        Location: fallbackRedirect,
        "Set-Cookie": sessionCookie(result.accessToken, secureCookies),
      },
    });

    if (result.refreshToken) {
      mutableRes.headers.append("Set-Cookie", refreshCookie(result.refreshToken, secureCookies));
    }

    return mutableRes;
  } catch (err) {
    log.error("[nimblebrain] Auth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.redirect(`${fallbackRedirect}?error=auth_failed`, 302);
  }
}

/** Handle POST /v1/auth/refresh — refresh access token using refresh cookie. */
export async function handleOidcRefresh(
  request: Request,
  provider: IdentityProvider,
  secureCookies: boolean,
): Promise<Response> {
  if (!provider.capabilities.tokenRefresh || !provider.refreshToken) {
    return apiError(400, "not_configured", "OIDC auth not configured");
  }

  const refreshToken = readRefreshCookie(request);
  if (!refreshToken) {
    return apiError(401, "no_refresh_token", "No refresh token");
  }

  try {
    const result = await provider.refreshToken(refreshToken);

    const res = json({ ok: true });
    res.headers.set("Set-Cookie", sessionCookie(result.accessToken, secureCookies));

    if (result.refreshToken) {
      res.headers.append("Set-Cookie", refreshCookie(result.refreshToken, secureCookies));
    }

    return res;
  } catch (err) {
    return mapOidcRefreshError(err);
  }
}

// --- File Serve ---

/** Strip characters that could break or inject Content-Disposition headers. */
export function sanitizeFilename(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security sanitization
  return name.replace(/["\r\n\x00-\x1f]/g, "_");
}

/** Handle GET /v1/files/:fileId — serve a stored file by its globally-unique id.
 * Files are workspace-owned, but the id alone addresses them: the file locator
 * resolves the id to its workspace within the caller's OWN owner partitions
 * (`resolveRequestUserId`), and the store reads from `(wsId, ownerId)`. The owner
 * partition is both the gate and the search scope — there is no client-supplied
 * workspace to forge, and a request can only ever reach the caller's own bytes.
 * The route carries no workspace because a browser `<img>` GET can't send the
 * `X-Workspace-Id` header; the bare id is sufficient. */
export async function handleFileServe(
  fileId: string,
  runtime: Runtime,
  features: ResolvedFeatures,
  identity: UserIdentity | undefined,
): Promise<Response> {
  if (!features.fileContext) {
    return apiError(404, "not_found", "Not found");
  }

  if (!FILE_ID_RE.test(fileId)) {
    return apiError(400, "bad_request", "Invalid file ID format");
  }

  const ownerId = runtime.resolveRequestUserId(identity);
  const locator = runtime.getFileLocator();

  const readAt = async (wsId: string): Promise<Response | null> => {
    try {
      const file = await runtime.getWorkspaceFileStore(wsId, ownerId).readFile(fileId);
      const safeName = sanitizeFilename(file.filename);
      return new Response(new Uint8Array(file.data), {
        headers: {
          "Content-Type": file.mimeType,
          "Content-Disposition": `inline; filename="${safeName}"`,
        },
      });
    } catch {
      return null; // not at this location
    }
  };

  // Memo fast-path. A stale hit (file moved/removed out of this process under
  // `replicas > 1`) self-heals: drop it and fall through to the disk resolve.
  const cached = locator.peek(ownerId, fileId);
  if (cached) {
    const hit = await readAt(cached);
    if (hit) return hit;
    locator.forget(ownerId, fileId);
  }

  // Disk-authoritative: one owner-scoped walk, memoised. Absent ⇒ 404 (a pure
  // miss walks once and stops — no retry, since there's nothing to heal).
  const wsId = await locator.resolve(ownerId, fileId);
  if (!wsId) return apiError(404, "not_found", "File not found");
  return (await readAt(wsId)) ?? apiError(404, "not_found", "File not found");
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

  const check = validateAgainst(body, ChatRequestBody);
  if (!check.ok) {
    return apiError(400, "bad_request", check.reason ?? "Invalid chat request body");
  }
  const parsed = body as ChatRequestBody;

  // The validated `X-Workspace-Id` (focused workspace) threads into
  // `ChatRequest.workspaceId`: it drives BOTH the deterministic per-workspace
  // briefing (apps + overlays) AND the walled tool scope (that one workspace +
  // identity tools). See the `ChatRequest.workspaceId` doc comment.

  return {
    message: parsed.message,
    ...(parsed.conversationId !== undefined ? { conversationId: parsed.conversationId } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.appContext !== undefined ? { appContext: parsed.appContext } : {}),
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    ...(parsed.allowedTools !== undefined ? { allowedTools: parsed.allowedTools } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(identity ? { identity } : {}),
  };
}

/** Form-data as produced by `Request.formData()` (avoids naming the DOM-less `FormData` global). */
type MultipartForm = Awaited<ReturnType<Request["formData"]>>;

/**
 * Collect uploaded files from a chat multipart body. FormDataEntryValue is
 * `string | File` in Bun; without the DOM lib we duck-type the file parts.
 */
async function collectMultipartChatFiles(formData: MultipartForm): Promise<UploadedFile[]> {
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
      // Browsers leave the part's Content-Type empty for extensions they
      // don't recognise (.typ etc.); recover a text type from the filename
      // so the file isn't stored as opaque binary. See resolveMimeType.
      mimeType: resolveMimeType(entry.name, entry.type),
    });
  }
  return uploadedFiles;
}

/** Parse the optional `appContext` JSON field: value, undefined (absent), or an error Response. */
function parseMultipartAppContext(
  raw: unknown,
): { appName: string; serverName: string } | undefined | Response {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return apiError(400, "bad_request", "appContext must be a valid JSON string");
  }
}

/**
 * Reject a malformed multipart `conversationId` (400) before it reaches store
 * path-building / ingestFiles. The JSON surface gets this from the
 * ChatRequestBody schema pattern; multipart parses raw, so validate the same
 * canonical `conv_<16 hex>` shape here. Null when absent or valid.
 */
function invalidMultipartConversationId(conversationId: unknown): Response | null {
  if (
    typeof conversationId === "string" &&
    conversationId &&
    !CONVERSATION_ID_RE.test(conversationId)
  ) {
    return apiError(400, "bad_request", "Invalid conversationId format");
  }
  return null;
}

/**
 * Assemble the ChatRequest fields shared by the text-only and file-ingest
 * multipart paths. The focused workspace (`X-Workspace-Id`) threads into
 * `ChatRequest.workspaceId` for prompt scoping — see `parseChatBody`.
 */
function multipartChatRequestBase(
  message: string,
  conversationId: unknown,
  model: unknown,
  appContext: { appName: string; serverName: string } | undefined,
  workspaceId: string | undefined,
  identity: UserIdentity | undefined,
): ChatRequest {
  return {
    message,
    conversationId: typeof conversationId === "string" ? conversationId : undefined,
    model: typeof model === "string" ? model : undefined,
    appContext,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
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
  let formData: MultipartForm;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "bad_request", "Invalid multipart form data");
  }

  const messageRaw = formData.get("message");
  // Allow empty/missing message when files are attached (validated after file collection)
  const message = typeof messageRaw === "string" ? messageRaw : "";

  const conversationId = formData.get("conversationId");
  const badConversationId = invalidMultipartConversationId(conversationId);
  if (badConversationId) return badConversationId;
  const model = formData.get("model");

  const appContext = parseMultipartAppContext(formData.get("appContext"));
  if (appContext instanceof Response) return appContext;

  const uploadedFiles = await collectMultipartChatFiles(formData);

  // Require either a non-empty message or at least one uploaded file
  if (!message && uploadedFiles.length === 0) {
    return apiError(400, "bad_request", "message or file attachment is required");
  }

  // If no files, treat as a plain text request (no ingest needed).
  if (uploadedFiles.length === 0) {
    return multipartChatRequestBase(
      message,
      conversationId,
      model,
      appContext,
      workspaceId,
      identity,
    );
  }

  // Ingest files: validate, store, extract text, build content parts.
  //
  // Files are workspace-owned: ingest writes to the conversation's AUTHORITATIVE
  // workspace — the SAME partition `runtime.chat()` reads from when it
  // rehydrates. The workspace is resolved from the conversation (probe +
  // locator), not the request header: on a cross-workspace resume the two differ,
  // and a header-partitioned upload would land in a workspace the read never
  // looks in (the attachment vanishes). A new conversation (no id yet) is born in
  // the focused/personal workspace.
  const uploadOwner = runtime.resolveRequestUserId(identity);
  const fallbackWsId = workspaceId ?? personalWorkspaceIdFor(uploadOwner);
  // The real conversation id, or undefined when the chat doesn't exist yet
  // (`runtime.chat()` stamps the id later; `ingestFiles` gets a "pending"
  // placeholder for the FileEntry until then).
  const convId = (typeof conversationId === "string" && conversationId) || undefined;
  const wsId = await runtime.resolveConversationWorkspaceId(convId, fallbackWsId, uploadOwner);
  const store = runtime.getWorkspaceFileStore(wsId, uploadOwner);
  const filesConfig = runtime.getFilesConfig();
  const ingestResult = await ingestFiles(
    uploadedFiles,
    convId ?? "pending",
    store,
    filesConfig,
    wsId,
    uploadOwner,
  );

  if (ingestResult.errors.length > 0) {
    return apiError(400, "file_upload_error", "File upload failed", {
      errors: ingestResult.errors,
    });
  }
  return {
    ...multipartChatRequestBase(message, conversationId, model, appContext, workspaceId, identity),
    contentParts: ingestResult.contentParts,
    fileRefs: ingestResult.fileRefs,
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

/**
 * Collect uploaded files from a resource-upload multipart body. Files MUST be
 * sent under the `file` or `files` key; other non-string entries (e.g. a Blob
 * accidentally appended under `tags`) are ignored rather than silently treated
 * as uploads. Returns an error Response on a malformed part.
 */
async function collectResourceUploads(formData: MultipartForm): Promise<UploadedFile[] | Response> {
  const uploads: UploadedFile[] = [];
  try {
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") continue;
      if (key !== "file" && key !== "files") continue;
      const entry = value as unknown as {
        arrayBuffer(): Promise<ArrayBuffer>;
        name?: string;
        type?: string;
      };
      if (typeof entry.arrayBuffer !== "function") continue;
      uploads.push({
        data: Buffer.from(await entry.arrayBuffer()),
        filename: entry.name || "unnamed",
        // Recover a text type from the filename when the browser sent no
        // usable Content-Type (see resolveMimeType) — same recovery as the
        // chat-multipart path.
        mimeType: resolveMimeType(entry.name, entry.type),
      });
    }
  } catch {
    return apiError(400, "bad_request", "Malformed file entry in multipart body");
  }
  return uploads;
}

/** Parse the optional `tags` field as a JSON array of strings ([] when absent), or an error Response. */
function parseResourceUploadTags(raw: unknown): string[] | Response {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
      return apiError(400, "bad_request", "tags must be a JSON array of strings");
    }
    return parsed;
  } catch {
    return apiError(400, "bad_request", "tags must be a valid JSON array");
  }
}

/** A multipart text field as a non-empty string, or null. */
function optionalStringField(raw: unknown): string | null {
  return typeof raw === "string" && raw ? raw : null;
}

/** Validate size/MIME, store, and register each upload; returns the saved entries + per-file rejection reasons. */
async function persistResourceUploads(
  uploads: UploadedFile[],
  config: ReturnType<Runtime["getFilesConfig"]>,
  store: ReturnType<Runtime["getWorkspaceFileStore"]>,
  meta: {
    tags: string[];
    description: string | null;
    conversationId: string | null;
    uploadOwner: string;
    wsId: string;
  },
): Promise<{ entries: FileEntry[]; errors: string[] }> {
  const entries: FileEntry[] = [];
  const errors: string[] = [];
  for (const file of uploads) {
    if (file.data.length > config.maxFileSize) {
      errors.push(
        `File "${file.filename}" (${file.data.length} bytes) exceeds per-file limit of ${config.maxFileSize}`,
      );
      continue;
    }
    if (!isAllowedMime(file.mimeType)) {
      errors.push(`File "${file.filename}" has disallowed type: ${file.mimeType}`);
      continue;
    }
    const saved = await store.saveFile(file.data, file.filename, file.mimeType);
    const entry: FileEntry = {
      id: saved.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: saved.size,
      tags: meta.tags,
      source: "app",
      conversationId: meta.conversationId,
      createdAt: new Date().toISOString(),
      description: meta.description,
      // Stamp the resolved workspace/owner the bytes physically landed in (the
      // conversation's authoritative workspace) — advisory denormalisation that
      // lets the upload response report where the file lives.
      ownerId: meta.uploadOwner,
      workspaceId: meta.wsId,
    };
    await store.appendRegistry(entry);
    entries.push(entry);
  }
  return { entries, errors };
}

/**
 * Handle POST /v1/resources — multipart file upload to the workspace
 * file store. Stores each uploaded file, registers it, returns the
 * resulting FileEntry list. This is the byte-transport entry point used
 * by the bridge's `synapse/request-file` flow so the iframe never has
 * to base64-encode bytes into a tool-call argument.
 *
 * Workspace isolation comes from `workspaceId` (the validated `X-Workspace-Id`,
 * or the caller's personal workspace when unfocused) flowing into
 * `getWorkspaceFileStore` — bytes physically land under that workspace's own
 * `files/<ownerId>/` partition.
 */
export async function handleResourceUpload(
  request: Request,
  runtime: Runtime,
  features: ResolvedFeatures,
  identity: UserIdentity | undefined,
  workspaceId: string | undefined,
): Promise<Response> {
  if (!features.fileContext) {
    return apiError(404, "not_found", "Not found");
  }

  let formData: MultipartForm;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, "bad_request", "Invalid multipart form data");
  }

  const uploads = await collectResourceUploads(formData);
  if (uploads instanceof Response) return uploads;

  if (uploads.length === 0) {
    return apiError(400, "bad_request", "No files in request (use the 'file' or 'files' field)");
  }

  const config = runtime.getFilesConfig();
  if (uploads.length > config.maxFilesPerMessage) {
    return apiError(413, "payload_too_large", "Too many files", {
      count: uploads.length,
      limit: config.maxFilesPerMessage,
    });
  }
  const totalSize = uploads.reduce((s, f) => s + f.data.length, 0);
  if (totalSize > config.maxTotalSize) {
    return apiError(413, "payload_too_large", "Total upload size exceeds limit", {
      size: totalSize,
      limit: config.maxTotalSize,
    });
  }

  // Optional metadata applied to every uploaded file. The picker flow sends
  // none of these today; they exist so future callers (agent tools, drag-drop
  // with tag) don't need a follow-up tool call.
  const tags = parseResourceUploadTags(formData.get("tags"));
  if (tags instanceof Response) return tags;
  const description = optionalStringField(formData.get("description"));
  const conversationId = optionalStringField(formData.get("conversationId"));

  const uploadOwner = runtime.resolveRequestUserId(identity);
  const fallbackWsId = workspaceId ?? personalWorkspaceIdFor(uploadOwner);
  // A resource upload attached to a conversation lands in that conversation's
  // authoritative workspace (the partition the read uses); a standalone app
  // upload (no conversationId) lands in the focused/personal workspace.
  const wsId = await runtime.resolveConversationWorkspaceId(
    conversationId ?? undefined,
    fallbackWsId,
    uploadOwner,
  );
  const store = runtime.getWorkspaceFileStore(wsId, uploadOwner);

  const { entries, errors } = await persistResourceUploads(uploads, config, store, {
    tags,
    description,
    conversationId,
    uploadOwner,
    wsId,
  });

  if (entries.length === 0) {
    return apiError(400, "file_upload_error", "All uploads were rejected", { errors });
  }
  return json({ files: entries, ...(errors.length > 0 ? { errors } : {}) });
}
