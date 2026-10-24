/**
 * The tool projection: a run's walled tool router, served as an MCP endpoint
 * that lives exactly as long as the run.
 *
 * A runtime outside the engine loop reaches NimbleBrain's tools through this
 * and nothing else. Every call dispatches through the router the door built
 * for the run, so the workspace wall, `allowedTools`, the unattended policy and
 * connector permissions hold for an external agent exactly as for the native
 * engine. `/mcp/<wsId>` is not used: it serves a person's attended surface, not
 * a run's bound (ADR-0047).
 *
 * The projection is also where the run's tool record comes from. It emits
 * `tool.start` / `tool.done` itself, from the call it dispatched and the result
 * the tool returned, so the conversation log holds what ran, not an agent's
 * description of it.
 *
 * It listens on loopback only, on a random port, at a random path, behind a
 * random bearer token. The endpoint dies with the run.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import {
  boundToolResultForModel,
  extractResourceLinks,
  extractTextForModel,
  textContent,
} from "../engine/content-helpers.ts";
import {
  buildToolDoneData,
  coerceAndValidateToolInput,
  enforceMaxToolResultSize,
} from "../engine/tool-call.ts";
import {
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
  observer?: ToolProjectionObserver;
}

/** A live projection: where an agent reaches it, and how it ends. */
export interface ToolProjection {
  /** The MCP Streamable HTTP endpoint. */
  url: string;
  /** Headers every request must carry. Secret: never logged or persisted. */
  headers: { name: string; value: string }[];
  /** Every call the projection dispatched, in the order they started. */
  calls(): ToolCallRecord[];
  close(): Promise<void>;
}

/**
 * Open a projection for one run. Call it from inside the run's request
 * context: the projection carries that context to every tool call, which
 * reads the run's identity from it.
 */
export async function openToolProjection(opts: ToolProjectionOptions): Promise<ToolProjection> {
  const runInRunContext = AsyncLocalStorage.snapshot();
  const token = randomBytes(32).toString("base64url");
  const path = `/mcp/${randomBytes(16).toString("hex")}`;
  const records: ToolCallRecord[] = [];
  const activatedSkills = new Set<string>();
  const tools = await projectedTools(opts.router);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const callTool = (name: string, input: Record<string, unknown>): Promise<CallToolResult> =>
    runInRunContext(() => dispatch(opts, toolsByName, records, activatedSkills, name, input));

  const handler = createMcpHandler(() => createServer(tools, callTool), {
    legacy: "reject",
    onerror: (err) => log.warn(`[execution] tool projection request failed: ${err.message}`),
  });

  const server = Bun.serve({
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

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.stop(true);
  };
  opts.signal?.addEventListener("abort", () => void close(), { once: true });

  return {
    url: `http://127.0.0.1:${server.port}${path}`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    calls: () => [...records],
    close,
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
 * router, the result bound, and the record. An unknown or hidden tool is an
 * error result, never a thrown request, so the agent sees why and can recover.
 */
async function dispatch(
  opts: ToolProjectionOptions,
  toolsByName: Map<string, ToolSchema>,
  records: ToolCallRecord[],
  activatedSkills: Set<string>,
  name: string,
  rawInput: Record<string, unknown>,
): Promise<CallToolResult> {
  const id = `call_${crypto.randomUUID().slice(0, 12)}`;
  const schema = toolsByName.get(name);
  if (!schema) {
    return toCallToolResult({ content: textContent(`Tool not available: ${name}`), isError: true });
  }
  const { call, refusal } = await gate(opts, schema, { id, name, input: rawInput });
  const uiMeta = schema.meta?.ui as Record<string, unknown> | undefined;
  const resourceUri = typeof uiMeta?.resourceUri === "string" ? uiMeta.resourceUri : undefined;

  opts.observer?.callStarting(call);
  opts.events.emit({
    type: "tool.start",
    data: { runId: opts.runId, name, id, resourceUri, input: rawInput },
  });

  const start = performance.now();
  let result = refusal ?? (await execute(opts, call));
  result = enforceMaxToolResultSize(result, opts.maxToolResultSize);
  const ms = performance.now() - start;
  if (opts.hooks?.afterToolCall) result = await opts.hooks.afterToolCall(call, result);

  const outputText = extractTextForModel(result.content);
  const modelOutput = boundToolResultForModel(outputText, { hasUiResource: !!resourceUri });
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
      resourceUri,
      outputText,
      bounded,
      modelOutput,
      resourceLinks,
      verdict: { type: "pass" },
    }),
  });
  recordSkillMarkers(opts, id, result, activatedSkills);
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

  // The agent's model sees what the native engine's model would: the bounded text.
  return toCallToolResult(bounded ? { ...result, content: textContent(modelOutput) } : result);
}

/**
 * The engine's checks on a model's call: coerce and validate the input, then
 * the run's `beforeToolCall` gate, whose rewrite is checked again. A refused
 * call carries the result the agent sees in place of running.
 */
async function gate(
  opts: ToolProjectionOptions,
  schema: ToolSchema,
  offered: ToolCall,
): Promise<{ call: ToolCall; refusal?: ToolResult }> {
  const checked = coerceAndValidateToolInput(offered.input, schema);
  const call: ToolCall = { ...offered, input: checked.input };
  if (checked.errorResult) return { call, refusal: checked.errorResult };
  const beforeToolCall = opts.hooks?.beforeToolCall;
  if (!beforeToolCall) return { call };
  const hooked = await beforeToolCall(call);
  // A hook may rewrite a call's input, not send it to a tool the agent never named.
  if (hooked === null || hooked.name !== call.name) {
    return {
      call,
      refusal: { content: textContent("Tool call was denied by policy."), isError: true },
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
 * An activation is recorded once per run, as the engine records it.
 */
function recordSkillMarkers(
  opts: ToolProjectionOptions,
  toolCallId: string,
  result: ToolResult,
  activatedSkills: Set<string>,
): void {
  const activated = result._meta?.[SKILL_ACTIVATED_META_KEY] as
    | { skillName?: unknown; scope?: unknown; tokens?: unknown }
    | undefined;
  if (activated && typeof activated.skillName === "string" && activated.skillName) {
    const skillName = activated.skillName;
    if (!activatedSkills.has(skillName)) {
      activatedSkills.add(skillName);
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
