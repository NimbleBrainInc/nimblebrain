/**
 * Any ACP agent as an agent runtime.
 *
 * One run is one connection and one session: the door owns the conversation,
 * so every execution opens a fresh session from the history it hands over and
 * no agent-side session is the record of anything. The steps:
 *
 *   1. Open the run's tool projection, the only way the agent reaches tools.
 *   2. Open a connection through the driver, and negotiate: the agent must
 *      take HTTP MCP servers, since that is how it is given the projection.
 *   3. `session/new` naming the projection, then the driver's own preparation.
 *   4. `session/prompt`, recording every update in the engine's vocabulary
 *      (`./run-recorder.ts`), until the agent answers.
 *   5. Close the connection, the projection, and whatever the driver started,
 *      whatever happened.
 *
 * The client advertises no filesystem and no terminal, so an agent cannot ask
 * this process to read, write, or run anything. It answers a permission
 * request with an allow only for a NimbleBrain tool the projection serves,
 * which re-checks the call anyway; anything else is rejected.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import type { EngineResult } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import { openToolProjection, type ToolProjection } from "../tool-projection.ts";
import type { AgentRuntime, ResolvedRun, RunIO } from "../types.ts";
import type { AcpDriver, AcpOutcome } from "./driver.ts";
import { type AcpRunRecorder, createAcpRunRecorder } from "./run-recorder.ts";
import { transcriptPrompt } from "./transcript.ts";

/** The name an agent sees NimbleBrain's tools under. */
export const PROJECTION_SERVER_NAME = "nimblebrain";

export function createAcpRuntime(id: string, driver: AcpDriver): AgentRuntime {
  return {
    id,
    capabilities: driver.capabilities ?? { spendGate: false },
    execute: (run, io) => executeOverAcp(id, driver, run, io),
  };
}

async function executeOverAcp(
  runtimeId: string,
  driver: AcpDriver,
  run: ResolvedRun,
  io: RunIO,
): Promise<EngineResult> {
  const signal = run.config.signal;
  const recorder = createAcpRunRecorder(run, io);
  recorder.start();

  const cleanup: (() => Promise<void>)[] = [];
  try {
    signal?.throwIfAborted();
    const turn = await openSession(runtimeId, driver, run, io, recorder, cleanup);
    // An abort during setup fired before the listener below exists.
    signal?.throwIfAborted();
    const cancel = () => {
      void turn.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: turn.sessionId })
        .catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    cleanup.push(async () => signal?.removeEventListener("abort", cancel));

    const response = await turn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: turn.sessionId,
      prompt: driver.prompt?.(run) ?? transcriptPrompt(run),
    });
    if (response.stopReason === "cancelled" || signal?.aborted) {
      recorder.cancelled();
      throw signal?.reason ?? new DOMException("The agent cancelled the turn", "AbortError");
    }
    return recorder.finish(response, outcomeOf(driver, response), turn.projection.calls());
  } catch (err) {
    if (!recorder.ended()) {
      if (signal?.aborted) recorder.cancelled();
      else recorder.failed(err);
    }
    throw signal?.aborted ? (signal.reason ?? err) : err;
  } finally {
    for (const step of cleanup.reverse()) {
      await step().catch((err) =>
        log.warn(`[execution] ACP cleanup failed: ${String(err)}`, { runId: run.runId }),
      );
    }
  }
}

/** What the driver read from its agent's response, or nothing for a driver that reads none. */
function outcomeOf(driver: AcpDriver, response: acp.PromptResponse): AcpOutcome {
  return driver.outcome?.(response) ?? {};
}

/**
 * Steps 1 to 3: the projection, the connection, negotiation and the session.
 * Each thing opened pushes its own close onto `cleanup`, so a failure at any
 * step closes exactly what was opened before it.
 */
async function openSession(
  runtimeId: string,
  driver: AcpDriver,
  run: ResolvedRun,
  io: RunIO,
  recorder: AcpRunRecorder,
  cleanup: (() => Promise<void>)[],
): Promise<{ agent: acp.ClientContext; sessionId: string; projection: ToolProjection }> {
  const projection = await openToolProjection({
    runId: run.runId,
    router: io.tools,
    events: io.events,
    signal: run.config.signal,
    maxToolResultSize: run.config.maxToolResultSize,
    ...(run.config.hooks ? { hooks: run.config.hooks } : {}),
    skills: {
      candidates: run.config.connectorSkillCandidates ?? [],
      delivered: run.config.alreadyInjectedConnectorSkills ?? [],
    },
    observer: recorder,
  });
  cleanup.push(() => projection.close());
  const projected = new Set((await io.tools.availableTools()).map((t) => t.name));

  const opened = await driver.open(run);
  cleanup.push(() => opened.close());
  const app = clientApp(recorder, driver.toolSurface, projected);
  const connection =
    opened.target instanceof acp.AgentApp ? app.connect(opened.target) : app.connect(opened.target);
  cleanup.push(async () => connection.close());
  const agent = connection.agent;

  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "nimblebrain", version: "1" },
  });
  if (!init.agentCapabilities?.mcpCapabilities?.http) {
    throw new Error(`ACP agent ${driver.id} does not accept HTTP MCP servers`);
  }

  const mcpServers: acp.McpServer[] = [
    {
      type: "http",
      name: PROJECTION_SERVER_NAME,
      url: projection.url,
      headers: projection.headers,
    },
  ];
  const sessionMeta = driver.sessionMeta?.(run, { mcpServers });
  const newSession: acp.NewSessionRequest = {
    cwd: opened.cwd,
    mcpServers,
    ...(sessionMeta ? { _meta: sessionMeta } : {}),
  };
  const { sessionId } = await agent.request(acp.methods.agent.session.new, newSession);
  io.events.emit({
    type: "execution.bound",
    data: { runId: run.runId, runtime: runtimeId, runtimeSessionId: sessionId },
  });
  await driver.prepareSession?.(
    { request: (method, params) => agent.request(method, params) },
    sessionId,
    run,
  );
  return { agent, sessionId, projection };
}

function clientApp(
  recorder: AcpRunRecorder,
  toolSurface: AcpDriver["toolSurface"],
  projected: Set<string>,
): acp.ClientApp {
  return acp
    .client({ name: "nimblebrain" })
    .onNotification(acp.methods.client.session.update, (ctx) => recorder.update(ctx.params.update))
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const allow =
        toolSurface === "projection" || isProjectedToolCall(ctx.params.toolCall, projected);
      log.debug("execution", `[acp] permission ${allow ? "allowed" : "rejected"}`, {
        toolCallId: ctx.params.toolCall.toolCallId,
      });
      const option = ctx.params.options.find((o) =>
        allow ? o.kind === "allow_once" : o.kind === "reject_once",
      );
      if (!option) return { outcome: { outcome: "cancelled" as const } };
      return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
    });
}

/**
 * Whether a permission request's title names a tool the projection serves: the
 * tool's name, or the name after a separator (agents prefix a server name).
 * Best effort, for an agent that has tools of its own: ACP names a tool call
 * only by a free-text title.
 */
function isProjectedToolCall(toolCall: acp.ToolCallUpdate, projected: Set<string>): boolean {
  const title = toolCall.title ?? "";
  for (const name of projected) {
    if (title === name || title.endsWith(`__${name}`) || title.endsWith(`/${name}`)) return true;
  }
  return false;
}
