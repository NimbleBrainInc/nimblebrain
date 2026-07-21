import { describe, expect, it } from "bun:test";
import { normalizeModel } from "../../src/conversation/usage-aggregator.ts";

describe("normalizeModel", () => {
  it("strips any provider prefix, including nebius, for grouping/display", () => {
    // The prefix strip is generic so a new provider needs no code change here
    // (or in the sibling copies in the usage UIs). Nebius model ids carry an
    // org/model path that must survive intact.
    expect(normalizeModel("nebius:Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
    expect(normalizeModel("nebius:deepseek-ai/DeepSeek-V4-Pro")).toBe("deepseek-ai/DeepSeek-V4-Pro");
  });

  it("still strips the original providers and the date suffix", () => {
    expect(normalizeModel("anthropic:claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModel("openai:gpt-4o")).toBe("gpt-4o");
    expect(normalizeModel("google:gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("leaves a bare id (no provider prefix) unchanged", () => {
    expect(normalizeModel("Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
  });
});
