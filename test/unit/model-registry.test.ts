import { describe, expect, it } from "bun:test";
import {
  resolveModelString,
  buildRegistry,
  buildModelResolver,
} from "../../src/model/registry.ts";

describe("resolveModelString", () => {
  it("prefixes bare string with anthropic:", () => {
    expect(resolveModelString("claude-sonnet-4-6")).toBe(
      "anthropic:claude-sonnet-4-6",
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
