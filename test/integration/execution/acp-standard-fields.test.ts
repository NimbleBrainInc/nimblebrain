import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { AcpDriver, AcpSessionPlan } from "../../../src/execution/acp/driver.ts";
import { agentSessionMeta } from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
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

describe("the nimblebrain-agent driver beside the standard fields", () => {
  test("leaves the system prompt and model access out of its options when they went by ACP", () => {
    const run = resolvedRun();
    const both = agentSessionMeta(run, GATEWAY, { systemPrompt: true, modelAccess: true });
    const neither = agentSessionMeta(run, GATEWAY);
    const options = (meta: Record<string, unknown>) =>
      meta["nimblebrain-agent/session"] as Record<string, unknown>;
    expect(options(both)).not.toHaveProperty("system");
    expect(options(both)).not.toHaveProperty("modelCredential");
    expect(options(neither)).toMatchObject({ system: "Be brief.", modelCredential: "turn-jwt" });
  });
});
