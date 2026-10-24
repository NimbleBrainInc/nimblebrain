import { describe, expect, test } from "bun:test";
import type { GooseRuntimeConfig } from "../../../src/config/execution.ts";
import {
  createGooseDriver,
  GOOSE_SYSTEM_PROMPT_METHOD,
  gooseEnvironment,
  rawTemplate,
} from "../../../src/execution/acp/drivers/goose.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";

const CONFIG: GooseRuntimeConfig = { type: "acp", driver: "goose" };

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
      gooseEnvironment(CONFIG, run("nebius:some/model"), { NB_GOOSE_API_KEY: "k" }),
    ).toThrow(/no key mapping/);
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
  const driver = createGooseDriver(CONFIG, { env: { NB_GOOSE_API_KEY: "k" }, which: () => null });

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
    await expect(driver.open(run())).rejects.toThrow(/not found/);
  });
});
