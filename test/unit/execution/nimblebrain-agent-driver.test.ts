import { describe, expect, test } from "bun:test";
import { createNimbleBrainAgentDriver } from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import {
  AGENT_SESSION_META_KEY,
  AGENT_STOP_REASON_META_KEY,
  AGENT_USAGE_META_KEY,
  agentCommand,
  agentEnvironment,
  agentOutcome,
  encodeHistory,
} from "../../helpers/acp/nimblebrain-agent-driver.ts";

/** Nothing went by ACP's standard fields: the driver delivers everything itself. */
const NOTHING_DELIVERED = { systemPrompt: false, modelAccess: false };

function run(model = "anthropic:claude-sonnet-4-6"): ResolvedRun {
  return {
    runId: "run_r",
    conversationId: null,
    system: "Be brief.",
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ],
    tools: [],
    config: { model, maxIterations: 7, maxInputTokens: 1000, maxOutputTokens: 100 },
  };
}

describe("nimblebrain-agent driver", () => {
  test("hands the child its model and one key, nothing of this process", () => {
    const env = agentEnvironment({ command: "nimblebrain-agent" }, run(), {
      NB_AGENT_API_KEY: "sk-agent",
      ANTHROPIC_API_KEY: "sk-runtime-own",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NB_AGENT_MODEL: "anthropic:claude-sonnet-4-6",
      ANTHROPIC_API_KEY: "sk-agent",
    });
    expect(() =>
      agentEnvironment({ command: "nimblebrain-agent" }, run(), { ANTHROPIC_API_KEY: "x" }),
    ).toThrow(/NB_AGENT_API_KEY/);
  });

  test("points the child's provider at the configured model endpoint", () => {
    const keys = { NB_AGENT_API_KEY: "k" };
    const endpoint = "http://127.0.0.1:1/v1";
    expect(agentEnvironment({ modelEndpoint: endpoint }, run(), keys).ANTHROPIC_BASE_URL).toBe(
      endpoint,
    );
    expect(
      agentEnvironment({ modelEndpoint: endpoint }, run("openai:gpt-5"), keys).OPENAI_BASE_URL,
    ).toBe(endpoint);
    expect(agentEnvironment({}, run(), keys)).not.toHaveProperty("ANTHROPIC_BASE_URL");
  });

  test("runs the pinned dev dependency's entry unless given a command", () => {
    expect(agentCommand({})).toEndWith("/node_modules/nimblebrain-agent/src/cli.ts");
    expect(agentCommand({ command: "/opt/agent/src/cli.ts" })).toBe("/opt/agent/src/cli.ts");
  });

  test("sends the door's prompt, prior history and limits as nimblebrain-agent's session options", () => {
    const driver = createNimbleBrainAgentDriver();
    expect(driver.toolSurface).toBe("projection");
    const meta = driver.sessionMeta?.(run(), { mcpServers: [], delivered: NOTHING_DELIVERED });
    expect(meta).toEqual({
      [AGENT_SESSION_META_KEY]: {
        system: "Be brief.",
        history: encodeHistory(run().messages.slice(0, 2)),
        model: "anthropic:claude-sonnet-4-6",
        maxIterations: 7,
        maxInputTokens: 1000,
        maxOutputTokens: 100,
        compaction: false,
      },
    });
    expect(driver.prompt?.(run())).toEqual([{ type: "text", text: "now" }]);
  });

  test("takes the turn's model credential per session, and sends it beside the gateway only", () => {
    const gateway = "http://model-gateway.test";
    const minted = { ...run(), modelCredential: "turn-jwt" };
    const meta = (driver: ReturnType<typeof createNimbleBrainAgentDriver>, r: ResolvedRun) =>
      driver.sessionMeta?.(r, { mcpServers: [], delivered: NOTHING_DELIVERED })?.[
        AGENT_SESSION_META_KEY
      ];

    const gated = createNimbleBrainAgentDriver({ modelGateway: gateway });
    expect(gated.capabilities).toEqual({ spendGate: false, modelCredential: "session" });
    // The endpoint is the session model's provider on the gateway.
    expect(meta(gated, minted)).toMatchObject({
      modelCredential: "turn-jwt",
      modelEndpoint: "http://model-gateway.test/anthropic/v1",
    });
    // Every provider's base URL, so a summary on another provider's model reaches it.
    expect(meta(gated, minted)).toMatchObject({
      modelEndpoints: {
        anthropic: "http://model-gateway.test/anthropic/v1",
        openai: "http://model-gateway.test/openai/v1",
        google: "http://model-gateway.test/google/v1beta",
        xai: "http://model-gateway.test/xai/v1",
        nebius: "http://model-gateway.test/nebius/v1",
        greenpt: "http://model-gateway.test/greenpt/v1",
      },
    });
    const onGoogle = { ...minted, config: { ...minted.config, model: "google:gemini-3-pro" } };
    expect(meta(gated, onGoogle)).toMatchObject({
      modelEndpoint: "http://model-gateway.test/google/v1beta",
    });
    // No gateway: the worker calls its own provider, so the credential stays home.
    expect(meta(createNimbleBrainAgentDriver(), minted)).not.toHaveProperty("modelCredential");
    // No credential: the agent refuses an endpoint without one, so none is sent.
    expect(meta(gated, run())).not.toHaveProperty("modelEndpoint");
    expect(meta(gated, run())).not.toHaveProperty("modelEndpoints");
  });

  test("lets the agent fold mid-turn only when the door allows it, with the door's model", () => {
    const driver = createNimbleBrainAgentDriver();
    const allowed = { ...run(), compaction: { model: "anthropic:claude-haiku-4-5" } };
    const meta = driver.sessionMeta?.(allowed, { mcpServers: [], delivered: NOTHING_DELIVERED })?.[
      AGENT_SESSION_META_KEY
    ];
    expect(meta).toMatchObject({ compaction: { model: "anthropic:claude-haiku-4-5" } });
  });

  test("reads the agent's stop reason and model calls, dropping what it does not recognize", () => {
    const usage = { inputTokens: 10, outputTokens: 2, cacheWrite1hTokens: 4 };
    expect(
      agentOutcome({
        _meta: {
          [AGENT_STOP_REASON_META_KEY]: "max_input_tokens",
          [AGENT_USAGE_META_KEY]: {
            calls: [
              { model: "m", purpose: "turn", usage },
              { model: "f", purpose: "summary", usage },
              { model: "m", purpose: "other", usage },
            ],
            total: usage,
          },
        },
      }),
    ).toEqual({
      stopReason: "max_input_tokens",
      calls: [
        { model: "m", purpose: "turn", usage },
        { model: "f", purpose: "summary", usage },
      ],
    });
    expect(agentOutcome({ _meta: { [AGENT_STOP_REASON_META_KEY]: "nope" } })).toEqual({});
    expect(agentOutcome({})).toEqual({});
  });

  test("encodes file bytes in nimblebrain-agent's documented form", () => {
    const encoded = encodeHistory([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: new Uint8Array([1, 2]) },
          },
        ],
      },
    ]);
    expect(encoded).toContain('{"__nb_agent_bytes":"AQI="}');
  });
});
