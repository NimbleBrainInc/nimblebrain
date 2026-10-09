/**
 * MCP Server endpoint — exposes the platform as an MCP server via Streamable HTTP.
 *
 * `/mcp/<wsId>` speaks the 2026-07-28 revision, and nothing earlier. Each
 * request is served on its own by an SDK v2 server (`createMcpHandler`) under
 * the request's `_meta` envelope: there is no `initialize`, no session, and no
 * per-process state, so any process can answer any request. A request without
 * the envelope (2025-era traffic) gets the SDK's `-32022` naming the supported
 * version.
 *
 * External MCP clients (Claude Code, Claude, etc.) connect to `/mcp/<wsId>` and
 * reach that workspace's tools through the standard MCP protocol.
 *
 * **A request is bound to (identity, workspace).** The workspace is the one in
 * the URL, membership-validated by the route (`routes/mcp.ts`) on every
 * request before it reaches this host. `tools/list` returns that workspace's
 * tools + the caller's identity tools, all bare; `tools/call` is walled to it —
 * a `ws_<other>-…` name cannot address another workspace at all, because that
 * form is retired and refused as `invalid_tool_name`.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CallToolRequest,
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/server";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  createRequestStateCodec,
  isInputRequiredResult,
  isLegacyRequest,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import { isAppCallable, isModelVisible, type ToolResult } from "../engine/types.ts";
import type { TokenGrant, UserIdentity } from "../identity/provider.ts";
import { log } from "../observability/log.ts";
import {
  ConnectorGrantDenied,
  routeToolCall,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  WorkspaceAccessDenied,
} from "../orchestrator/index.ts";
import { assertToolAllowed } from "../permissions/assert-tool-allowed.ts";
import { wrapContained } from "../prompt/compose.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import type { Runtime } from "../runtime/runtime.ts";
import {
  parseSkillEntry,
  SKILLS_EXTENSION_ID,
  type SkillEntry,
} from "../skills/skills-extension.ts";
import { IDENTITY_SOURCES } from "../tools/identity-sources.ts";
import type { IdentityTaskSource } from "../tools/identity-task-source.ts";
import { McpSource } from "../tools/mcp-source.ts";
import { bareToolName } from "../tools/namespace.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { McpCaller, TaskOwnerContext, ToolSource } from "../tools/types.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import { toWireJson } from "../util/wire-json.ts";
import {
  answerModernTaskRequest,
  type ModernCreateTaskResult,
  type ModernTaskContext,
  modernCreateTaskResult,
  optsInToTasks,
  TASKS_EXTENSION_ID,
  type TaskAwareSource,
  type TaskScope,
} from "./mcp-modern-tasks.ts";

/**
 * JSON-RPC error code for a `resources/read` whose URI resolves nowhere:
 * `-32602` (Invalid Params), as the 2026-07-28 revision requires.
 */
const RESOURCE_NOT_FOUND_CODE = ProtocolErrorCode.InvalidParams;

/**
 * A JSON-RPC error a handler throws. The message carries the `MCP error <code>:`
 * prefix every `/mcp` error has always carried, so a client matching on the
 * text reads the same thing.
 */
function mcpError(code: number, message: string, data?: unknown): ProtocolError {
  return new ProtocolError(code, `MCP error ${code}: ${message}`, data);
}

const mcpPkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const mcpPkg = JSON.parse(readFileSync(mcpPkgPath, "utf-8")) as {
  version: string;
};
// Prefer the build-time-injected git tag; fall back to package.json for local dev.
const MCP_SERVER_VERSION = process.env.NB_VERSION || mcpPkg.version;

/** Cap on distinct User-Agents `logRefusedClient` remembers. */
const MAX_SEEN_REFUSED_CLIENTS = 256;

/**
 * The (identity, workspace, grant) a request addresses. `workspaceId` is the
 * membership-validated workspace from the URL.
 */
export interface McpRequestContext {
  identity: UserIdentity | null;
  workspaceId: string;
  /**
   * The kind of grant the caller's credential carries. Only a `first_party`
   * caller's `tools/call` can be an app's (`isAppCall`): a `resource` token was
   * minted for an external MCP client, whose calls are an agent's whatever
   * `_meta` they carry.
   */
  grant: TokenGrant["kind"];
}

/**
 * The `/mcp/<wsId>` door. It holds no per-request or per-client state: every
 * request is served by a server built for it, bound to the request's own
 * (identity, workspace, grant). Constructed in `startServer`, threaded through
 * `AppContext`, used by `routes/mcp.ts`.
 */
export class McpServerHost {
  /** User-Agents already logged by `logRefusedClient`. */
  private readonly seenRefusedClients = new Set<string>();
  private readonly runtime: Runtime | null;
  /**
   * Seals each `requestState` the door hands a client ({@link CallerRound}).
   * Per process: a restart ends the input rounds in flight, whose retries then
   * get `-32602` and start the call again.
   */
  private readonly roundKey = randomBytes(32);

  /**
   * `runtime` serves `tools/list` (the caller's identity tools, via
   * `listIdentitySourceTools`) and `tools/call` (via the orchestrator's
   * `routeToolCall`). Without one, `tools/list` returns an empty list and
   * `tools/call` rejects with `-32601 method not supported`.
   */
  constructor(runtime?: Runtime) {
    this.runtime = runtime ?? null;
  }

  /**
   * Serve one request. The SDK answers every method and shape: a POST under the
   * 2026-07-28 envelope is served, a request without it gets `-32022` naming the
   * supported version, and GET or DELETE (no session, no standalone stream)
   * gets `405`.
   *
   * `tasks/get` and `tasks/cancel` are answered ahead of the SDK, which routes
   * no task method (`mcp-modern-tasks.ts`), but only under the envelope: a
   * 2025-era task request gets the SDK's refusal like any other.
   */
  async handle(
    request: Request,
    features: ResolvedFeatures,
    requestCtx: McpRequestContext,
  ): Promise<Response> {
    if (request.method === "POST" && (await isLegacyRequest(request))) {
      this.logRefusedClient(request);
    } else {
      const taskReply = await answerModernTaskRequest(
        request,
        modernTaskContext(this.runtime, requestCtx),
        (meta) => taskScope(meta, requestCtx.workspaceId),
      );
      if (taskReply) return taskReply;
    }
    const handler = createMcpHandler(
      async () =>
        createServer(
          this.runtime,
          features,
          requestCtx,
          this.roundKey,
          await doorInstructions(this.runtime, requestCtx.workspaceId),
        ),
      {
        legacy: "reject",
        onerror: (err) => log.warn(`[mcp] request failed: ${err.message}`),
      },
    );
    return handler.fetch(request);
  }

  /**
   * Log each kind of client refused for speaking a revision before 2026-07-28,
   * once per User-Agent per process, so a client that needs upgrading shows in
   * the logs. Bounded: past the cap, new User-Agents go unlogged.
   */
  private logRefusedClient(request: Request): void {
    const userAgent = (request.headers.get("user-agent") ?? "none").slice(0, 200);
    if (
      this.seenRefusedClients.has(userAgent) ||
      this.seenRefusedClients.size >= MAX_SEEN_REFUSED_CLIENTS
    ) {
      return;
    }
    this.seenRefusedClients.add(userAgent);
    log.info(`[mcp] refused a pre-2026-07-28 client userAgent=${JSON.stringify(userAgent)}`);
  }
}

/**
 * The requests `/mcp` answers, bound to one (identity, workspace).
 *
 * The request is walled to its one workspace (`requestCtx.workspaceId`, from
 * the URL). `tools/list` serves that workspace's tools (bare) plus the caller's
 * identity tools (conversations / files / tasks). Every `tools/call`
 * routes through `routeToolCall`, and no name can address another workspace:
 * the `ws_<id>-` form is retired and refused as `invalid_tool_name`.
 *
 * A call runs as a task when the request opts in to the tasks extension
 * ({@link TaskAsk}), and the door holds no task table: a task it starts is
 * found again through the id it hands out (`mcp-modern-tasks.ts`).
 *
 * When `runtime` is null (unit tests), tool handlers degrade to safe no-ops:
 * `tools/list` returns empty and `tools/call` rejects with `-32601 Method not
 * found`.
 */
interface McpHandlers {
  listTools(): Promise<ListToolsResult>;
  callTool(request: CallToolRequest, ask: TaskAsk): Promise<ToolCallAnswer>;
  listResources(request: ListResourcesRequest): Promise<ListResourcesResult>;
  listResourceTemplates(
    request: ListResourceTemplatesRequest,
  ): Promise<ListResourceTemplatesResult>;
  readResource(request: ReadResourceRequest): Promise<ReadResourceResult>;
}

function createHandlers(
  runtime: Runtime | null,
  features: ResolvedFeatures,
  requestCtx: McpRequestContext,
): McpHandlers {
  const identityId = requestCtx.identity?.id ?? null;
  const wsId = requestCtx.workspaceId;

  const listTools = async (): Promise<ListToolsResult> => {
    if (!runtime || !identityId) {
      // Unauthenticated / no-runtime path: empty list, not an error — the SDK
      // requires a response.
      return { tools: [] };
    }
    // Walled to the request's workspace: that workspace's tools + the caller's
    // identity tools, all bare. A retired `ws_<id>-` name is refused at
    // `tools/call` as `invalid_tool_name`.
    const all = await runtime.listToolsForWorkspace(wsId, identityId);
    const orgRole = requestCtx.identity?.orgRole;
    return {
      tools: all
        // A tool without "model" in its `ui.visibility` is left out of an
        // agent's tool list (MCP Apps), this surface included (mirrors
        // `surfaceTools` on the chat path). An agent's `tools/call` that names
        // one is refused too (`assertAgentMayCall`); only an app's call reaches it.
        .filter(isModelVisible)
        // Feature gating + role visibility apply to the BARE tool name.
        .filter((t) => isToolEnabled(bareToolName(t.name), features))
        .filter((t) => isToolVisibleToRole(bareToolName(t.name), orgRole))
        // Both spec metadata namespaces go out under their own names: `_meta`
        // for host conventions, `annotations` for the spec's behavioural hints.
        // A client that reads `destructiveHint` before spending the call can
        // only do so if we forward what the upstream tool declared.
        .map((t) => ({
          name: t.name,
          description: t.description,
          // The SDK's own schema types, not a restated copy: the value was
          // validated at the source's listing, and a hand-written shape goes
          // stale the next time the spec tightens what a JSON Schema may hold.
          inputSchema: toWireJson(t.inputSchema) as Tool["inputSchema"],
          ...(t.outputSchema
            ? { outputSchema: toWireJson(t.outputSchema) as NonNullable<Tool["outputSchema"]> }
            : {}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
          ...(t.meta ? { _meta: t.meta } : {}),
        })),
    };
  };

  const callTool = async (request: CallToolRequest, ask: TaskAsk): Promise<ToolCallAnswer> => {
    const { name, arguments: args } = request.params;

    if (!runtime || !identityId) {
      throw mcpError(
        ProtocolErrorCode.MethodNotFound,
        "tools/call not available (runtime not wired)",
      );
    }

    // ── Stage 1: a call that names a source is held to that app's scope (MCP
    // Apps visibility). Naming a source only narrows reach, so it is checked
    // for any caller; whether the call is an app's is decided below.
    const appSource = scopedSourceName(request.params._meta);
    logToolCall(name, appSource, requestCtx, wsId, identityId);
    if (appSource !== undefined) {
      const refused = await assertAppMayCall(
        name,
        (args ?? {}) as Record<string, unknown>,
        appSource,
        runtime,
        wsId,
        identityId,
      );
      if (refused) return refused;
    }

    // ── Stage 2: parse the namespaced tool name + route via orchestrator
    //
    // Strict invariant — no fallback to a "current workspace." Names are bare,
    // and the SOURCE SEGMENT picks the door: a kernel identity source or the
    // `my_` marker goes through the identity door (below); anything else
    // dispatches into the request's own workspace, whose id comes from the
    // URL and never from the name. An identity-door name whose
    // source is not a kernel identity source surfaces as `-32602 Invalid
    // params` with `error.data.reason: "unknown_identity_source"`. Truly malformed names
    // (empty, empty tool, bad `ws_` id) surface as `invalid_tool_name`. Either
    // way the client gets a meaningful reason and the call never silently
    // routes. Each orchestrator error class maps to a distinct response shape
    // (the wall's denial, `WorkspaceToolUnavailable`, carries the
    // `workspace_access_denied` reason).
    let routed: Awaited<ReturnType<typeof routeToolCall>>;
    try {
      routed = await routeToolCall({
        identityId,
        namespacedName: name,
        workspaceId: wsId,
        runtime,
      });
    } catch (err) {
      mapRouteToolError(err);
    }

    // ── Stage 3: every call that is not an app's is an agent's, held to "model"
    if (!isAppCall(appSource, requestCtx)) {
      await assertAgentMayCall(routed.source, routed.toolName, name);
    }

    // Identity request (bare `<source>__<tool>`): dispatch against the caller's
    // identity, no workspace. See `executeIdentityToolCall` for the rationale.
    if (routed.kind === "identity") {
      return executeIdentityToolCall(
        routed,
        name,
        args,
        ask,
        features,
        requestCtx,
        runtime,
        isAppCall(appSource, requestCtx),
      );
    }
    return executeWorkspaceToolCall(
      routed,
      name,
      args,
      appSource,
      ask,
      runtime,
      features,
      requestCtx,
    );
  };

  // ── resources/list ────────────────────────────────────────────────
  //
  // Walled to the request's workspace, exactly like `tools/list`: only that
  // one workspace's sources are enumerated. NEVER a sweep across every
  // workspace the identity belongs to — that was the cross-workspace read hole
  // the wall exists to close. Per-source errors are swallowed so one bad source
  // doesn't kill the listing.
  //
  // One source, when `_meta` names it (`RESOURCE_SOURCE_META_KEY`): that is how
  // the iframe bridge asks for an app's own server, and the listing is that
  // server's, cursor and `nextCursor` passed straight through. Without it, the
  // workspace-wide listing an MCP client gets returns everything in a single
  // response (no `cursor` plumbing across sources).
  const listResources = async (request: ListResourcesRequest): Promise<ListResourcesResult> => {
    const scoped = scopedSourceName(request.params?._meta);
    if (scoped !== undefined) {
      const empty: ListResourcesResult = { resources: [] };
      return fromOneSource(runtime, requestCtx, scoped, empty, (client) =>
        // Page-level on purpose: the SDK's `listResources()` without a cursor
        // aggregates every page, and a scoped listing passes the source's own
        // pagination through.
        client.request({
          method: "resources/list",
          params: cursorParams(request.params?.cursor) ?? {},
        }),
      );
    }

    const resources: Resource[] = [];
    if (!runtime || !identityId) return { resources };

    let wsRegistry: ToolRegistry;
    try {
      wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
    } catch {
      return { resources };
    }
    for (const src of wsRegistry.getSources()) {
      await collectSourceResources(src, resources);
    }
    return { resources };
  };

  // ── resources/templates/list ──────────────────────────────────────
  //
  // The same wall, the same one-source scoping and the same single-response
  // workspace-wide listing as `resources/list`.
  const listResourceTemplates = async (
    request: ListResourceTemplatesRequest,
  ): Promise<ListResourceTemplatesResult> => {
    const empty: ListResourceTemplatesResult = { resourceTemplates: [] };
    const scoped = scopedSourceName(request.params?._meta);
    if (scoped !== undefined) {
      return fromOneSource(runtime, requestCtx, scoped, empty, (client) =>
        client.request({
          method: "resources/templates/list",
          params: cursorParams(request.params?.cursor) ?? {},
        }),
      );
    }

    if (!runtime || !identityId) return empty;
    let wsRegistry: ToolRegistry;
    try {
      wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
    } catch {
      return empty;
    }
    const resourceTemplates: ListResourceTemplatesResult["resourceTemplates"] = [];
    for (const src of wsRegistry.getSources()) {
      const client = mcpClientOf(src);
      if (!client) continue;
      try {
        resourceTemplates.push(...(await client.listResourceTemplates()).resourceTemplates);
      } catch {
        // Serves no templates, or a transport hiccup — one source never kills the listing.
      }
    }
    return { resourceTemplates };
  };

  // ── resources/read ────────────────────────────────────────────────
  //
  // One source, when `_meta` names it (`RESOURCE_SOURCE_META_KEY`): the source
  // a listing scoped by the same key reaches, and nothing else. That is how the
  // iframe bridge reads for an app — every iframe's requests reach `/mcp` as one
  // client, so the key is the only thing that says which app is reading.
  //
  // Without it, identity resources (files, conversations, tasks) resolve
  // first (below), then the request's one workspace — never a sweep across
  // every workspace the identity belongs to. We deliberately do not distinguish "doesn't exist" from "exists
  // but out of reach": per MCP spec guidance, avoid leaking existence.
  const readResource = async (request: ReadResourceRequest): Promise<ReadResourceResult> => {
    const uri = request.params.uri;
    if (!runtime || !identityId) {
      throw mcpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
    }

    const scoped = scopedSourceName(request.params._meta);
    if (scoped !== undefined) return readFromOneSource(runtime, requestCtx, scoped, uri);

    // Identity sources (files, conversations, tasks) are owned by the
    // user and live OUTSIDE every workspace registry, so the workspace sweep
    // below can't see them — `files://<id>` would never resolve. Try them
    // first, within the identity request context so the source reads the
    // caller's own data (the files source resolves its store via
    // `getCurrentIdentity()`, mirroring the identity-door tools/call path).
    const identityReqCtx: RequestContext = {
      identity: requestCtx.identity ?? null,
      // Workspace-owned identity data (`files://` etc.) resolves in the
      // session's workspace.
      workspaceId: wsId,
    };
    const identityResult = await readResourceFromIdentitySources(runtime, uri, identityReqCtx);
    if (identityResult) return identityResult;

    // Walled to the request's workspace. NEVER a sweep across every
    // workspace the identity belongs to.
    const wsResult = await readResourceFromWorkspace(runtime, uri, wsId);
    if (wsResult) return wsResult;

    // The URI resolved in neither the caller's identity sources nor the
    // focused workspace. Per MCP spec, raise a JSON-RPC error — the SDK
    // transport converts it into a proper `error` envelope.
    throw mcpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
  };

  return { listTools, callTool, listResources, listResourceTemplates, readResource };
}

const SkillsListParamsSchema = z.looseObject({ cursor: z.string().optional() }).optional();
const SkillsGetParamsSchema = z.looseObject({ uri: z.string() });
/** `skills/list` and `skills/get` are cacheable results: stale at once, never shared across callers. */
const SKILL_CACHE_HINTS = { ttlMs: 0, cacheScope: "private" } as const;

/** The workspace's MCP connectors, in name order. */
async function workspaceConnectors(runtime: Runtime, wsId: string): Promise<McpSource[]> {
  let registry: ToolRegistry;
  try {
    registry = await runtime.ensureWorkspaceRegistry(wsId);
  } catch {
    return [];
  }
  return registry
    .getSources()
    .filter((src): src is McpSource => src instanceof McpSource)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The instructions `/mcp/<wsId>` serves: the platform apps' own, then each of
 * the workspace's connectors', under its source name and contained. A client
 * reaches no connector directly, so this is the only place it learns how a
 * connector's tools are meant to be used, and its model sees them as
 * `<source>__<tool>`, not by the names the connector's text uses.
 */
async function doorInstructions(
  runtime: Runtime | null,
  wsId: string,
): Promise<string | undefined> {
  if (!runtime) return undefined;
  const parts: string[] = [];
  const platform = runtime.platformInstructions();
  if (platform) parts.push(platform);
  for (const source of await workspaceConnectors(runtime, wsId)) {
    const text = source.getInstructions()?.trim();
    if (!text) continue;
    parts.push(
      `## Connector \`${source.name}\`\n\nIts tools are named \`${source.name}__<tool>\` here.\n\n${wrapContained("connector-instructions", text)}`,
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The skills the workspace's connectors serve (SEP-2640), by `SKILL.md` URI. An
 * entry the extension does not allow is dropped. A URI two connectors serve is
 * left out: `resources/read` would answer it from whichever it reached first.
 */
async function workspaceSkills(
  runtime: Runtime | null,
  wsId: string,
): Promise<Map<string, SkillEntry>> {
  const skills = new Map<string, SkillEntry>();
  if (!runtime) return skills;
  const shared = new Set<string>();
  for (const source of await workspaceConnectors(runtime, wsId)) {
    if (source.skillsDiscovery() === "none") continue;
    for (const raw of (await source.listSkills()).entries) {
      const entry = parseSkillEntry(raw);
      if (!entry) continue;
      if (skills.has(entry.uri)) shared.add(entry.uri);
      else skills.set(entry.uri, entry);
    }
  }
  for (const uri of shared) {
    skills.delete(uri);
    log.warn(
      `[mcp] skill served by more than one connector, left out uri=${JSON.stringify(uri)} ws=${wsId}`,
    );
  }
  return skills;
}

/**
 * The SDK v2 `Server` built for one request by `createMcpHandler`, which
 * answers `server/discover` and serves the request under its `_meta` envelope.
 * Tasks are the tasks extension (SEP-2663), advertised in `server/discover`: a
 * `tools/call` whose client capabilities name it may be answered with a flat
 * task, and `McpServerHost.handle` answers the polls.
 */
function createServer(
  runtime: Runtime | null,
  features: ResolvedFeatures,
  requestCtx: McpRequestContext,
  roundKey: Uint8Array,
  instructions: string | undefined,
): Server {
  const rounds = createRequestStateCodec<CallerRound>({
    key: roundKey,
    bind: () => `${requestCtx.identity?.id ?? ""}\0${requestCtx.workspaceId}`,
  });
  const server = new Server(
    { name: "nimblebrain", version: MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        ...(runtime ? { extensions: { [TASKS_EXTENSION_ID]: {}, [SKILLS_EXTENSION_ID]: {} } } : {}),
      },
      ...(instructions ? { instructions } : {}),
      requestState: { verify: (state, ctx) => rounds.verify(state, ctx) },
    },
  );
  const handlers = createHandlers(runtime, features, requestCtx);
  server.setRequestHandler("tools/list", () => handlers.listTools());
  // SEP-2640: the workspace's connectors' skills, in one page, as cacheable
  // results. Each file reads through `resources/read`, which reaches the
  // connector that serves it.
  server.setRequestHandler("skills/list", { params: SkillsListParamsSchema }, async (params) => {
    if (params?.cursor !== undefined) {
      throw mcpError(ProtocolErrorCode.InvalidParams, `Unknown cursor: ${params.cursor}`);
    }
    const skills = await workspaceSkills(runtime, requestCtx.workspaceId);
    return { skills: [...skills.values()], ...SKILL_CACHE_HINTS };
  });
  server.setRequestHandler("skills/get", { params: SkillsGetParamsSchema }, async (params) => {
    const skill = (await workspaceSkills(runtime, requestCtx.workspaceId)).get(params.uri);
    if (!skill) throw mcpError(ProtocolErrorCode.InvalidParams, `Unknown skill URI: ${params.uri}`);
    return { skill, ...SKILL_CACHE_HINTS };
  });
  server.setRequestHandler("tools/call", async (request, ctx) => {
    // The SDK types the lifted envelope as `{}`; its keys are the reserved
    // `_meta` names, the client capabilities among them.
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? {}) as ClientCapabilities;
    // Verified and bound to this (identity, workspace) by `rounds` before the
    // handler runs; the tool it names is checked here.
    const round = ctx.mcpReq.requestState<CallerRound>();
    if (round && round.tool !== request.params.name) {
      throw mcpError(ProtocolErrorCode.InvalidParams, "requestState belongs to another tool call");
    }
    const progressToken = ctx.mcpReq._meta?.progressToken;
    const caller: McpCaller = {
      capabilities,
      ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}),
      ...(round?.state !== undefined ? { requestState: round.state } : {}),
      ...(progressToken !== undefined
        ? {
            onProgress: (progress) => {
              ctx.mcpReq
                .notify({
                  method: "notifications/progress",
                  params: { progressToken, ...progress },
                })
                .catch(() => {});
            },
          }
        : {}),
    };
    const result = await handlers.callTool(request, {
      optedIn: optsInToTasks(capabilities),
      caller,
    });
    if (isInputRequiredResult(result)) {
      // The connector's state goes back to the client sealed with the tool and
      // the caller, so it returns only on this caller's retry of this call.
      const { requestState: state, ...rest } = result;
      return {
        ...rest,
        requestState: await rounds.mint(
          { tool: request.params.name, ...(state !== undefined ? { state } : {}) },
          ctx,
        ),
        // The handler is typed to answer a `CallToolResult`; an `input_required`
        // answer is the other result 2026-07-28 allows, and the SDK sends it as given.
      } as unknown as CallToolResult;
    }
    // The SDK types a `tools/call` result as the tool's own; a SEP-2663 task
    // is the other result the extension allows, and the SDK sends it as given.
    return result as CallToolResult;
  });
  server.setRequestHandler("resources/list", (request) => handlers.listResources(request));
  server.setRequestHandler("resources/templates/list", (request) =>
    handlers.listResourceTemplates(request),
  );
  server.setRequestHandler("resources/read", (request) => handlers.readResource(request));
  return server;
}

// ── /mcp CallTool + resource dispatch helpers ──────────────────────────────

type IdentityRoute = Extract<Awaited<ReturnType<typeof routeToolCall>>, { kind: "identity" }>;
type WorkspaceRoute = Extract<Awaited<ReturnType<typeof routeToolCall>>, { kind: "workspace" }>;
type TaskAwareSourceHandle = NonNullable<ReturnType<ToolRegistry["findTaskAwareSource"]>>;

/**
 * What a `tools/call` asks of the task machinery: whether the request opts in
 * to the tasks extension, so the door tasks a call to a tool that can run as one.
 */
type TaskAsk = {
  optedIn: boolean;
  /** The client's side of the protocol, forwarded to a connector the call runs inline on. */
  caller?: McpCaller;
};

/**
 * The `requestState` the door hands a client with an `input_required` answer:
 * the tool it was minted for and the connector's own state, sealed and bound to
 * the caller's (identity, workspace) by the per-request codec in
 * `createServer`. Every connector shares one connection per workspace source,
 * so the connector cannot tell whose state it minted; the seal is what keeps
 * one caller's round from being replayed by another.
 */
interface CallerRound {
  tool: string;
  state?: string;
}

/**
 * A `tools/call` answer: the tool's result, the task it runs as, or the input
 * the connector needs from the client first.
 */
type ToolCallAnswer = CallToolResult | ModernCreateTaskResult | InputRequiredResult;

/** Whether the call runs as a task: the request opted in and the tool can run as one. */
function runsAsTask(
  ask: TaskAsk,
  taskSupport: "optional" | "required" | "forbidden" | undefined,
): boolean {
  return ask.optedIn && (taskSupport === "optional" || taskSupport === "required");
}

/**
 * Where a task request resolves: the request's (workspace, identity), and
 * the task-aware sources it can reach: a kernel identity source's task surface
 * (`tasks` runs) by that name, else a connector in that workspace. Null
 * without a runtime or an identity, which reach no task. Either kind checks the
 * task's (workspace, identity, source) owner against the request's.
 */
function modernTaskContext(
  runtime: Runtime | null,
  requestCtx: McpRequestContext,
): ModernTaskContext | null {
  const identityId = requestCtx.identity?.id;
  if (!runtime || !identityId) return null;
  const wsId = requestCtx.workspaceId;
  return {
    workspaceId: wsId,
    identityId,
    findSource: (name) =>
      runtime.getIdentityTaskSource(name) ??
      (runtime.getRegistryForWorkspace(wsId).findTaskAwareSource(name) as TaskAwareSource | null),
  };
}

/** A source's answer to a call: the `input_required` it carries, or its result. */
function toToolCallAnswer(result: ToolResult): CallToolResult | InputRequiredResult {
  if (result.inputRequired) return { resultType: "input_required", ...result.inputRequired };
  return toCallToolResult(result);
}

/** Shape an engine ToolResult into an MCP CallToolResult, preserving optional structuredContent. */
function toCallToolResult(result: ToolResult) {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    isError: result.isError,
  };
}

/**
 * Map an orchestrator routing error to its MCP JSON-RPC error, re-throwing
 * anything unrecognized. Each error class maps to a distinct response shape;
 * `error.data.reason` carries the precise classification. (The wall's denial,
 * `WorkspaceToolUnavailable`, arrives as `WorkspaceAccessDenied` and carries the
 * `workspace_access_denied` reason.)
 */
// Exported for `test/unit/orchestrator/route-error-mapping.test.ts`,
// which asserts both doors report the same `data.reason`. Testing the mapper
// directly is the only way to catch an error class that is thrown but unmapped —
// a route-layer assertion passes while the caller still receives nothing.
export function mapRouteToolError(err: unknown): never {
  if (err instanceof UnknownNamespacedToolName) {
    // Pass the error's own text through: for the retired `ws_<id>-` form it names
    // the bare tool to call instead, and a fixed string would leave an external
    // client with no way to recover.
    throw mcpError(ProtocolErrorCode.InvalidParams, err.message, {
      reason: "invalid_tool_name",
      input: err.input,
      parse: err.reason,
    });
  }
  if (err instanceof WorkspaceAccessDenied) {
    // No spec-blessed JSON-RPC code for "permission denied", but
    // `-32603 Internal error` is too broad — the call IS well-formed, it just
    // isn't allowed for this identity. The MCP draft's tasks spec sets the
    // precedent of using `-32602` for owner-mismatch task lookups; we mirror
    // that here so a misrouted call doesn't get classified as a server bug.
    throw mcpError(ProtocolErrorCode.InvalidParams, `Access denied to workspace "${err.wsId}"`, {
      reason: "workspace_access_denied",
      wsId: err.wsId,
    });
  }
  if (err instanceof UnknownToolSource) {
    throw mcpError(
      ProtocolErrorCode.MethodNotFound,
      `No tool source "${err.sourceName}" in workspace "${err.wsId}"`,
      {
        reason: "unknown_tool_source",
        wsId: err.wsId,
        sourceName: err.sourceName,
        toolName: err.toolName,
      },
    );
  }
  if (err instanceof UnknownIdentitySource) {
    throw mcpError(
      ProtocolErrorCode.InvalidParams,
      `No identity source "${err.sourceName}" for "${err.toolName}"`,
      { reason: "unknown_identity_source", toolName: err.toolName },
    );
  }
  if (err instanceof ConnectorGrantDenied) {
    throw mcpError(
      ProtocolErrorCode.InvalidParams,
      `Personal connector "${err.connector}" is not granted to this workspace`,
      { reason: "connector_grant_denied", connector: err.connector, wsId: err.workspaceId },
    );
  }
  throw err;
}

/**
 * Dispatch an identity-scoped `/mcp` tools/call (bare `<source>__<tool>`)
 * against the caller's identity, in the request's workspace. Entity reads are
 * gated by `canAccess` in the handler.
 *
 * A kernel identity source with a task surface (`tasks__run`) runs as a
 * task when the client opts in to the tasks extension:
 * the answer is a flat task whose id names the source beside the source's own
 * task id (the run id). Every other call runs inline.
 */
async function executeIdentityToolCall(
  routed: IdentityRoute,
  name: string,
  args: Record<string, unknown> | undefined,
  ask: TaskAsk,
  features: ResolvedFeatures,
  requestCtx: McpRequestContext,
  runtime: Runtime,
  /** Whether an app view in the first-party shell made the call (`isAppCall`). */
  appCall = false,
): Promise<ToolCallAnswer> {
  const fullName = routed.toolName;
  if (!isToolEnabled(fullName, features)) {
    return {
      content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
      isError: true,
    };
  }
  // Role-gate at DISPATCH, not just surfacing — the workspace branch and the
  // REST handler both do, and surfacing already hides role-gated identity
  // tools, so a crafted bare `tools/call` must not slip past. (No identity tool
  // is role-gated today; this closes the gap before files/tasks land an
  // admin-gated one.)
  if (!isToolVisibleToRole(fullName, requestCtx.identity?.orgRole)) {
    return {
      content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
      isError: true,
    };
  }
  const { sourcePrefix, bareToolName: bare } = splitInnerToolName(fullName);

  // Per-tool `disallow` gate for a personal connector reached via the identity
  // door — honor the OWNER'S policy (`policyOwner`, stamped at routing), the same
  // policy the workspace door consults at home, so a shared room is never more
  // capable than home. Kernel identity sources have no `policyOwner` and are
  // skipped.
  if (routed.policyOwner) {
    const denied = await assertToolAllowed(
      runtime.getPermissionStore(),
      routed.policyOwner,
      sourcePrefix,
      bare,
    );
    if (denied) return toCallToolResult(denied);
  }

  const identityCtx: RequestContext = {
    identity: requestCtx.identity ?? null,
    // Workspace-owned identity data resolves in the request's workspace,
    // consistent with the resources wall.
    workspaceId: requestCtx.workspaceId,
    ...(appCall ? { shellCall: true } : {}),
  };

  if (!routed.policyOwner) {
    const tasked = await answerIdentityTask(
      runtime.getIdentityTaskSource(sourcePrefix),
      { name, bare, args, ask },
      identityCtx,
      requestCtx,
    );
    if (tasked) return tasked;
  }

  const idResult = await runWithRequestContext(identityCtx, () =>
    routed.source.execute(bare, (args ?? {}) as Record<string, unknown>, undefined, {
      ...(ask.caller ? { caller: ask.caller } : {}),
    }),
  );
  return toToolCallAnswer(idResult);
}

/**
 * Run an identity tool call as a task, or null to run it
 * inline: the source has no task surface, the tool cannot run as a task, or the
 * client did not opt in to the tasks extension. A `required` tool the client
 * did not opt in for is refused naming the extension, as on the workspace door.
 * A call the source refuses before any run exists is answered inline with its
 * error.
 */
async function answerIdentityTask(
  taskSource: IdentityTaskSource | null,
  call: {
    name: string;
    bare: string;
    args: Record<string, unknown> | undefined;
    ask: TaskAsk;
  },
  identityCtx: RequestContext,
  requestCtx: McpRequestContext,
): Promise<ToolCallAnswer | null> {
  if (!taskSource) return null;
  const taskSupport = taskSource.taskSupport(call.bare);
  if (taskSupport === "required" && !call.ask.optedIn) {
    throw new MissingRequiredClientCapabilityError(
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
      `Tool ${call.name} runs only as a task; declare the ${TASKS_EXTENSION_ID} extension to call it`,
    );
  }
  if (!runsAsTask(call.ask, taskSupport)) return null;
  const started = await runWithRequestContext(identityCtx, () =>
    taskSource.startToolAsTask(call.bare, call.args ?? {}, {
      ownerContext: ownerContextFor(identityCtx.workspaceId ?? "", requestCtx, taskSource.name),
    }),
  );
  if ("result" in started) {
    const { content, structuredContent, isError } = started.result;
    return {
      content,
      ...(structuredContent ? { structuredContent } : {}),
      isError: isError ?? false,
    };
  }
  return modernCreateTaskResult(taskSource.name, started.task);
}

/**
 * Dispatch a workspace-scoped `/mcp` tools/call (bare `<source>__<tool>`):
 * feature + role gating, connector permission gate, tool-level task
 * negotiation, then the task-augmented or inline execution path. The workspace
 * is the request's own (carried on `routed.context`), never from the tool name.
 */
async function executeWorkspaceToolCall(
  routed: WorkspaceRoute,
  name: string,
  args: Record<string, unknown> | undefined,
  /** The calling view's server when an app made the call, else undefined. */
  appSource: string | undefined,
  ask: TaskAsk,
  runtime: Runtime,
  features: ResolvedFeatures,
  requestCtx: McpRequestContext,
): Promise<ToolCallAnswer> {
  const { context: workspaceContext, toolName: innerToolName, source } = routed;

  // Feature gating + role visibility on the BARE tool name (post-parse).
  if (!isToolEnabled(innerToolName, features)) {
    return {
      content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
      isError: true,
    };
  }
  if (!isToolVisibleToRole(innerToolName, requestCtx.identity?.orgRole)) {
    return {
      content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
      isError: true,
    };
  }

  // Decompose `<source>__<tool>` through the one grammar every door shares.
  //
  // A name with no separator names no source. It cannot arrive here — the
  // orchestrator refuses one with `UnknownToolSource` before this function is
  // reached — so `null` is the honest value for "no source to gate or negotiate
  // tasks against" rather than a case with behavior to describe.
  const { sourcePrefix, bareToolName: localName, hasSeparator } = splitInnerToolName(innerToolName);
  const sourceName = hasSeparator ? sourcePrefix : null;
  const wsId = workspaceContext.workspaceId;

  // Connector permission gate. Runs BEFORE the task-vs-inline negotiation below
  // so an operator's `disallow` is honored whether or not the tool is
  // task-augmented — a disallowed task tool must be denied just like an inline
  // one. Mirrors the engine door (`IdentityToolRouter`) and the REST registry
  // gate, so all three doors enforce the same workspace policy.
  if (sourceName) {
    const denied = await connectorGateDenial(
      runtime,
      wsId,
      requestCtx,
      sourceName,
      localName,
      args,
      appSource,
    );
    if (denied) return toCallToolResult(denied);
  }

  const wsRegistry = runtime.getRegistryForWorkspace(wsId);
  const taskAwareSource = sourceName ? wsRegistry.findTaskAwareSource(sourceName) : null;
  const taskSupport = await resolveTaskSupport(taskAwareSource, innerToolName);
  const asTask = runsAsTask(ask, taskSupport);

  if (taskSupport === "required" && !asTask) {
    // The answer for a call that needs a capability the request did not
    // declare, naming it so the client can opt in and retry.
    throw new MissingRequiredClientCapabilityError(
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
      `Tool ${name} runs only as a task; declare the ${TASKS_EXTENSION_ID} extension to call it`,
    );
  }

  // Build per-request context for AsyncLocalStorage (concurrency-safe). The
  // workspace ID is derived from the parsed namespace — NOT from any
  // per-connection state. This is the per-call routing the orchestrator exists
  // to enforce.
  const reqCtx: RequestContext = {
    identity: requestCtx.identity ?? null,
    workspaceId: wsId,
  };

  if (asTask && sourceName && taskAwareSource) {
    const created = await runWithRequestContext(reqCtx, () =>
      taskAwareSource.startToolAsTask(localName, (args ?? {}) as Record<string, unknown>, {
        ownerContext: ownerContextFor(wsId, requestCtx, sourceName),
      }),
    );
    return modernCreateTaskResult(sourceName, created.task);
  }

  // ── Inline path ────────────────────────────────────────────────────────────
  //
  // Dispatch via the resolved source directly (the orchestrator already looked
  // it up and returned it). `ToolSource.execute` takes the bare (post-`__`)
  // tool name, mirroring `ToolRegistry.execute`'s contract. Preserve
  // `structuredContent` — dropping it silently violated `CallToolResult must be
  // returned as-is`. `_meta` propagation is a no-op today because the engine's
  // ToolResult shape doesn't carry `_meta`.
  const result = await runWithRequestContext(reqCtx, () =>
    source.execute(localName, (args ?? {}) as Record<string, unknown>, undefined, {
      ...(ask.caller ? { caller: ask.caller } : {}),
    }),
  );
  return toToolCallAnswer(result);
}

/**
 * The connector gates a workspace tool call passes before it runs: the
 * operator's permission policy, then the connector gate (`lifecycle` handlers,
 * `admin_tools`) against the workspace this URL is bound to and the request's
 * identity.
 */
async function connectorGateDenial(
  runtime: Runtime,
  wsId: string,
  requestCtx: McpRequestContext,
  sourceName: string,
  localName: string,
  args: Record<string, unknown> | undefined,
  appSource: string | undefined,
): Promise<ToolResult | null> {
  const denied = await assertToolAllowed(
    runtime.getPermissionStore(),
    { scope: "workspace", wsId },
    sourceName,
    localName,
  );
  if (denied) return denied;
  const call = {
    input: (args ?? {}) as Record<string, unknown>,
    caller: appSource ? "app" : "mcp",
  } as const;
  return runtime.connectorAdminDenial(wsId, requestCtx.identity, sourceName, localName, call);
}

/**
 * Read a task-aware source's `taskSupport` for one tool. Inspects the cached
 * tool definition (MCP-backed sources only); returns undefined when the source
 * is non-task-aware (never supports tasks) or the tool is unknown.
 */
async function resolveTaskSupport(
  taskAwareSource: TaskAwareSourceHandle | null,
  innerToolName: string,
): Promise<"optional" | "required" | "forbidden" | undefined> {
  if (!taskAwareSource) return undefined;
  const tools = await taskAwareSource.tools();
  const tool = tools.find((t) => t.name === innerToolName);
  return tool?.execution?.taskSupport;
}

/**
 * The owner stamped on a task `/mcp` starts: the workspace, the identity, and
 * the source it runs on (`originApp`), so a task request scoped to any other
 * source cannot reach it.
 */
function ownerContextFor(
  wsId: string,
  requestCtx: McpRequestContext,
  sourceName: string,
): TaskOwnerContext {
  return {
    workspaceId: wsId,
    ...(requestCtx.identity?.id ? { identityId: requestCtx.identity.id } : {}),
    originApp: sourceName,
  };
}

/**
 * The `_meta` key naming the one source a request is for. A `resources/read`,
 * `resources/list` or `resources/templates/list` resolves in that source, a
 * `tasks/get` or `tasks/cancel` is answered only for a task it ran, and a
 * `tools/call` is an app's call, held to the MCP Apps app scope
 * (`assertAppMayCall`). The iframe bridge sets it to the app's own server
 * (`web/src/bridge/bridge.ts`, pinned equal by
 * `test/unit/tools/server-notifications.test.ts`); an MCP client that omits it
 * gets the workspace-wide read or listing, and any task it started.
 */
export const RESOURCE_SOURCE_META_KEY = "ai.nimblebrain/source";

/**
 * Hold an app's `tools/call` to the scope the MCP Apps spec gives a view: a tool
 * of its own server, and only one whose `ui.visibility` includes `"app"`.
 *
 * The bridge names the calling view's server under
 * {@link RESOURCE_SOURCE_META_KEY}. The key narrows what any caller can reach,
 * so it is checked whoever sends it; it widens reach to app-only tools only for
 * a first-party caller (`isAppCall`), and every other call is also held to
 * `assertAgentMayCall`. A name that
 * matches no listed tool is refused too: its visibility cannot be read, and
 * routing would still reach a source whose listing failed (it reconnects on
 * demand), so letting it through would skip the check rather than the call.
 *
 * Returns the connector gate's refusal when a tool is unlisted because the
 * caller is not admitted to it (a `lifecycle` handler, or `admin_tools`), so an
 * app's call is refused with the same `host_only_tool` or
 * `workspace_admin_required` every other door returns.
 */
async function assertAppMayCall(
  name: string,
  args: Record<string, unknown>,
  appSource: string,
  runtime: Runtime,
  wsId: string,
  identityId: string,
): Promise<CallToolResult | undefined> {
  if (!name.startsWith(`${appSource}__`)) {
    throw mcpError(
      ProtocolErrorCode.InvalidParams,
      `Tool calls from the "${appSource}" app are scoped to that server; "${name}" names another.`,
      { reason: "outside_app_scope", source: appSource, toolName: name },
    );
  }
  const tools = await runtime.listToolsForWorkspace(wsId, identityId);
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const denied = await runtime.connectorAdminDenial(
      wsId,
      { id: identityId },
      appSource,
      name.slice(appSource.length + 2),
      { input: args, caller: "app" },
    );
    if (denied) return toCallToolResult(denied);
  }
  if (!tool || !isAppCallable(tool)) {
    throw mcpError(
      ProtocolErrorCode.InvalidParams,
      tool
        ? `Tool "${name}" is not callable from an app: its visibility does not include "app".`
        : `Tool "${name}" is not callable from an app: it is not listed, so its visibility is unknown.`,
      { reason: "not_app_callable", toolName: name },
    );
  }
}

/**
 * Whether a `tools/call` is an app's: it names a source (the iframe bridge
 * names the calling view's server on every call) and the caller's credential
 * is first-party.
 *
 * The grant is what the host can verify. A `resource` token was minted by the
 * authorization server for an external MCP client, and the client it was
 * issued to is signed into it (ADR-0038), so such a caller is never a view,
 * whatever `_meta` it sends. A first-party credential is the operator's own
 * client: the web shell, whose bridge makes every view's call, or an operator
 * app. The source key cannot tell those apart, so under a first-party
 * credential it is trusted as the caller states it. That is the limit of this
 * check: a provider that marks every credential first-party (`oidc`, `dev`)
 * leaves an external client able to name a source and be taken for a view.
 */
function isAppCall(appSource: string | undefined, requestCtx: McpRequestContext): boolean {
  return appSource !== undefined && requestCtx.grant === "first_party";
}

/**
 * Hold an agent's `tools/call` to the tools an agent may call: those whose
 * `ui.visibility` includes `"model"` (MCP Apps). The engine refuses the same
 * tools at the chat door; this is the `/mcp` door's half.
 *
 * Visibility is read from the routed source's own listing, not the workspace
 * listing, so a connector's role gate still answers with its own refusal. A
 * tool the listing does not name is refused, as `assertAppMayCall` does: its
 * visibility cannot be read. So is a call while the source cannot list its
 * tools (it is not connected), with a message that says to retry.
 */
async function assertAgentMayCall(
  source: ToolSource,
  innerToolName: string,
  name: string,
): Promise<void> {
  let tools: Awaited<ReturnType<ToolSource["tools"]>>;
  try {
    tools = await source.tools();
  } catch {
    throw mcpError(
      ProtocolErrorCode.InternalError,
      `Tool "${name}" is unavailable: its server is not connected, so its visibility cannot be read. Retry shortly.`,
      { reason: "source_unavailable", toolName: name },
    );
  }
  const tool = tools.find((t) => t.name === innerToolName);
  if (!tool || !isModelVisible(tool)) {
    throw mcpError(
      ProtocolErrorCode.InvalidParams,
      tool
        ? `Tool "${name}" is not callable by an agent: its visibility does not include "model". Only its app's view calls it.`
        : `Tool "${name}" is not callable by an agent: it is not listed, so its visibility is unknown.`,
      { reason: "not_agent_callable", toolName: name },
    );
  }
}

/** The source a resource or task request is scoped to, or undefined for none. */
function scopedSourceName(meta: Record<string, unknown> | undefined): string | undefined {
  const name = meta?.[RESOURCE_SOURCE_META_KEY];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * The scope of a task request: the source it names, in the request's
 * workspace. A source name names a server only within one workspace.
 * Undefined when the request names no source.
 */
function taskScope(meta: Record<string, unknown> | undefined, wsId: string): TaskScope | undefined {
  const source = scopedSourceName(meta);
  return source === undefined ? undefined : { source, workspaceId: wsId };
}

/** A listing's params: the cursor when the caller sent one, and nothing else. */
function cursorParams(cursor: unknown): { cursor: string } | undefined {
  return typeof cursor === "string" ? { cursor } : undefined;
}

/**
 * Run one resource request — a read or a listing — against the one source a
 * scoped request names: a kernel identity source by that name (under the
 * caller's identity context), otherwise that name in the request's workspace.
 * Reads and listings share this resolver so the source a listing shows is
 * exactly the source a read reaches. Returns the source's result as it
 * answered, pagination included.
 *
 * `absent` when there is no such source, it is not MCP-backed, or the request
 * fails (a server that serves no resources answers `Method not found`). A
 * missing source and a failing one answer the same: the caller learns nothing
 * about what exists outside its reach.
 */
async function fromOneSource<T>(
  runtime: Runtime | null | undefined,
  requestCtx: McpRequestContext,
  sourceName: string,
  absent: T,
  run: (client: NonNullable<ReturnType<McpSource["getClient"]>>) => Promise<T>,
): Promise<T> {
  if (!runtime || !requestCtx.identity?.id) return absent;
  const wsId = requestCtx.workspaceId;

  if (IDENTITY_SOURCES.has(sourceName)) {
    const client = mcpClientOf(runtime.getIdentitySource(sourceName));
    if (!client) return absent;
    const identityReqCtx: RequestContext = { identity: requestCtx.identity, workspaceId: wsId };
    try {
      return await runWithRequestContext(identityReqCtx, () => run(client));
    } catch {
      return absent;
    }
  }

  let wsRegistry: ToolRegistry;
  try {
    wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
  } catch {
    return absent;
  }
  const client = mcpClientOf(wsRegistry.getSources().find((src) => src.name === sourceName));
  if (!client) return absent;
  try {
    return await run(client);
  } catch {
    return absent;
  }
}

/**
 * A scoped `resources/read`: `uri` from the one source `fromOneSource` resolves
 * for `sourceName`, and nowhere else. A missing source and a resource that
 * source cannot resolve both answer `RESOURCE_NOT_FOUND_CODE`, so a probe
 * learns nothing about what exists.
 */
async function readFromOneSource(
  runtime: Runtime,
  requestCtx: McpRequestContext,
  sourceName: string,
  uri: string,
): Promise<ReadResourceResult> {
  const result = await fromOneSource<ReadResourceResult | null>(
    runtime,
    requestCtx,
    sourceName,
    null,
    (client) => client.readResource({ uri }),
  );
  if (result?.contents && result.contents.length > 0) return result;
  throw mcpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
}

/**
 * The live MCP client behind a source, or null. The same test
 * `collectSourceResources` and `tryReadResource` apply, so a source is listable
 * here exactly when its resources are readable.
 */
function mcpClientOf(src: unknown): ReturnType<McpSource["getClient"]> | null {
  if (!(src instanceof McpSource)) return null;
  return src.getClient() ?? null;
}

/**
 * Append one MCP source's resources to `out`. Non-MCP and clientless sources are
 * skipped; per-source errors are swallowed so one bad source doesn't kill the
 * listing.
 */
async function collectSourceResources(src: unknown, out: Resource[]): Promise<void> {
  if (!(src instanceof McpSource)) return;
  const client = src.getClient();
  if (!client) return;
  try {
    const result = await client.listResources();
    for (const r of result.resources) {
      out.push(r as Resource);
    }
  } catch {
    // Source didn't implement resources/list, or transport hiccup — swallow so
    // one bad source doesn't kill the listing.
  }
}

/**
 * Read `uri` from one source if it's an MCP source with a live client, running
 * the read through `run` (identity context for identity sources, pass-through
 * for workspace sources). Returns the result only when it carries contents;
 * null otherwise, including on error.
 */
async function tryReadResource(
  src: unknown,
  uri: string,
  run: (read: () => Promise<ReadResourceResult>) => Promise<ReadResourceResult>,
): Promise<ReadResourceResult | null> {
  if (!(src instanceof McpSource)) return null;
  const client = src.getClient();
  if (!client) return null;
  try {
    const result = await run(() => client.readResource({ uri }));
    if (result.contents && result.contents.length > 0) return result;
  } catch {
    // Not this source, or not found here — the caller tries the next source and
    // ultimately the workspace sweep.
  }
  return null;
}

/**
 * Try the caller's kernel identity sources (files, conversations, tasks)
 * for `uri`, each within the identity request context. Returns the first result
 * that carries contents, or null.
 */
async function readResourceFromIdentitySources(
  runtime: Runtime,
  uri: string,
  identityReqCtx: RequestContext,
): Promise<ReadResourceResult | null> {
  for (const sourceName of IDENTITY_SOURCES) {
    const src = runtime.getIdentitySource(sourceName);
    const result = await tryReadResource(src, uri, (read) =>
      runWithRequestContext(identityReqCtx, read),
    );
    if (result) return result;
  }
  return null;
}

/**
 * Sweep the request's workspace's MCP sources for `uri` — never a sweep across
 * every workspace the identity belongs to. Returns the first result that carries contents, or null.
 */
async function readResourceFromWorkspace(
  runtime: Runtime,
  uri: string,
  wsId: string,
): Promise<ReadResourceResult | null> {
  let wsRegistry: ToolRegistry | undefined;
  try {
    wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
  } catch {
    wsRegistry = undefined;
  }
  for (const src of wsRegistry?.getSources() ?? []) {
    const result = await tryReadResource(src, uri, (read) => read());
    if (result) return result;
  }
  return null;
}

/** Cap on a client-supplied string written to a log line. */
const MAX_LOGGED_FIELD_CHARS = 200;

/**
 * A client-supplied value as a log field: length-capped and JSON-quoted, so a
 * newline, a quote, or a `key=value` inside it cannot forge another field or line.
 */
function fmtClientField(value: string): string {
  return JSON.stringify(value.slice(0, MAX_LOGGED_FIELD_CHARS));
}

/**
 * One line per `/mcp` `tools/call`, refused or not, so "does any client call
 * X" has an answer in the logs: the tool's name and who asked, never
 * arguments or results. The name and the app source are the client's strings,
 * so each is quoted and capped like any other client-supplied field.
 */
function logToolCall(
  name: string,
  appSource: string | undefined,
  requestCtx: McpRequestContext,
  wsId: string,
  identityId: string,
): void {
  const caller = isAppCall(appSource, requestCtx)
    ? `app:${fmtClientField(appSource ?? "")}`
    : "agent";
  log.info(
    `[mcp] tools/call tool=${fmtClientField(name)} caller=${caller} grant=${requestCtx.grant} ws=${wsId} identity=${identityId}`,
  );
}
