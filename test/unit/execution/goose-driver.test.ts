import { describe, expect, test } from "bun:test";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import {
  createGooseDriver,
  GOOSE_SYSTEM_PROMPT_METHOD,
  type GooseDriverConfig,
  gooseConnection,
  gooseEnvironment,
  rawTemplate,
} from "../../helpers/acp/goose-driver.ts";

const CONFIG: GooseDriverConfig = {};

function run(model = "anthropic:claude-sonnet-4-6"): ResolvedRun {
  return {
    runId: "run_g",
    conversationId: null,
    system: "Be brief.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    config: { model, maxIterations: 7, maxInputTokens: 1000, maxOutputTokens: 100 },
  };
}

describe("goose environment", () => {
  test("names the run's provider, model and key, and nothing of the host's", () => {
    const env = gooseEnvironment(CONFIG, run(), {
      NB_GOOSE_API_KEY: "sk-goose",
      ANTHROPIC_API_KEY: "sk-runtime-own",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GOOSE_PROVIDER: "anthropic",
      GOOSE_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_API_KEY: "sk-goose",
      GOOSE_MODE: "auto",
      GOOSE_MAX_TURNS: "7",
      GOOSE_DISABLE_KEYRING: "1",
      GOOSE_TELEMETRY_OFF: "1",
    });
  });

  test("reads the key from the configured variable, never the runtime's own", () => {
    const env = gooseEnvironment(
      { ...CONFIG, apiKeyEnv: "GOOSE_TEST_KEY", mode: "approve" },
      run(),
      {
        GOOSE_TEST_KEY: "sk-test",
      },
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.GOOSE_MODE).toBe("approve");
    expect(() => gooseEnvironment(CONFIG, run(), { ANTHROPIC_API_KEY: "sk-runtime-own" })).toThrow(
      /NB_GOOSE_API_KEY/,
    );
  });

  test("maps the provider's key variable, and refuses a provider it cannot key", () => {
    expect(gooseEnvironment(CONFIG, run("openai:gpt-5"), { NB_GOOSE_API_KEY: "k" })).toMatchObject({
      GOOSE_PROVIDER: "openai",
      GOOSE_MODEL: "gpt-5",
      OPENAI_API_KEY: "k",
    });
    expect(() =>
      gooseEnvironment(CONFIG, run("mistral:some-model"), { NB_GOOSE_API_KEY: "k" }),
    ).toThrow(/no key mapping/);
  });

  test("runs an OpenAI-compatible provider as Goose's OpenAI provider at its own host", () => {
    expect(
      gooseEnvironment(CONFIG, run("nebius:Qwen/Qwen3-235B-A22B-Instruct-2507"), {
        NB_GOOSE_API_KEY: "k",
      }),
    ).toMatchObject({
      GOOSE_PROVIDER: "openai",
      GOOSE_MODEL: "Qwen/Qwen3-235B-A22B-Instruct-2507",
      OPENAI_API_KEY: "k",
      OPENAI_HOST: "https://api.tokenfactory.nebius.com/v1",
    });
  });

  test("points each provider at its path on the gateway, with the key the gateway takes", () => {
    const gateway = "http://model-gateway.test/";
    const cases: [string, Record<string, string>][] = [
      [
        "anthropic:claude-sonnet-4-6",
        { ANTHROPIC_HOST: "http://model-gateway.test/anthropic", ANTHROPIC_API_KEY: "run-token" },
      ],
      [
        "openai:gpt-5",
        { OPENAI_HOST: "http://model-gateway.test/openai/v1", OPENAI_API_KEY: "run-token" },
      ],
      [
        "google:gemini-3-pro",
        { GOOGLE_HOST: "http://model-gateway.test/google", GOOGLE_API_KEY: "run-token" },
      ],
      ["xai:grok-4", { XAI_HOST: "http://model-gateway.test/xai/v1", XAI_API_KEY: "run-token" }],
      [
        "nebius:some/model",
        { GOOSE_PROVIDER: "openai", OPENAI_HOST: "http://model-gateway.test/nebius/v1" },
      ],
      [
        "greenpt:gpt-oss-120b",
        { GOOSE_PROVIDER: "openai", OPENAI_HOST: "http://model-gateway.test/greenpt/v1" },
      ],
    ];
    for (const [model, expected] of cases) {
      const env = gooseEnvironment({ ...CONFIG, modelGateway: gateway }, run(model), {
        NB_GOOSE_API_KEY: "run-token",
      });
      expect(env).toMatchObject(expected);
    }
  });
});

describe("raw template", () => {
  test("wraps text so Goose's template engine leaves it as written", () => {
    expect(rawTemplate("Use {{ name }} and {% if x %}")).toBe(
      "{% raw %}Use {{ name }} and {% if x %}{% endraw %}",
    );
  });

  test("a literal endraw cannot close the block early", () => {
    const wrapped = rawTemplate("a {% endraw %} b {%- endraw -%} c");
    expect(wrapped).toBe(
      '{% raw %}a {% endraw %}{{ "{% endraw %}" }}{% raw %} b {% endraw %}{{ "{%- endraw -%}" }}{% raw %} c{% endraw %}',
    );
  });
});

describe("goose driver", () => {
  const driver = createGooseDriver();

  test("configures Goose with the projection as its whole tool surface", () => {
    const server = {
      type: "http" as const,
      name: "nimblebrain",
      url: "http://127.0.0.1:1/x",
      headers: [],
    };
    expect(driver.toolSurface).toBe("projection");
    expect(driver.sessionMeta?.(run(), { mcpServers: [server] })).toEqual({
      enabledExtensions: [{ type: "mcp", server }],
    });
  });

  test("replaces Goose's system prompt with the door's, raw", async () => {
    const calls: [string, unknown][] = [];
    await driver.prepareSession?.(
      { request: async (method, params) => void calls.push([method, params]) },
      "s1",
      run(),
    );
    expect(calls).toEqual([
      [
        GOOSE_SYSTEM_PROMPT_METHOD,
        { sessionId: "s1", mode: "set", text: "{% raw %}Be brief.{% endraw %}" },
      ],
    ]);
  });

  test("opens the turn with the history and message, not the system prompt", () => {
    const prompt = driver.prompt?.(run()) ?? [];
    expect(prompt).toEqual([{ type: "text", text: "hi" }]);
  });

  test("fails before spawning when the binary is not found", async () => {
    const connection = gooseConnection(CONFIG, {
      env: { NB_GOOSE_API_KEY: "k" },
      which: () => null,
    });
    await expect(connection.open(run())).rejects.toThrow(/not found/);
  });
});
