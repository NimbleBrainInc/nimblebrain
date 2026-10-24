/**
 * NimbleBrain's own engine, served as an ACP agent.
 *
 * The reference agent for the ACP path: the generic ACP runtime
 * (`src/execution/acp/`) drives it exactly as it drives any other agent, so a
 * run through it exercises the client, the event translation, the tool
 * projection and the session mapping with no external dependency. Its
 * outcomes are compared against the native runtime's for the same run.
 *
 * It reaches tools only through the MCP servers the client names at
 * `session/new`. A client that sends NimbleBrain's `_meta` extension
 * (`../acp/nimblebrain-extension.ts`) hands it the prompt, history and limits
 * whole; any other ACP client gets a session on the agent's own `defaults`,
 * with whatever context it sends in the prompt. It is the seed of Reflex, a
 * standalone ACP agent, so it must work over plain ACP and import nothing of
 * the platform beyond the engine.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4, LanguageModelV4Message } from "@ai-sdk/provider";
import { AgentEngine } from "../../engine/engine.ts";
import type { EngineConfig, EngineEvent, EventSink } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import type { TokenUsage } from "../../usage/types.ts";
import {
  decodeMessages,
  promptToUserMessage,
  RUN_META_KEY,
  type RunMeta,
  STOP_REASON_META_KEY,
  toAcpStopReason,
} from "../acp/nimblebrain-extension.ts";
import { connectMcpToolRouter, type HttpMcpServer, type McpToolRouter } from "./mcp-tool-router.ts";

interface AgentSession {
  meta: RunMeta;
  router: McpToolRouter;
  /** Everything the session has said and done, oldest first. */
  history: LanguageModelV4Message[];
  turn?: AbortController;
}

/** What a session runs with when the client sends no run `_meta`. */
export type AgentDefaults = Omit<RunMeta, "system" | "history">;

export interface NimbleBrainAcpAgentOptions {
  resolveModel(model: string): LanguageModelV4;
  /**
   * The agent's own model and limits, for a plain ACP client. Absent, a
   * session without run `_meta` is refused: the agent has nothing to run on.
   */
  defaults?: AgentDefaults;
}

export function createNimbleBrainAcpAgent(opts: NimbleBrainAcpAgentOptions): acp.AgentApp {
  const sessions = new Map<string, AgentSession>();

  return acp
    .agent({ name: "nimblebrain" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true },
      },
      agentInfo: { name: "nimblebrain", version: "1" },
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sent = ctx.params._meta?.[RUN_META_KEY] as RunMeta | undefined;
      const meta = sent ?? (opts.defaults && { ...opts.defaults, system: "", history: "[]" });
      if (!meta) {
        throw acp.RequestError.invalidParams(
          undefined,
          `session/new needs _meta["${RUN_META_KEY}"]`,
        );
      }
      const router = await connectMcpToolRouter(ctx.params.mcpServers.map(httpServer));
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { meta, router, history: decodeMessages(meta.history) });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw acp.RequestError.invalidParams(undefined, "unknown session");
      session.turn?.abort();
      const turn = new AbortController();
      session.turn = turn;
      session.history.push(promptToUserMessage(ctx.params.prompt));

      const updates = createUpdateStream(ctx.client, ctx.params.sessionId);
      const sink: EventSink = {
        emit(event) {
          updates.forward(event);
          recordHistory(session.history, event);
        },
      };
      const { meta } = session;
      const config = engineConfigOf(meta, turn.signal);
      const engine = new AgentEngine(opts.resolveModel(meta.model), session.router, sink);
      try {
        const result = await engine.run(
          config,
          meta.system,
          [...session.history],
          await session.router.availableTools(),
        );
        await updates.drained();
        return {
          stopReason: toAcpStopReason(result.stopReason),
          usage: acpUsage(result.usage),
          _meta: { [STOP_REASON_META_KEY]: result.stopReason },
        };
      } catch (err) {
        await updates.drained();
        if (turn.signal.aborted) return { stopReason: "cancelled" as const };
        throw err;
      } finally {
        if (session.turn === turn) session.turn = undefined;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort();
    })
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      sessions.delete(ctx.params.sessionId);
      session?.turn?.abort();
      await session?.router.close();
      return {};
    })
    .onConnect((connection) => {
      void connection.closed.then(async () => {
        for (const session of sessions.values()) {
          session.turn?.abort();
          await session.router.close();
        }
        sessions.clear();
      });
    });
}

function engineConfigOf(meta: RunMeta, signal: AbortSignal): EngineConfig {
  return {
    model: meta.model,
    maxIterations: meta.maxIterations,
    maxInputTokens: meta.maxInputTokens,
    maxOutputTokens: meta.maxOutputTokens,
    ...(meta.thinking ? { thinking: meta.thinking } : {}),
    signal,
  };
}

/** The run's usage in ACP's (unstable) turn-usage shape. */
function acpUsage(usage: TokenUsage): acp.Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens ? { cachedReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens ? { cachedWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens ? { thoughtTokens: usage.reasoningTokens } : {}),
  };
}

function httpServer(server: acp.McpServer): HttpMcpServer {
  if ("type" in server && server.type === "http") {
    return { name: server.name, url: server.url, headers: server.headers };
  }
  throw acp.RequestError.invalidParams(
    undefined,
    `MCP server ${server.name}: only http is supported`,
  );
}

/**
 * Engine events as ACP session updates, sent in the order the engine emitted
 * them. `drained` resolves once every update has been written, so a prompt
 * response never overtakes the updates of its own turn.
 */
function createUpdateStream(client: acp.AgentContext, sessionId: string) {
  let chain: Promise<void> = Promise.resolve();
  const send = (update: acp.SessionUpdate) => {
    chain = chain
      .then(() => client.notify(acp.methods.client.session.update, { sessionId, update }))
      .catch((err) => log.warn(`[acp-agent] session update not delivered: ${String(err)}`));
  };
  return {
    forward(event: EngineEvent) {
      switch (event.type) {
        case "text.delta":
          send({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.data.text },
          });
          return;
        case "reasoning.delta":
          send({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.data.text },
          });
          return;
        case "tool.start":
          send({
            sessionUpdate: "tool_call",
            toolCallId: event.data.id,
            title: event.data.name,
            kind: "other",
            status: "in_progress",
            rawInput: event.data.input,
          });
          return;
        case "tool.done":
          send({
            sessionUpdate: "tool_call_update",
            toolCallId: event.data.id,
            status: event.data.ok ? "completed" : "failed",
            content: [{ type: "content", content: { type: "text", text: event.data.output } }],
          });
          return;
        default:
          return;
      }
    },
    drained: () => chain,
  };
}

/**
 * Keep the session's history as the engine would replay it: each model call's
 * content, then its tool results in one tool message, so a second prompt in
 * the same session sees what the first did.
 */
function recordHistory(history: LanguageModelV4Message[], event: EngineEvent): void {
  if (event.type === "llm.done") {
    const content = event.data.content.filter(
      (b) => b.type === "text" || b.type === "tool-call" || b.type === "reasoning",
    );
    if (content.length > 0) {
      history.push({
        role: "assistant",
        content: content.map((b) =>
          b.type === "tool-call"
            ? {
                type: "tool-call" as const,
                toolCallId: b.toolCallId,
                toolName: b.toolName,
                input: JSON.parse(b.input || "{}"),
              }
            : b.type === "text"
              ? { type: "text" as const, text: b.text }
              : { type: "reasoning" as const, text: b.text },
        ),
      });
    }
    return;
  }
  if (event.type === "tool.done") {
    const part = {
      type: "tool-result" as const,
      toolCallId: event.data.id,
      toolName: event.data.name,
      output: { type: "text" as const, value: event.data.modelOutput ?? event.data.output },
    };
    const last = history.at(-1);
    if (last?.role === "tool") last.content.push(part);
    else history.push({ role: "tool", content: [part] });
  }
}
