/**
 * Any ACP agent as an agent runtime.
 *
 * One run is one connection and one session: the door owns the conversation,
 * so every execution opens a fresh session from the history it hands over and
 * no agent-side session is the record of anything. The steps:
 *
 *   1. Open the run's tool projection, the only way the agent reaches tools.
 *   2. Open the connection, and negotiate how the agent is given the
 *      projection: on this connection, as an `acp` MCP server, when the agent
 *      takes one (`./mcp-over-acp.ts`), so nothing listens; on loopback when
 *      it takes only HTTP MCP servers and runs on this host.
 *   3. `session/new` naming the projection, then the driver's own preparation.
 *   4. `session/prompt`, recording every update in the engine's vocabulary
 *      (`./run-recorder.ts`), until the agent answers.
 *   5. Close the connection, the projection, and whatever the connection
 *      started, whatever happened.
 *
 * The client advertises no filesystem and no terminal, so an agent cannot ask
 * this process to read, write, or run anything. It answers a permission
 * request with an allow only for a NimbleBrain tool the projection serves,
 * which re-checks the call anyway; anything else is rejected.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import type { EngineResult } from "../../engine/types.ts";
import {
  isGatewayBudgetRefusal,
  MODEL_GATEWAY_BUDGET_ACCOUNT,
} from "../../model/gateway-refusal.ts";
import { log } from "../../observability/log.ts";
import { openToolProjection, type ToolProjection } from "../tool-projection.ts";
import type { AgentRuntime, ResolvedRun, RunIO } from "../types.ts";
import type {
  AcpConnection,
  AcpDriver,
  AcpModelFailure,
  AcpOutcome,
  AcpStandardDelivery,
} from "./driver.ts";
import { type AcpMcpServers, createAcpMcpServers } from "./mcp-over-acp.ts";
import { type AcpRunRecorder, createAcpRunRecorder } from "./run-recorder.ts";
import { delivered, deliverModelAccess, standardSystemPrompt } from "./standard-fields.ts";
import { historyPrompt, transcriptPrompt } from "./transcript.ts";

/** The name an agent sees NimbleBrain's tools under. */
export const PROJECTION_SERVER_NAME = "nimblebrain";

export interface AcpRuntimeOptions {
  /** The installation's model gateway (`execution.modelGateway`), where an agent's calls go. */
  modelGateway?: string;
}

export function createAcpRuntime(
  id: string,
  driver: AcpDriver,
  connection: AcpConnection,
  opts: AcpRuntimeOptions = {},
): AgentRuntime {
  return {
    id,
    // An agent with its own loop counts its own model calls, whatever its driver.
    capabilities: { spendGate: false, ...driver.capabilities, usage: "reported" },
    execute: (run, io) => executeOverAcp(id, driver, connection, opts, run, io),
  };
}

async function executeOverAcp(
  runtimeId: string,
  driver: AcpDriver,
  connection: AcpConnection,
  opts: AcpRuntimeOptions,
  run: ResolvedRun,
  io: RunIO,
): Promise<EngineResult> {
  const signal = run.config.signal;
  const recorder = createAcpRunRecorder(run, io);
  recorder.start();

  const cleanup: (() => Promise<void>)[] = [];
  try {
    signal?.throwIfAborted();
    const turn = await openSession(runtimeId, driver, connection, opts, run, io, recorder, cleanup);
    // An abort during setup fired before the listener below exists.
    signal?.throwIfAborted();
    const cancel = () => {
      void turn.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: turn.sessionId })
        .catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    cleanup.push(async () => signal?.removeEventListener("abort", cancel));

    const response = await turn.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: turn.sessionId,
        prompt: turnPrompt(driver, run, turn.delivered),
      })
      .catch((err: unknown) => {
        const spent = signal?.aborted ? undefined : budgetRefusal(driver, turn.delivered, err);
        if (!spent) throw err;
        log.warn(
          "[execution] the model gateway refused the agent's call: the run's budget is spent",
          {
            runId: run.runId,
          },
        );
        return spent;
      });
    if ("outcome" in response) {
      return recorder.stopped(
        { stopReason: "spend_limit", spendAccountId: MODEL_GATEWAY_BUDGET_ACCOUNT },
        response.outcome,
        turn.projection.calls(),
      );
    }
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

/**
 * The prompt that opens the turn: the driver's, else the transcript, without the
 * system prompt when it went by ACP's own field.
 */
function turnPrompt(
  driver: AcpDriver,
  run: ResolvedRun,
  delivered: AcpStandardDelivery,
): acp.ContentBlock[] {
  return (
    driver.prompt?.(run) ?? (delivered.systemPrompt ? historyPrompt(run) : transcriptPrompt(run))
  );
}

/**
 * The agent's report of a model call the gateway refused because the run's
 * budget is spent, read from its `session/prompt` error by its driver. Only
 * when the run's model access went to the installation's gateway: an agent
 * on its own provider key may hear the same words for a limit that clears.
 */
function budgetRefusal(
  driver: AcpDriver,
  delivered: AcpStandardDelivery,
  err: unknown,
): AcpModelFailure | undefined {
  if (!delivered.modelAccess) return undefined;
  const failure = driver.modelFailure?.(err);
  return failure && isGatewayBudgetRefusal(failure.status, failure.reason) ? failure : undefined;
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
  agentConnection: AcpConnection,
  opts: AcpRuntimeOptions,
  run: ResolvedRun,
  io: RunIO,
  recorder: AcpRunRecorder,
  cleanup: (() => Promise<void>)[],
): Promise<{
  agent: acp.ClientContext;
  sessionId: string;
  projection: ToolProjection;
  delivered: AcpStandardDelivery;
}> {
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

  const opened = await agentConnection.open(run);
  cleanup.push(() => opened.close());
  const acpServers = createAcpMcpServers();
  const app = acpServers.serve(clientApp(recorder, driver.toolSurface, projected));
  const connection =
    opened.target instanceof acp.AgentApp ? app.connect(opened.target) : app.connect(opened.target);
  cleanup.push(async () => connection.close());
  const agent = connection.agent;

  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "nimblebrain", version: "1" },
  });
  const mcpServers = [
    projectionServer(
      runtimeId,
      init.agentCapabilities?.mcpCapabilities,
      opened.sameHost,
      projection,
      acpServers,
    ),
  ];
  const capabilities = init.agentCapabilities;
  const systemPrompt = standardSystemPrompt(capabilities, run);
  const modelAccess = await deliverModelAccess(agent, capabilities, run, opts.modelGateway);
  const sent = delivered(systemPrompt, modelAccess);
  const sessionMeta = driver.sessionMeta?.(run, { mcpServers, delivered: sent });
  const newSession: acp.NewSessionRequest = {
    cwd: opened.cwd,
    mcpServers,
    ...(systemPrompt ? { systemPrompt } : {}),
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
  return { agent, sessionId, projection, delivered: sent };
}

/**
 * How the agent reaches the projection: on its own connection when it takes
 * `acp` MCP servers, so nothing listens; on loopback when it takes only HTTP
 * and runs on this host. An agent elsewhere cannot reach this host's loopback,
 * so one without `acp` is refused: it runs behind the bridge (ADR-0057).
 */
function projectionServer(
  runtimeId: string,
  mcp: acp.McpCapabilities | null | undefined,
  sameHost: boolean,
  projection: ToolProjection,
  acpServers: AcpMcpServers,
): acp.McpServer {
  if (mcp?.acp) return acpServers.declare(PROJECTION_SERVER_NAME, projection.channel());
  if (mcp?.http && sameHost) {
    return { type: "http", name: PROJECTION_SERVER_NAME, ...projection.listen() };
  }
  if (mcp?.http) {
    throw new Error(
      `ACP agent ${runtimeId} takes no acp MCP server and is not on this host: it must run behind the bridge`,
    );
  }
  throw new Error(`ACP agent ${runtimeId} takes neither acp nor HTTP MCP servers`);
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
