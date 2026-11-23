import { describe, expect, it } from "bun:test";
import { providersFromEnv } from "../../src/config/model-providers.ts";
import { getModel } from "../../src/model/catalog.ts";
import {
  defaultModelFor,
  FALLBACK_DEFAULT_MODEL,
  PROVIDER_DEFAULT_MODEL,
} from "../../src/model/default-model.ts";
import { MODEL_PROVIDER_KEY_ENV, MODEL_PROVIDERS } from "../../src/model/registry.ts";

describe("defaultModelFor", () => {
  it("names each hosted provider's default for an install keyed for that provider alone", () => {
    for (const id of MODEL_PROVIDERS) {
      const providers = providersFromEnv({}, { [MODEL_PROVIDER_KEY_ENV[id]]: "key" }) ?? {};
      expect(defaultModelFor(providers)).toBe(`${id}:${PROVIDER_DEFAULT_MODEL[id]}`);
    }
  });

  it("keeps each provider's default a tool-calling model in the catalog", () => {
    for (const id of MODEL_PROVIDERS) {
      const model = getModel(id, PROVIDER_DEFAULT_MODEL[id]);
      expect(model, `${id}:${PROVIDER_DEFAULT_MODEL[id]}`).toBeDefined();
      expect(model?.capabilities.toolCall).toBe(true);
      expect(model?.deprecated).not.toBe(true);
    }
  });

  it("picks by a fixed provider order, not the order the config lists them in", () => {
    expect(defaultModelFor({ xai: {}, openai: {} })).toBe(
      `openai:${PROVIDER_DEFAULT_MODEL.openai}`,
    );
    expect(defaultModelFor({ google: {}, anthropic: {} })).toBe(FALLBACK_DEFAULT_MODEL);
  });

  it("prefers local to a hosted provider when both are configured", () => {
    expect(defaultModelFor({ greenpt: {}, local: { models: ["gemma4:e4b"] } })).toBe(
      "local:gemma4:e4b",
    );
    expect(defaultModelFor({ anthropic: {}, local: { models: ["qwen3:8b"] } })).toBe(
      "local:qwen3:8b",
    );
  });

  it("falls to a hosted provider when local lists no model", () => {
    expect(defaultModelFor({ local: {}, openai: {} })).toBe(
      `openai:${PROVIDER_DEFAULT_MODEL.openai}`,
    );
  });

  it("names the first local model when local is the only provider", () => {
    expect(defaultModelFor({ local: { models: ["qwen3:8b", "gemma4:e4b"] } })).toBe(
      "local:qwen3:8b",
    );
  });

  it("skips a local provider that lists no model", () => {
    expect(defaultModelFor({ local: {} })).toBe(FALLBACK_DEFAULT_MODEL);
    expect(defaultModelFor({ local: { models: [] } })).toBe(FALLBACK_DEFAULT_MODEL);
  });

  it("stays inside a provider's model allowlist", () => {
    expect(defaultModelFor({ openai: { models: ["gpt-5.4-mini"] } })).toBe("openai:gpt-5.4-mini");
    expect(
      defaultModelFor({ openai: { models: ["gpt-5.4-mini", PROVIDER_DEFAULT_MODEL.openai] } }),
    ).toBe(`openai:${PROVIDER_DEFAULT_MODEL.openai}`);
  });

  it("falls back to Anthropic's default when no provider is configured", () => {
    expect(defaultModelFor({})).toBe(FALLBACK_DEFAULT_MODEL);
  });
});

describe("defaultModelFor under modelPolicy", () => {
  it("keeps the provider's default when the policy allows it", () => {
    const openai = `openai:${PROVIDER_DEFAULT_MODEL.openai}`;
    expect(defaultModelFor({ openai: {} }, [openai])).toBe(openai);
  });

  it("takes the policy's first model for the provider when it leaves out the default", () => {
    expect(defaultModelFor({ openai: {} }, ["openai:gpt-5.4-mini", "openai:gpt-5.5"])).toBe(
      "openai:gpt-5.4-mini",
    );
  });

  it("moves to the next provider when the policy allows none of the first's models", () => {
    expect(defaultModelFor({ anthropic: {}, google: {} }, ["google:gemini-3.8-flash"])).toBe(
      "google:gemini-3.8-flash",
    );
  });

  it("stays inside both the provider allowlist and the policy", () => {
    expect(
      defaultModelFor({ openai: { models: ["gpt-5.4-mini", "gpt-5.5"] } }, ["openai:gpt-5.5"]),
    ).toBe("openai:gpt-5.5");
    expect(defaultModelFor({ local: { models: ["a", "b"] } }, ["local:b"])).toBe("local:b");
  });
});
