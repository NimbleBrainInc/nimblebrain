/**
 * A scripted ACP agent, for tests of the generic ACP runtime with no model and
 * no external agent. It speaks plain ACP over an in-memory connection, reaches
 * tools only through the MCP servers named at `session/new` (the run's tool
 * projection), and plays a script: each step streams its text, then calls its
 * tools in order, as a model's turn would.
 *
 * Given the same steps as an echo model's responses, it leaves the record the
 * native engine leaves for that script, which is what the parity tests compare.
 */

import { tmpdir } from "node:os";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AcpConnection, AcpDriver } from "../../../src/execution/acp/driver.ts";
import type { EchoModelResponse } from "../echo-model.ts";
import { acpMcpClientTransport } from "./acp-mcp-client-transport.ts";
import {
  connectMcpToolRouter,
  httpMcpServer,
  type McpToolRouter,
  type ReachableMcpServer,
} from "./mcp-tool-router.ts";

/** One model call's worth of a turn: its text, then its tool calls. */
export interface ScriptStep {
  text?: string;
  toolCalls?: { toolName: string; input: Record<string, unknown> }[];
}

/** What the agent received, for a test to inspect. */
export interface ScriptedAgentLog {
  /** Each turn's prompt, as text. */
  prompts: string[];
  /** Each tool result's text, in the order they returned. */
  toolResults: string[];
  /** Each session's `_meta`. */
  sessionMeta: (Record<string, unknown> | undefined)[];
  /** Each session's MCP servers, as declared. */
  mcpServers: acp.McpServer[][];
  /** Each session's `systemPrompt`, when it was sent one. */
  systemPrompts: (acp.SystemPrompt | undefined)[];
  /** Every `providers/set` and `providers/disable`, in order. */
  providerCalls: { method: "set" | "disable"; params: Record<string, unknown> }[];
}

export interface ScriptedAgentOptions {
  /** The turn's steps, given its prompt as text. */
  script(prompt: string): ScriptStep[];
  /** Refuse `session/new`, as an agent that cannot run the session would. */
  refuseSession?: boolean;
  /**
   * The MCP transports the agent advertises. Default: HTTP only, as most
   * agents today; `acp` takes the client's tools on the ACP connection itself.
   */
  mcp?: { http?: boolean; acp?: boolean };
  /** Advertise ACP's `systemPrompt`; `override` adds that mode to `append`. */
  systemPrompt?: { override?: boolean };
  /** Advertise ACP's `providers/*`, listing these. */
  providers?: acp.ProviderInfo[];
  log?: ScriptedAgentLog;
}

/** An echo model's scripted responses as the agent's steps. */
export function stepsFrom(responses: EchoModelResponse[]): ScriptStep[] {
  return responses.map((r) => ({
    ...(r.text ? { text: r.text } : {}),
    ...(r.toolCalls
      ? {
          toolCalls: r.toolCalls.map((c) => ({
            toolName: c.toolName,
            input: JSON.parse(c.input || "{}") as Record<string, unknown>,
          })),
        }
      : {}),
  }));
}

export function emptyLog(): ScriptedAgentLog {
  return {
    prompts: [],
    toolResults: [],
    sessionMeta: [],
    mcpServers: [],
    systemPrompts: [],
    providerCalls: [],
  };
}

export function createScriptedAgent(opts: ScriptedAgentOptions): acp.AgentApp {
  const sessions = new Map<string, { router: McpToolRouter; turn?: AbortController }>();
  return acp
    .agent({ name: "scripted" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: opts.mcp ?? { http: true },
        ...(opts.systemPrompt
          ? {
              sessionCapabilities: {
                systemPrompt: opts.systemPrompt.override ? { mode: { override: {} } } : {},
              },
            }
          : {}),
        ...(opts.providers ? { providers: {} } : {}),
      },
      agentInfo: { name: "scripted", version: "1" },
    }))
    .onRequest(acp.methods.agent.providers.list, () => ({ providers: opts.providers ?? [] }))
    .onRequest(acp.methods.agent.providers.set, (ctx) => {
      opts.log?.providerCalls.push({ method: "set", params: { ...ctx.params } });
      return {};
    })
    .onRequest(acp.methods.agent.providers.disable, (ctx) => {
      opts.log?.providerCalls.push({ method: "disable", params: { ...ctx.params } });
      return {};
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      if (opts.refuseSession) throw acp.RequestError.invalidParams(undefined, "no session");
      opts.log?.sessionMeta.push(ctx.params._meta ?? undefined);
      opts.log?.mcpServers.push(ctx.params.mcpServers);
      opts.log?.systemPrompts.push(ctx.params.systemPrompt ?? undefined);
      const router = await connectMcpToolRouter(
        ctx.params.mcpServers.flatMap((s): ReachableMcpServer[] => {
          if (!("type" in s)) return [];
          if (s.type === "http") return [httpMcpServer(s)];
          if (s.type === "acp") {
            return [
              { name: s.name, transport: () => acpMcpClientTransport(ctx.client, s.serverId) },
            ];
          }
          return [];
        }),
      );
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { router });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw acp.RequestError.invalidParams(undefined, "unknown session");
      const turn = new AbortController();
      session.turn = turn;
      const prompt = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      opts.log?.prompts.push(prompt);
      const send = (update: acp.SessionUpdate) =>
        ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      try {
        for (const step of opts.script(prompt)) {
          if (step.text) {
            await send({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: step.text },
            });
          }
          for (const [i, call] of (step.toolCalls ?? []).entries()) {
            const toolCallId = `t${i}_${crypto.randomUUID().slice(0, 6)}`;
            await send({
              sessionUpdate: "tool_call",
              toolCallId,
              title: call.toolName,
              status: "in_progress",
            });
            const result = await session.router.execute(
              { id: toolCallId, name: call.toolName, input: call.input },
              turn.signal,
            );
            const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
            opts.log?.toolResults.push(text);
            await send({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: result.isError ? "failed" : "completed",
            });
          }
          if (turn.signal.aborted) return { stopReason: "cancelled" as const };
        }
        return { stopReason: "end_turn" as const };
      } catch (err) {
        if (turn.signal.aborted) return { stopReason: "cancelled" as const };
        throw err;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort();
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

/** The scripted agent's driver: plain ACP, so the transcript prompt and no `_meta`. */
export function scriptedDriver(): AcpDriver {
  return { toolSurface: "projection" };
}

/** A connection to the scripted agent, in this process. */
export function scriptedConnection(opts: ScriptedAgentOptions): AcpConnection {
  return {
    async open() {
      return {
        target: createScriptedAgent(opts),
        cwd: tmpdir(),
        sameHost: true,
        close: async () => {},
      };
    },
  };
}
