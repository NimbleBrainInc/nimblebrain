import { describe, expect, it } from "bun:test";
import {
  resolveModelString,
  buildRegistry,
  buildModelResolver,
} from "../../src/model/registry.ts";

describe("resolveModelString", () => {
  it("looks up bare anthropic model id in the catalog", () => {
    expect(resolveModelString("claude-sonnet-4-6")).toBe(
      "anthropic:claude-sonnet-4-6",
    );
  });

  it("looks up bare google model id in the catalog (fixes UI sending bare gemini ids to anthropic)", () => {
    // Regression: the settings UI used to write `gemini-3.1-pro-preview`
    // as the saved value (no `google:` prefix). Without the catalog
    // fallback, that id defaulted to `anthropic:` and 404'd against
    // the Anthropic API.
    expect(resolveModelString("gemini-3.1-pro-preview")).toBe(
      "google:gemini-3.1-pro-preview",
    );
  });

  it("looks up bare openai model id in the catalog", () => {
    expect(resolveModelString("gpt-4o")).toBe("openai:gpt-4o");
  });

  it("falls back to anthropic for bare ids not in the catalog (backward compat)", () => {
    // Bespoke / pinned model ids that pre-date the catalog still default
    // to anthropic — preserves the historical behavior for tenants who
    // configured custom model strings.
    expect(resolveModelString("custom-fine-tune-not-in-catalog")).toBe(
      "anthropic:custom-fine-tune-not-in-catalog",
    );
  });

  it("leaves already-qualified openai string unchanged", () => {
    expect(resolveModelString("openai:gpt-4o")).toBe("openai:gpt-4o");
  });

  it("leaves already-qualified google string unchanged", () => {
    expect(resolveModelString("google:gemini-2.5-flash")).toBe(
      "google:gemini-2.5-flash",
    );
  });

  it("keeps strings with multiple colons unchanged", () => {
    expect(resolveModelString("openai:ft:gpt-4o:my-org")).toBe(
      "openai:ft:gpt-4o:my-org",
    );
  });
});

describe("buildRegistry", () => {
  it("creates a provider that resolves anthropic models with correct spec version", () => {
    const registry = buildRegistry({ providers: { anthropic: {} } });
    const model = registry.languageModel("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toContain("anthropic");
    expect(model.modelId).toContain("claude-sonnet");
  });

  it("defaults to anthropic when no providers configured", () => {
    const registry = buildRegistry({});
    const model = registry.languageModel("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.provider).toContain("anthropic");
    // Verify it has the same spec version as explicit config
    expect(model.specificationVersion).toBe("v3");
  });

  it("throws for unregistered provider prefix", () => {
    const registry = buildRegistry({ providers: { anthropic: {} } });
    expect(() => registry.languageModel("fakeprovider:some-model")).toThrow();
  });

  it("resolves nebius models through the OpenAI-compatible Chat Completions API", () => {
    const registry = buildRegistry({ providers: { nebius: {} } });
    const model = registry.languageModel("nebius:deepseek-ai/DeepSeek-V3-0324");
    expect(model).toBeDefined();
    expect(model.specificationVersion).toBe("v3");
    // Must bind `.chat()` (Chat Completions), NOT `.responses()` — Nebius has
    // no Responses API, which is what the OpenAI provider's default binds.
    expect(model.provider).toBe("nebius.chat");
    expect(model.modelId).toBe("deepseek-ai/DeepSeek-V3-0324");
  });
});

describe("buildModelResolver", () => {
  it("returns a function", () => {
    const resolver = buildModelResolver({ providers: { anthropic: {} } });
    expect(typeof resolver).toBe("function");
  });

  it("resolves bare strings with anthropic prefix", () => {
    const resolver = buildModelResolver({ providers: { anthropic: {} } });
    const model = resolver("claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.provider).toContain("anthropic");
  });

  it("resolves qualified strings directly", () => {
    const resolver = buildModelResolver({ providers: { anthropic: {} } });
    const model = resolver("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.provider).toContain("anthropic");
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });
});
