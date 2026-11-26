/**
 * The ACP agent the runtime dials: one turn per session, run by the backend
 * CLI. The runtime owns the conversation, so a session keeps nothing between
 * turns; each prompt carries the whole turn.
 */

import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { FAILURE_META_KEY, type FailureCode, TurnFailed } from "./backends/failure.ts";
import { type Backend, BackendRefused, type Refusal } from "./backends/types.ts";
import type { Bridge } from "./bridge.ts";
import { log } from "./log.ts";

/** The response key the runtime's driver reads each model call from. */
export const USAGE_META_KEY = "nimblebrain-subscription/usage";
/** The `initialize` key the runtime's driver reads the plan from, for the composer: "Claude Max". */
export const PLAN_META_KEY = "nimblebrain-subscription/plan";
export const AGENT_VERSION = "0.1.0";

interface Session {
  system?: string;
  mcpUrl: string;
  release(): void;
  turn?: AbortController;
}

/**
 * `plan` is the short name the sign-in check read at start ("Claude Max",
 * "ChatGPT"); the runtime shows it beside the CLI's name.
 */
export function createWorkerAgent(backend: Backend, bridge: Bridge, plan?: string): acp.AgentApp {
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
      ...(plan ? { _meta: { [PLAN_META_KEY]: plan } } : {}),
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
        const failure = turnFailure(err, backend.label);
        log(`turn failed (${failure.code}): ${failure.message}`);
        throw acp.RequestError.internalError(
          { [FAILURE_META_KEY]: { code: failure.code, message: failure.message } },
          `${backend.label} turn failed: ${failure.code}`,
        );
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

const REFUSAL_FAILURES: Record<Refusal, FailureCode> = {
  api_key: "api_key",
  not_signed_in: "signed_out",
  not_installed: "cli_missing",
  unreadable: "cli_failed",
};

/** Why the turn failed, as the runtime shows it: a backend's own class, else `cli_failed`. */
function turnFailure(err: unknown, label: string): { code: FailureCode; message: string } {
  if (err instanceof TurnFailed) return { code: err.code, message: err.message };
  if (err instanceof BackendRefused)
    return { code: REFUSAL_FAILURES[err.reason], message: err.message };
  return {
    code: "cli_failed",
    message: `${label} could not finish the turn. Check the agent worker's log, then send your message again.`,
  };
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
