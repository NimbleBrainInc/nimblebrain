import { describe, expect, it } from "bun:test";
import { localModelFromEnv } from "../../../src/config/local-model.ts";
import { providersFromEnv } from "../../../src/config/model-providers.ts";

describe("providersFromEnv", () => {
  it("configures no provider when the environment holds no key", () => {
    expect(providersFromEnv({}, {})).toEqual({});
  });

  it("configures each provider whose key the environment holds", () => {
    expect(providersFromEnv({}, { OPENAI_API_KEY: "sk-x" })).toEqual({ openai: {} });
    expect(
      providersFromEnv({}, { ANTHROPIC_API_KEY: "sk-ant-x", GOOGLE_GENERATIVE_AI_API_KEY: "g" }),
    ).toEqual({ anthropic: {}, google: {} });
  });

  it("ignores an empty key, as Compose passes an unset variable through", () => {
    expect(providersFromEnv({}, { ANTHROPIC_API_KEY: "", XAI_API_KEY: "  " })).toEqual({});
  });

  it("ignores a key that is not a model provider's", () => {
    expect(providersFromEnv({}, { POSTHOG_API_KEY: "phc_x", COMPOSIO_API_KEY: "c" })).toEqual({});
  });

  it("leaves a providers block in the file as the whole set", () => {
    const file = { providers: { local: { baseURL: "http://127.0.0.1:11434/v1" } } };
    expect(providersFromEnv(file, { ANTHROPIC_API_KEY: "sk-ant-stray" })).toBeUndefined();
  });

  it("leaves providers to the model gateway when there is one", () => {
    const config = { execution: { modelGateway: "http://gateway.example" } };
    expect(providersFromEnv(config, { ANTHROPIC_API_KEY: "sk-ant-x" })).toBeUndefined();
  });

  it("composes with a local model server the environment names", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-x",
      NB_LOCAL_MODEL_URL: "http://host.docker.internal:11434/v1",
      NB_LOCAL_MODEL: "nimblebrain-gemma4-e4b",
    };
    const providers = providersFromEnv({}, env);
    expect(Object.keys(localModelFromEnv({ providers }, env).providers ?? {})).toEqual([
      "anthropic",
      "local",
    ]);
    const localOnly = {
      NB_LOCAL_MODEL_URL: env.NB_LOCAL_MODEL_URL,
      NB_LOCAL_MODEL: env.NB_LOCAL_MODEL,
    };
    expect(
      Object.keys(
        localModelFromEnv({ providers: providersFromEnv({}, localOnly) }, localOnly).providers ??
          {},
      ),
    ).toEqual(["local"]);
  });
});
