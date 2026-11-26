/**
 * The ACP agent the runtime dials: one turn per session, run by the backend
 * CLI. The runtime owns the conversation, so a session keeps nothing between
 * turns; each prompt carries the whole turn.
 */

import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { Backend } from "./backends/types.ts";
import type { Bridge } from "./bridge.ts";
import { log } from "./log.ts";

/** The response key the runtime's driver reads each model call from. */
export const USAGE_META_KEY = "nimblebrain-subscription/usage";
export const AGENT_VERSION = "0.1.0";

interface Session {
  system?: string;
  mcpUrl: string;
  release(): void;
  turn?: AbortController;
}

export function createWorkerAgent(backend: Backend, bridge: Bridge): acp.AgentApp {
  const sessions = new Map<string, Session>();
  const closeSession = (id: string) => {
    const session = sessions.get(id);
    sessions.delete(id);
    session?.turn?.abort();
    session?.release();
  };
  return acp
    .agent({ name: `nimblebrain-subscription-${backend.id}` })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { acp: true, http: false },
        ...(backend.takesSystemPrompt
          ? { sessionCapabilities: { systemPrompt: { mode: { override: {} } } } }
          : {}),
      },
      agentInfo: { name: `nimblebrain-subscription-${backend.id}`, version: AGENT_VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      const server = ctx.params.mcpServers.find((s) => "type" in s && s.type === "acp");
      if (!server || !("serverId" in server)) {
        throw acp.RequestError.invalidParams(undefined, "the session names no acp MCP server");
      }
      const { url, release } = bridge.bind(ctx.client, server.serverId);
      const sessionId = randomUUID();
      const system = ctx.params.systemPrompt?.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n\n");
      sessions.set(sessionId, { mcpUrl: url, release, ...(system ? { system } : {}) });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw acp.RequestError.invalidParams(undefined, "unknown session");
      session.turn?.abort();
      const turn = new AbortController();
      session.turn = turn;
      const started = performance.now();
      log(`turn started on ${backend.label}`);
      try {
        const result = await backend.run({
          prompt: promptText(ctx.params.prompt),
          ...(session.system ? { system: session.system } : {}),
          mcpUrl: session.mcpUrl,
          signal: turn.signal,
          emit: (update) =>
            void ctx.client
              .notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update,
              })
              .catch(() => {}),
        });
        const u = result.usage;
        log(
          `turn ${result.stopReason} in ${Math.round(performance.now() - started)}ms: ${u.inputTokens + (u.cacheReadTokens ?? 0)} in / ${u.outputTokens} out tokens, billed to the subscription`,
        );
        return {
          stopReason: result.stopReason,
          usage: {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.inputTokens + u.outputTokens,
            cachedReadTokens: u.cacheReadTokens ?? 0,
            cachedWriteTokens: u.cacheWriteTokens ?? 0,
          },
          _meta: { [USAGE_META_KEY]: { calls: result.calls } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`turn failed: ${message}`);
        throw acp.RequestError.internalError(undefined, message);
      } finally {
        if (session.turn === turn) session.turn = undefined;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort();
    })
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      closeSession(ctx.params.sessionId);
      return {};
    })
    .onConnect((connection) => {
      void connection.closed.then(() => {
        for (const id of [...sessions.keys()]) closeSession(id);
      });
    });
}

/** The prompt's text: text blocks and embedded text resources, in order. */
function promptText(blocks: acp.ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource" && "text" in block.resource) return block.resource.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}
