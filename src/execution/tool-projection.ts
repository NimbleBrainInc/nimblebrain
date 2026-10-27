/**
 * The tool projection: a run's walled tool router, served as an MCP endpoint
 * that lives exactly as long as the run.
 *
 * A runtime outside the engine loop reaches NimbleBrain's tools through this
 * and nothing else. Every call dispatches through the router the door built
 * for the run, so the workspace wall, `allowedTools`, the unattended policy and
 * connector permissions hold for an external agent exactly as for the native
 * engine. `/mcp/<wsId>` is not used: it serves a person's attended surface, not
 * a run's bound (ADR-0056).
 *
 * The projection is also where the run's tool record comes from. It emits
 * `tool.start` / `tool.done` itself, from the call it dispatched and the result
 * the tool returned, so the conversation log holds what ran, not an agent's
 * description of it.
 *
 * Skills bound to tools are delivered here as the engine delivers them, by the
 * same module (`src/engine/skill-delivery.ts`): the first call to a bound tool
 * is held until its guidance has been read, and a call that runs first gets the
 * guidance after it. An external agent's history is its own, so the guidance
 * travels in the call's result. The record is the engine's: the held result in
 * `tool.done`, and each body in `connector.skill.injected`, from which a later
 * turn on any runtime replays it in the native engine's position.
 *
 * It is served one of two ways, and dies with the run either way. Over the
 * agent's own ACP connection ({@link ToolProjection.channel}), when the agent
 * takes MCP servers on ACP's `acp` transport: nothing listens, and only the
 * connection the runtime dialed reaches the tools (ADR-0057). Or on loopback
 * ({@link ToolProjection.listen}), on a random port, at a random path, behind a
 * random bearer token, for an agent that takes only HTTP MCP servers.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { createMcpHandler, InMemoryTransport, Server } from "@modelcontextprotocol/server";
import {
  boundToolResultForModel,
  extractResourceLinks,
  extractTextForModel,
  textContent,
} from "../engine/content-helpers.ts";
import { createSkillDelivery, type SkillDelivery } from "../engine/skill-delivery.ts";
import {
  buildToolDoneData,
  coerceAndValidateToolInput,
  enforceMaxToolResultSize,
} from "../engine/tool-call.ts";
import {
  type ConnectorSkillCandidate,
  type EngineHooks,
  type EventSink,
  isModelVisible,
  SKILL_ACTIVATED_META_KEY,
  SKILL_SUPPRESSION_META_KEY,
  type ToolCall,
  type ToolCallRecord,
  type ToolResult,
  type ToolRouter,
  type ToolSchema,
} from "../engine/types.ts";
import { log } from "../observability/log.ts";
import { formatConnectorSkillBlock } from "../prompt/containment.ts";

/**
 * Tools an external loop cannot use, because they act on the native engine's
 * own state: promotion edits the engine's active tool set, which an agent
 * reached over a protocol does not have.
 */
const ENGINE_STATE_TOOLS = new Set(["nb__manage_tools"]);

/** Told of every call, in order, so a runtime can place it in the run's record. */
export interface ToolProjectionObserver {
  /** Before `tool.start`: the call has passed its checks and is about to run. */
  callStarting(call: ToolCall): void;
}

export interface ToolProjectionOptions {
  runId: string;
  router: ToolRouter;
  events: EventSink;
  signal?: AbortSignal;
  maxToolResultSize?: number;
  /**
   * The run's call-level hooks (`beforeToolCall`, `afterToolCall`): the
   * privilege gate among them. Applied to every call as the engine applies
   * them, so a gate the door installed holds for an external agent too.
   */
  hooks?: Pick<EngineHooks, "beforeToolCall" | "afterToolCall">;
  /**
   * The run's tool-bound skills (`EngineConfig.connectorSkillCandidates`) and
   * those the conversation already delivered
   * (`EngineConfig.alreadyInjectedConnectorSkills`).
   */
  skills?: { candidates: ConnectorSkillCandidate[]; delivered: string[] };
  observer?: ToolProjectionObserver;
}

/** A live projection: how an agent reaches it, and how it ends. */
export interface ToolProjection {
  /**
   * Serve the projection over MCP messages the caller carries: one MCP session
   * for the run, whatever transport brings its messages.
   */
  channel(): McpChannel;
  /**
   * Serve the projection on loopback, for an agent that takes only HTTP MCP
   * servers. Started on the first call; the same endpoint after that.
   */
  listen(): { url: string; headers: { name: string; value: string }[] };
  /** Every call the projection dispatched, in the order they started. */
  calls(): ToolCallRecord[];
  close(): Promise<void>;
}

/** An inner MCP error, as JSON-RPC carries it. */
export interface McpErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** One MCP session with the projection, fed message by message. */
export interface McpChannel {
  /** Send one MCP request; resolves with its result or error. Aborting cancels it. */
  request(
    id: string,
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<{ result: unknown } | { error: McpErrorObject }>;
  /** Send one MCP notification. */
  notify(method: string, params: Record<string, unknown> | undefined): void;
}

/** JSON-RPC's "request cancelled" code, as MCP uses it. */
const REQUEST_CANCELLED = -32800;

/**
 * Open a projection for one run. Call it from inside the run's request
 * context: the projection carries that context to every tool call, which
 * reads the run's identity from it.
 */
export async function openToolProjection(opts: ToolProjectionOptions): Promise<ToolProjection> {
  const runInRunContext = AsyncLocalStorage.snapshot();
  const records: ToolCallRecord[] = [];
  const skills = createSkillDelivery({
    runId: opts.runId,
    candidates: opts.skills?.candidates ?? [],
    delivered: opts.skills?.delivered ?? [],
    events: opts.events,
  });
  const tools = await projectedTools(opts.router);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const callTool = (name: string, input: Record<string, unknown>): Promise<CallToolResult> =>
    runInRunContext(() => dispatch(opts, toolsByName, records, skills, name, input));

  let http: {
    url: string;
    headers: { name: string; value: string }[];
    stop(): Promise<void>;
  } | null = null;
  let mcp: (McpChannel & { close(): Promise<void> }) | null = null;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([http?.stop(), mcp?.close()]);
  };
  opts.signal?.addEventListener("abort", () => void close(), { once: true });

  return {
    channel() {
      if (closed) throw new Error("tool projection is closed");
      mcp ??= openChannel(() => createServer(tools, callTool));
      return mcp;
    },
    listen() {
      if (closed) throw new Error("tool projection is closed");
      http ??= listenOnLoopback(() => createServer(tools, callTool));
      return { url: http.url, headers: http.headers };
    },
    calls: () => [...records],
    close,
  };
}

/** The projection behind a random path and bearer on loopback. */
function listenOnLoopback(server: () => Server) {
  const token = randomBytes(32).toString("base64url");
  const path = `/mcp/${randomBytes(16).toString("hex")}`;
  const handler = createMcpHandler(server, {
    legacy: "reject",
    onerror: (err) => log.warn(`[execution] tool projection request failed: ${err.message}`),
  });
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== path) return new Response(null, { status: 404 });
      if (!bearerMatches(request.headers.get("authorization"), token)) {
        return new Response(null, { status: 401 });
      }
      return handler.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}${path}`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    stop: () => listener.stop(true),
  };
}

/**
 * The projection's MCP server on an in-memory link, fed by the caller: each
 * request is matched to its response by its id. The server never asks the
 * agent anything, so a message it sends that is not a response is dropped.
 */
function openChannel(server: () => Server): McpChannel & { close(): Promise<void> } {
  const [agentSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<
    string,
    (answer: { result: unknown } | { error: McpErrorObject }) => void
  >();
  agentSide.onmessage = (message) => {
    const id = "id" in message ? String(message.id) : undefined;
    const settle = id === undefined ? undefined : pending.get(id);
    if (!settle || !("result" in message || "error" in message)) {
      log.debug("execution", "[projection] dropped a message the server sent unprompted");
      return;
    }
    pending.delete(id as string);
    settle("error" in message ? { error: message.error } : { result: message.result });
  };
  const ready = server().connect(serverSide);
  return {
    async request(id, method, params, signal) {
      await ready;
      if (pending.has(id)) {
        return { error: { code: -32600, message: `request id ${id} is already in flight` } };
      }
      const answer = new Promise<{ result: unknown } | { error: McpErrorObject }>((resolve) =>
        pending.set(id, resolve),
      );
      const cancel = () => {
        const settle = pending.get(id);
        if (!settle) return;
        pending.delete(id);
        void agentSide.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        });
        settle({ error: { code: REQUEST_CANCELLED, message: "request cancelled" } });
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      await agentSide.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      try {
        return await answer;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    notify(method, params) {
      void ready.then(() =>
        agentSide.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
      );
    },
    async close() {
      for (const settle of pending.values()) {
        settle({ error: { code: REQUEST_CANCELLED, message: "the run ended" } });
      }
      pending.clear();
      await agentSide.close();
    },
  };
}

/** The tools an agent may call: the router's set, model-visible, minus engine state. */
async function projectedTools(router: ToolRouter): Promise<ToolSchema[]> {
  const all = await router.availableTools();
  return all.filter((t) => isModelVisible(t) && !ENGINE_STATE_TOOLS.has(t.name));
}

function createServer(
  tools: ToolSchema[],
  callTool: (name: string, input: Record<string, unknown>) => Promise<CallToolResult>,
): Server {
  const server = new Server(
    { name: "nimblebrain-run", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", () => ({ tools: tools.map(toMcpTool) }));
  server.setRequestHandler("tools/call", (request) =>
    callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
  );
  return server;
}

function toMcpTool(tool: ToolSchema): Tool {
  return {
    name: tool.name,
    description: tool.description,
    // A ToolSchema's inputSchema is the connector's own, and always an object schema.
    inputSchema: { type: "object", ...tool.inputSchema } as Tool["inputSchema"],
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Tool["outputSchema"] } : {}),
  };
}

/**
 * One call, end to end: the checks the engine applies to a model's call, the
 * hold for bound guidance, the router, the result bound, and the record. An
 * unknown or hidden tool is an error result, never a thrown request, so the
 * agent sees why and can recover.
 */
async function dispatch(
  opts: ToolProjectionOptions,
  toolsByName: Map<string, ToolSchema>,
  records: ToolCallRecord[],
  skills: SkillDelivery,
  name: string,
  rawInput: Record<string, unknown>,
): Promise<CallToolResult> {
  const id = `call_${crypto.randomUUID().slice(0, 12)}`;
  const schema = toolsByName.get(name);
  if (!schema) {
    return toCallToolResult({ content: textContent(`Tool not available: ${name}`), isError: true });
  }
  const { call, refusal, held, denied } = await gate(opts, schema, skills, {
    id,
    name,
    input: rawInput,
  });
  const uiMeta = schema.meta?.ui as Record<string, unknown> | undefined;
  const resourceUri = typeof uiMeta?.resourceUri === "string" ? uiMeta.resourceUri : undefined;

  opts.observer?.callStarting(call);
  opts.events.emit({
    type: "tool.start",
    data: { runId: opts.runId, name, id, resourceUri, input: rawInput },
  });
  // A call that runs gets its tool's guidance after it, as in the engine.
  if (!held && !denied) skills.claimFor(name);

  const start = performance.now();
  let result = refusal ?? (await execute(opts, call));
  result = enforceMaxToolResultSize(result, opts.maxToolResultSize);
  const ms = performance.now() - start;
  if (!held && opts.hooks?.afterToolCall) result = await opts.hooks.afterToolCall(call, result);

  const outputText = extractTextForModel(result.content);
  const modelOutput = held
    ? outputText
    : boundToolResultForModel(outputText, { hasUiResource: !!resourceUri });
  const bounded = modelOutput !== outputText;
  const resourceLinks = extractResourceLinks(result.content);

  opts.events.emit({
    type: "tool.done",
    data: buildToolDoneData({
      runId: opts.runId,
      name,
      id,
      finalResult: result,
      ms,
      resourceUri: held ? undefined : resourceUri,
      outputText,
      bounded,
      modelOutput,
      resourceLinks,
      verdict: { type: "pass" },
      ...(held ? { held: true as const } : {}),
    }),
  });
  recordSkillMarkers(opts, id, result, skills);
  records.push({
    id,
    name,
    input: call.input,
    output: outputText,
    ok: !result.isError,
    ms,
    ...(resourceUri ? { resourceUri } : {}),
    ...(resourceLinks.length > 0 ? { resourceLinks } : {}),
  });

  // The agent's model sees what the native engine's model would: the bounded
  // text, then any guidance delivered with this call.
  const guidance = (await skills.settle()).map((d) =>
    formatConnectorSkillBlock(d.skillName, d.scope, d.skillBody, d.heldToolCallId !== undefined),
  );
  const seen = bounded ? textContent(modelOutput) : result.content;
  return toCallToolResult({
    ...result,
    content: [...seen, ...guidance.flatMap((text) => textContent(text))],
  });
}

/**
 * The engine's checks on a model's call, in its order: coerce and validate the
 * input, hold it for bound guidance the model has not read, then the run's
 * `beforeToolCall` gate, whose rewrite is checked again. A refused call carries
 * the result the agent sees in place of running; `held` and `denied` say why
 * it did not run.
 */
async function gate(
  opts: ToolProjectionOptions,
  schema: ToolSchema,
  skills: SkillDelivery,
  offered: ToolCall,
): Promise<{ call: ToolCall; refusal?: ToolResult; held?: true; denied?: true }> {
  const checked = coerceAndValidateToolInput(offered.input, schema);
  const call: ToolCall = { ...offered, input: checked.input };
  if (checked.errorResult) return { call, refusal: checked.errorResult };
  // Ahead of the hook, so no person approves a call that is then held.
  const heldResult = await skills.hold(call, {
    readOnly: schema.annotations?.readOnlyHint === true,
    signal: opts.signal,
  });
  if (heldResult) return { call, refusal: heldResult, held: true };
  const beforeToolCall = opts.hooks?.beforeToolCall;
  if (!beforeToolCall) return { call };
  const hooked = await beforeToolCall(call);
  // A hook may rewrite a call's input, not send it to a tool the agent never named.
  if (hooked === null || hooked.name !== call.name) {
    return {
      call,
      refusal: { content: textContent("Tool call was denied by policy."), isError: true },
      denied: true,
    };
  }
  const rechecked = coerceAndValidateToolInput(hooked.input, schema);
  return { call: { ...call, input: rechecked.input }, refusal: rechecked.errorResult };
}

/** The router's answer, or the error it threw as an error result. */
async function execute(opts: ToolProjectionOptions, call: ToolCall): Promise<ToolResult> {
  try {
    return await opts.router.execute(call, opts.signal);
  } catch (err) {
    return {
      content: textContent(err instanceof Error ? err.message : String(err)),
      isError: true,
    };
  }
}

/**
 * The skill records the engine keeps from a result's host-owned markers: a
 * skill delivered by activation (so a later turn does not deliver it again)
 * and a skill muted for the conversation. Only the platform's own in-process
 * tools can set the markers; a connector's are stripped before they get here.
 * An activation is recorded once, as the engine records it: not again in a run,
 * nor for a skill the conversation already delivered.
 */
function recordSkillMarkers(
  opts: ToolProjectionOptions,
  toolCallId: string,
  result: ToolResult,
  skills: SkillDelivery,
): void {
  const activated = result._meta?.[SKILL_ACTIVATED_META_KEY] as
    | { skillName?: unknown; scope?: unknown; tokens?: unknown }
    | undefined;
  if (activated && typeof activated.skillName === "string" && activated.skillName) {
    const skillName = activated.skillName;
    if (skills.activated(skillName)) {
      opts.events.emit({
        type: "skill.activated",
        data: {
          runId: opts.runId,
          toolCallId,
          skillName,
          scope: typeof activated.scope === "string" ? activated.scope : "org",
          tokens: typeof activated.tokens === "number" ? activated.tokens : 0,
        },
      });
    }
  }
  const suppression = result._meta?.[SKILL_SUPPRESSION_META_KEY] as
    | { skillName?: unknown; suppressed?: unknown }
    | undefined;
  if (suppression && typeof suppression.skillName === "string" && suppression.skillName) {
    opts.events.emit({
      type: "skill.suppression",
      data: {
        runId: opts.runId,
        skillName: suppression.skillName,
        suppressed: suppression.suppressed === true,
      },
    });
  }
}

/**
 * A tool's result as the agent receives it. `_meta` stays behind: its keys are
 * host-owned markers meant for the engine that dispatched the call, and an
 * external agent is not that engine.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: result.content,
    isError: result.isError,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

function bearerMatches(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
