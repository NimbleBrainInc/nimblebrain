import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type { EngineEvent } from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { AcpDriver, AcpSessionPlan } from "../../../src/execution/acp/driver.ts";
import {
  AGENT_MODEL_ERROR_KEY,
  AGENT_USAGE_META_KEY,
  createNimbleBrainAgentDriver,
} from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { MODEL_GATEWAY_BUDGET_ACCOUNT } from "../../../src/model/gateway-refusal.ts";
import {
  emptyLog,
  type ScriptedAgentOptions,
  scriptedConnection,
  scriptedDriver,
} from "../../helpers/acp/scripted-agent.ts";

// ACP's standard fields, which the generic runtime uses for any agent that
// advertises them: `systemPrompt` on `session/new`, and `providers/*` for the
// run's model access through the installation's gateway.

const GATEWAY = "http://model-gateway.test";

function resolvedRun(over: Partial<ResolvedRun> = {}): ResolvedRun {
  return {
    runId: "run_std",
    conversationId: null,
    system: "Be brief.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    config: {
      model: "anthropic:claude-sonnet-4-6",
      maxIterations: 3,
      maxInputTokens: 10_000,
      maxOutputTokens: 100,
    },
    modelCredential: "turn-jwt",
    ...over,
  };
}

const provider = (providerId: string, supported: string[], required = false): acp.ProviderInfo => ({
  providerId,
  supported,
  required,
  current: null,
});

async function execute(
  agent: Partial<ScriptedAgentOptions>,
  opts: { modelGateway?: string; driver?: AcpDriver; run?: Partial<ResolvedRun> } = {},
) {
  const log = emptyLog();
  const plans: AcpSessionPlan[] = [];
  const base = opts.driver ?? scriptedDriver();
  const driver: AcpDriver = {
    ...base,
    sessionMeta(run, plan) {
      plans.push(plan);
      return base.sessionMeta?.(run, plan) ?? {};
    },
  };
  const runtime = createAcpRuntime(
    "std",
    driver,
    scriptedConnection({ script: () => [{ text: "ok" }], log, ...agent }),
    opts.modelGateway ? { modelGateway: opts.modelGateway } : {},
  );
  const result = runtime.execute(resolvedRun(opts.run), {
    tools: new StaticToolRouter([], () => ({ content: [], isError: false })),
    events: { emit: () => {} },
    billSummary: () => {},
  });
  return { result, log, plans };
}

describe("systemPrompt", () => {
  test("goes in ACP's field, as override when the agent takes it, and out of the transcript", async () => {
    const { result, log, plans } = await execute({ systemPrompt: { override: true } });
    await result;
    expect(log.systemPrompts).toEqual([
      { mode: "override", content: [{ type: "text", text: "Be brief." }] },
    ]);
    expect(log.prompts[0]).not.toContain("Be brief.");
    expect(plans[0]?.delivered.systemPrompt).toBe(true);
  });

  test("is appended when the agent takes only append", async () => {
    const { result, log } = await execute({ systemPrompt: {} });
    await result;
    expect(log.systemPrompts[0]?.mode).toBe("append");
  });

  test("stays in the transcript for an agent that does not take it", async () => {
    const { result, log, plans } = await execute({});
    await result;
    expect(log.systemPrompts).toEqual([undefined]);
    expect(log.prompts[0]).toContain("Be brief.");
    expect(plans[0]?.delivered.systemPrompt).toBe(false);
  });
});

describe("providers", () => {
  const listed = [
    provider("anthropic", ["anthropic"]),
    provider("google", ["gemini"]),
    provider("mistral", ["openai"]),
  ];

  test("routes each provider the gateway serves to its path with the run's credential, and turns off the rest", async () => {
    const { result, log, plans } = await execute({ providers: listed }, { modelGateway: GATEWAY });
    await result;
    expect(log.providerCalls).toEqual([
      {
        method: "set",
        params: {
          providerId: "anthropic",
          apiType: "anthropic",
          baseUrl: `${GATEWAY}/anthropic/v1`,
          headers: { Authorization: "Bearer turn-jwt" },
        },
      },
      {
        method: "set",
        params: {
          providerId: "google",
          apiType: "gemini",
          baseUrl: `${GATEWAY}/google/v1beta`,
          headers: { Authorization: "Bearer turn-jwt" },
        },
      },
      { method: "disable", params: { providerId: "mistral" } },
    ]);
    expect(plans[0]?.delivered.modelAccess).toBe(true);
  });

  test("refuses the run when the agent requires a provider the gateway cannot serve", async () => {
    const { result } = await execute(
      { providers: [provider("mistral", ["openai"], true)] },
      { modelGateway: GATEWAY },
    );
    await expect(result).rejects.toThrow(/requires provider "mistral"/);
  });

  test("sets the protocol the gateway speaks at the provider's path, whatever the agent lists first", async () => {
    const { result, log } = await execute(
      { providers: [provider("google", ["openai", "gemini"])] },
      { modelGateway: GATEWAY },
    );
    await result;
    expect(log.providerCalls).toEqual([
      {
        method: "set",
        params: {
          providerId: "google",
          apiType: "gemini",
          baseUrl: `${GATEWAY}/google/v1beta`,
          headers: { Authorization: "Bearer turn-jwt" },
        },
      },
    ]);
  });

  test("turns off a served provider the agent cannot speak the gateway's protocol for, and refuses a required one", async () => {
    const optional = await execute(
      { providers: [provider("google", ["openai"])] },
      { modelGateway: GATEWAY },
    );
    await optional.result;
    expect(optional.log.providerCalls).toEqual([
      { method: "disable", params: { providerId: "google" } },
    ]);
    const required = await execute(
      { providers: [provider("google", ["vertex"], true)] },
      { modelGateway: GATEWAY },
    );
    await expect(required.result).rejects.toThrow(/requires provider "google"/);
  });

  test("is left alone without a gateway or a credential", async () => {
    const noGateway = await execute({ providers: listed });
    await noGateway.result;
    const noCredential = await execute(
      { providers: listed },
      { modelGateway: GATEWAY, run: { modelCredential: undefined } },
    );
    await noCredential.result;
    expect([...noGateway.log.providerCalls, ...noCredential.log.providerCalls]).toEqual([]);
    expect(noGateway.plans[0]?.delivered.modelAccess).toBe(false);
  });
});

describe("a model call the gateway refused for a spent run budget", () => {
  /** nimblebrain-agent's error for a turn whose second model call was refused. */
  const refused =
    (status = 429, reason = "rate limit exceeded") =>
    () =>
      new RequestError(
        -32603,
        `Internal error: model call failed with status ${status}: ${reason}`,
        {
          [AGENT_MODEL_ERROR_KEY]: { status, reason },
          [AGENT_USAGE_META_KEY]: {
            calls: [
              {
                model: "anthropic:claude-sonnet-4-6",
                purpose: "turn",
                usage: { inputTokens: 900, outputTokens: 40 },
              },
            ],
            total: { inputTokens: 900, outputTokens: 40 },
          },
        },
      );

  async function refusedTurn(failTurn: () => unknown, modelGateway: string | undefined) {
    const events: EngineEvent[] = [];
    const runtime = createAcpRuntime(
      "std",
      createNimbleBrainAgentDriver(),
      scriptedConnection({
        script: () => [{ text: "Looking it up." }],
        providers: [provider("anthropic", ["anthropic"])],
        failTurn,
      }),
      modelGateway ? { modelGateway } : {},
    );
    const result = runtime.execute(resolvedRun(), {
      tools: new StaticToolRouter([], () => ({ content: [], isError: false })),
      events: { emit: (e) => events.push(e) },
      billSummary: () => {},
    });
    return { result, events };
  }

  test("ends the run with spend_limit, recording the calls made before it", async () => {
    const { result, events } = await refusedTurn(refused(), GATEWAY);
    const r = await result;
    expect(r.stopReason).toBe("spend_limit");
    expect(r.spendAccountId).toBe(MODEL_GATEWAY_BUDGET_ACCOUNT);
    expect(r.usage).toMatchObject({ inputTokens: 900, outputTokens: 40 });
    expect(r.output).toBe("Looking it up.");
    expect(events.map((e) => e.type)).not.toContain("run.error");
    expect(events.find((e) => e.type === "run.done")?.data.stopReason).toBe("spend_limit");
    const priced = events.flatMap((e) =>
      e.type === "llm.done" && !e.data.transcriptOnly ? [e.data.usage] : [],
    );
    expect(priced).toEqual([{ inputTokens: 900, outputTokens: 40 }]);
  });

  test("is a run error when the agent's model access did not go to the gateway", async () => {
    const { result, events } = await refusedTurn(refused(), undefined);
    await expect(result).rejects.toThrow("model call failed with status 429");
    expect(events.map((e) => e.type)).toContain("run.error");
  });

  test("leaves a provider's own 429 through the gateway a run error", async () => {
    const { result } = await refusedTurn(refused(429, '{"type":"rate_limit_error"}'), GATEWAY);
    await expect(result).rejects.toThrow("model call failed with status 429");
  });
});
