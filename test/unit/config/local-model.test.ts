import { describe, expect, it } from "bun:test";
import { localModelFromEnv } from "../../../src/config/local-model.ts";

const env = {
  NB_LOCAL_MODEL_URL: "http://host.docker.internal:11434/v1",
  NB_LOCAL_MODEL: "nimblebrain-gemma4-e4b",
  NB_LOCAL_MODEL_CONTEXT: "32768",
};

describe("localModelFromEnv", () => {
  it("adds nothing when no local server is named", () => {
    expect(localModelFromEnv({}, {})).toEqual({});
  });

  it("builds providers.local and points both slots at the model", () => {
    expect(localModelFromEnv({}, env)).toEqual({
      providers: {
        local: {
          baseURL: "http://host.docker.internal:11434/v1",
          models: ["nimblebrain-gemma4-e4b"],
          contextWindow: 32_768,
        },
      },
      models: { default: "local:nimblebrain-gemma4-e4b", fast: "local:nimblebrain-gemma4-e4b" },
    });
  });

  it("adds no hosted provider of its own, whatever keys the environment holds", () => {
    const withKey = localModelFromEnv({}, { ...env, ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(Object.keys(withKey.providers ?? {})).toEqual(["local"]);
  });

  it("keeps a providers.local block and a default model the file sets", () => {
    const file = {
      providers: { local: { baseURL: "http://gpu-box:8000/v1", models: ["qwen3:8b"] } },
      models: { default: "local:qwen3:8b" },
    };
    const result = localModelFromEnv(file, env);
    expect(result.providers).toEqual(file.providers);
    expect(result.models).toEqual({
      default: "local:qwen3:8b",
      fast: "local:nimblebrain-gemma4-e4b",
    });
  });

  it("fills each model slot the file leaves unset", () => {
    expect(localModelFromEnv({ models: { fast: "local:qwen3:8b" } }, env).models).toEqual({
      default: "local:nimblebrain-gemma4-e4b",
      fast: "local:qwen3:8b",
    });
    const both = { default: "local:a", fast: "local:b" };
    expect(localModelFromEnv({ models: both }, env).models).toEqual(both);
  });

  it("adds the local server beside the file's providers", () => {
    const result = localModelFromEnv({ providers: { openai: {} } }, env);
    expect(Object.keys(result.providers ?? {})).toEqual(["openai", "local"]);
  });

  it("refuses a server with no model, or a window that is not a positive integer", () => {
    expect(() => localModelFromEnv({}, { NB_LOCAL_MODEL_URL: env.NB_LOCAL_MODEL_URL })).toThrow(
      /NB_LOCAL_MODEL is not/,
    );
    expect(() => localModelFromEnv({}, { ...env, NB_LOCAL_MODEL_CONTEXT: "lots" })).toThrow(
      /positive integer/,
    );
  });
});
