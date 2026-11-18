/**
 * PROTOTYPE: a run executed on Claude Managed Agents (CMA), Anthropic's hosted
 * agent loop.
 *
 * One run is one CMA session, created from a stored agent with this run's
 * model, system prompt and tools as session overrides, and deleted when the run
 * ends: the door owns the conversation (ADR-0056), so no CMA session is the
 * record of anything.
 *
 *   1. Open the run's tool projection and list its tools.
 *   2. Create the session: each projected tool is a CMA *custom* tool and the
 *      agent has no toolset of its own, so every call the model makes arrives
 *      on the session's event stream as `agent.custom_tool_use`. The runtime
 *      answers it through the projection with `user.custom_tool_result` over
 *      the same outbound HTTPS connection: nothing listens.
 *   3. Send the door's history as a transcript ahead of the latest message
 *      (CMA takes no assistant turns as input).
 *   4. Record the stream in the engine's vocabulary through the ACP recorder,
 *      fed synthetic ACP updates, so the record is the one the parity test
 *      already checks.
 *
 * The SDK's types stay in this file; nothing in the seam names them.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { EngineResult, StopReason } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import type { TokenUsage } from "../../usage/types.ts";
import type { ReportedModelCall } from "../acp/driver.ts";
import { createAcpRunRecorder } from "../acp/run-recorder.ts";
import { transcriptOf } from "../acp/transcript.ts";
import { openToolProjection } from "../tool-projection.ts";
import type { AgentRuntime, ResolvedRun, RunIO } from "../types.ts";

type CmaTool = Anthropic.Beta.Agents.BetaManagedAgentsCustomToolParams;
type CmaContent =
  Anthropic.Beta.Sessions.BetaManagedAgentsUserCustomToolResultEventParams["content"];
type CmaUserContent = Anthropic.Beta.Sessions.BetaManagedAgentsUserMessageEventParams["content"];

export interface CmaRuntimeOptions {
  /** The stored agent every session is created from (its overrides carry the run's terms). */
  agentId: string;
  /** The environment sessions run in: `cloud`, `limited` networking, no hosts. */
  environmentId: string;
  /** Keep sessions after the run (for the Console viewer). Default: delete them. */
  retainSessions?: boolean;
  client?: Anthropic;
}

export function createCmaRuntime(id: string, opts: CmaRuntimeOptions): AgentRuntime {
  const client = opts.client ?? new Anthropic();
  return {
    id,
    // CMA calls the model with the Anthropic org's key, past any gateway, so no
    // credential is minted and no grant can be carried (ADR-0057, ADR-0063).
    capabilities: { spendGate: false, usage: "reported" },
    execute: (run, io) => executeOnCma(id, client, opts, run, io),
  };
}

async function executeOnCma(
  runtimeId: string,
  client: Anthropic,
  opts: CmaRuntimeOptions,
  run: ResolvedRun,
  io: RunIO,
): Promise<EngineResult> {
  const signal = run.config.signal;
  const recorder = createAcpRunRecorder(run, io);
  recorder.start();
  const projection = await openToolProjection({
    runId: run.runId,
    router: io.tools,
    events: io.events,
    signal,
    maxToolResultSize: run.config.maxToolResultSize,
    ...(run.config.hooks ? { hooks: run.config.hooks } : {}),
    skills: {
      candidates: run.config.connectorSkillCandidates ?? [],
      delivered: run.config.alreadyInjectedConnectorSkills ?? [],
    },
    observer: recorder,
  });
  const channel = projection.channel();
  let sessionId: string | undefined;
  let stream: (AsyncIterable<unknown> & { controller: AbortController }) | undefined;
  const calls: ReportedModelCall[] = [];
  try {
    signal?.throwIfAborted();
    const listed = await channel.request("tools-list", "tools/list", undefined, signal);
    if ("error" in listed) throw new Error(`tool projection: ${listed.error.message}`);
    const names = toolNames((listed.result as { tools: McpToolSummary[] }).tools);

    const session = await client.beta.sessions.create({
      agent: {
        type: "agent_with_overrides",
        id: opts.agentId,
        model: { id: anthropicModelId(run.config.model) },
        system: run.system,
        tools: names.tools,
      },
      environment_id: opts.environmentId,
      title: `nimblebrain run ${run.runId}`,
      metadata: { nimblebrain_run: run.runId },
    });
    sessionId = session.id;
    io.events.emit({
      type: "execution.bound",
      data: { runId: run.runId, runtime: runtimeId, runtimeSessionId: session.id },
    });

    // Stream first, then send, so no early event is missed.
    stream = (await client.beta.sessions.events.stream(session.id, {
      event_deltas: ["agent.message"],
    })) as typeof stream;
    const onAbort = () =>
      void client.beta.sessions.events
        .send(session.id, { events: [{ type: "user.interrupt" }] })
        .catch((err) => log.warn(`[cma] interrupt failed: ${String(err)}`, { runId: run.runId }));
    signal?.addEventListener("abort", onAbort, { once: true });
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: openingMessage(run) }],
    });

    const stop = await consume(client, session.id, stream!, run, recorder, names, channel, calls);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      recorder.cancelled(undefined, { calls });
      throw signal.reason ?? new DOMException("cancelled", "AbortError");
    }
    if (stop.failure) throw stop.failure;
    return recorder.finish(
      { stopReason: stop.acp },
      { calls, ...(stop.reason ? { stopReason: stop.reason } : {}) },
      projection.calls(),
    );
  } catch (err) {
    if (!recorder.ended()) {
      if (signal?.aborted) recorder.cancelled(undefined, { calls });
      else recorder.failed(err);
    }
    throw signal?.aborted ? (signal.reason ?? err) : err;
  } finally {
    stream?.controller.abort();
    await projection.close();
    if (sessionId && !opts.retainSessions) await deleteSession(client, sessionId, run.runId);
  }
}

interface ConsumeResult {
  acp: "end_turn" | "max_turn_requests" | "refusal" | "cancelled";
  reason?: StopReason;
  failure?: Error;
}

/**
 * Drain the session's stream until the turn ends. Text previews stream as
 * deltas; the buffered `agent.message` is authoritative, so whatever the
 * previews did not deliver is emitted when it arrives.
 */
async function consume(
  client: Anthropic,
  sessionId: string,
  stream: AsyncIterable<unknown>,
  run: ResolvedRun,
  recorder: ReturnType<typeof createAcpRunRecorder>,
  names: ToolNames,
  channel: ReturnType<Awaited<ReturnType<typeof openToolProjection>>["channel"]>,
  calls: ReportedModelCall[],
): Promise<ConsumeResult> {
  const streamed = new Map<string, string>();
  const chunk = (text: string) =>
    recorder.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  let overIterations = false;
  let lastError: string | undefined;

  for await (const raw of stream) {
    const ev = raw as { type: string } & Record<string, unknown>;
    switch (ev.type) {
      case "event_delta": {
        const delta = ev.delta as { content?: { type: string; text?: string } };
        const id = ev.event_id as string;
        const text = delta.content?.type === "text" ? (delta.content.text ?? "") : "";
        if (!text) break;
        streamed.set(id, (streamed.get(id) ?? "") + text);
        chunk(text);
        break;
      }
      case "agent.message": {
        const full = (ev.content as { type: string; text?: string }[])
          .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
          .join("");
        const already = streamed.get(ev.id as string) ?? "";
        const rest = full.startsWith(already) ? full.slice(already.length) : full;
        if (rest) chunk(rest);
        streamed.delete(ev.id as string);
        break;
      }
      case "agent.custom_tool_use":
        // Answered as it arrives; parallel calls run concurrently.
        void answerToolCall(client, sessionId, ev, names, channel, run);
        break;
      case "span.model_request_end": {
        const u = ev.model_usage as {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens: number;
          cache_creation_input_tokens: number;
        };
        calls.push({ model: run.config.model, purpose: "turn", usage: tokenUsage(u) });
        // CMA has no iteration cap of its own: hold the run to the door's.
        if (!overIterations && calls.length >= run.config.maxIterations) {
          overIterations = true;
          await client.beta.sessions.events.send(sessionId, {
            events: [{ type: "user.interrupt" }],
          });
        }
        break;
      }
      case "agent.thread_context_compacted":
        log.info("[cma] the session compacted its own context mid-turn", { runId: run.runId });
        break;
      case "session.error":
        lastError = JSON.stringify(ev.error ?? ev);
        log.warn(`[cma] session error: ${lastError}`, { runId: run.runId });
        break;
      case "session.status_terminated":
        return {
          acp: "end_turn",
          failure: new Error(`CMA session terminated: ${lastError ?? "no error reported"}`),
        };
      case "session.status_idle": {
        const stop = ev.stop_reason as { type: string };
        if (stop.type === "requires_action") break;
        if (overIterations) return { acp: "max_turn_requests", reason: "max_iterations" };
        if (stop.type === "end_turn") return { acp: "end_turn" };
        if (stop.type === "budget_reached") return { acp: "end_turn", reason: "spend_limit" };
        if (stop.type === "refusal") return { acp: "refusal", reason: "content_filter" };
        return {
          acp: "end_turn",
          failure: new Error(`CMA session stopped: ${stop.type} ${lastError ?? ""}`),
        };
      }
      default:
        break;
    }
  }
  return { acp: "end_turn", failure: new Error("CMA event stream ended before the turn did") };
}

async function answerToolCall(
  client: Anthropic,
  sessionId: string,
  ev: Record<string, unknown>,
  names: ToolNames,
  channel: ReturnType<Awaited<ReturnType<typeof openToolProjection>>["channel"]>,
  run: ResolvedRun,
): Promise<void> {
  const eventId = ev.id as string;
  const name = names.toProjected.get(ev.name as string) ?? (ev.name as string);
  let content: CmaContent;
  let isError = false;
  try {
    const answer = await channel.request(
      eventId,
      "tools/call",
      { name, arguments: ev.input as Record<string, unknown> },
      run.config.signal,
    );
    if ("error" in answer) {
      isError = true;
      content = [{ type: "text", text: answer.error.message }];
    } else {
      const result = answer.result as CallToolResult;
      isError = result.isError === true;
      content = toCmaContent(result);
    }
  } catch (err) {
    isError = true;
    content = [{ type: "text", text: err instanceof Error ? err.message : String(err) }];
  }
  await client.beta.sessions.events
    .send(sessionId, {
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: eventId,
          content,
          is_error: isError,
        },
      ],
    })
    .catch((err) =>
      log.warn(`[cma] could not return a tool result: ${String(err)}`, { runId: run.runId }),
    );
}

/** An MCP tool result as CMA tool-result content: text and images; anything else as text. */
function toCmaContent(result: CallToolResult): CmaContent {
  const out: NonNullable<CmaContent> = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "image")
      out.push({
        type: "image",
        source: { type: "base64", data: block.data, media_type: block.mimeType },
      });
    else out.push({ type: "text", text: JSON.stringify(block) });
  }
  return out.length > 0 ? out : [{ type: "text", text: "(no output)" }];
}

/**
 * The door's history as one user message: CMA takes no assistant turns or tool
 * results as input, so prior turns travel as a contained transcript, as they do
 * for an ACP agent with no means of its own (`../acp/transcript.ts`).
 */
function openingMessage(run: ResolvedRun): CmaUserContent {
  const latest = run.messages.at(-1);
  const prior = latest?.role === "user" ? run.messages.slice(0, -1) : run.messages;
  const history = transcriptOf(prior);
  const blocks: CmaUserContent = [];
  if (history) {
    blocks.push({
      type: "text",
      text: `<conversation-history>\n${history.replaceAll("</conversation-history>", "<\\/conversation-history>")}\n</conversation-history>`,
    });
  }
  if (latest?.role === "user") {
    for (const part of latest.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else if (part.data.type === "data" && part.mediaType.startsWith("image/")) {
        const data = part.data.data;
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: typeof data === "string" ? data : Buffer.from(data).toString("base64"),
          },
        });
      } else blocks.push({ type: "text", text: `[attachment not carried: ${part.mediaType}]` });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "(continue)" }];
}

interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ToolNames {
  tools: CmaTool[];
  /** CMA name → the projection's name. */
  toProjected: Map<string, string>;
}

/**
 * Projected tools as CMA custom tools. CMA names allow 1-128 of letters,
 * digits, `_` and `-`, and refuse an `mcp__` or `ant__` prefix, so a name that
 * breaks a rule is rewritten and mapped back when the agent calls it.
 */
function toolNames(tools: McpToolSummary[]): ToolNames {
  const toProjected = new Map<string, string>();
  const out: CmaTool[] = [];
  for (const t of tools) {
    let name = t.name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (/^(mcp|ant)__/.test(name)) name = `nb_${name}`;
    if (name.length > 128) name = `${name.slice(0, 115)}_${hash(t.name)}`;
    toProjected.set(name, t.name);
    out.push({
      type: "custom",
      name,
      description: t.description ?? t.name,
      input_schema: t.inputSchema as CmaTool["input_schema"],
    });
  }
  return { tools: out, toProjected };
}

function hash(s: string): string {
  return Bun.hash(s).toString(36).slice(0, 12);
}

/** `anthropic:claude-x` → `claude-x`. CMA serves Anthropic models only. */
function anthropicModelId(model: string): string {
  const [provider, id] = model.includes(":") ? model.split(":", 2) : ["anthropic", model];
  if (provider !== "anthropic" || !id) {
    throw new Error(`Claude Managed Agents runs Anthropic models only, not ${model}`);
  }
  return id;
}

function tokenUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}): TokenUsage {
  return {
    // NimbleBrain's inputTokens is the input total; CMA's excludes the cache.
    inputTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens,
    reasoningTokens: 0,
  };
}

/** Delete the run's session once it has settled: the door holds the record. */
async function deleteSession(client: Anthropic, sessionId: string, runId: string): Promise<void> {
  try {
    for (let i = 0; i < 20; i++) {
      const s = await client.beta.sessions.retrieve(sessionId);
      if (s.status !== "running") break;
      await Bun.sleep(250);
    }
    await client.beta.sessions.delete(sessionId);
  } catch (err) {
    log.warn(`[cma] could not delete session ${sessionId}: ${String(err)}`, { runId });
  }
}
