import { describe, expect, it } from "bun:test";
import { buildNebiusCatalog, type RawNebiusModel } from "../../src/model/sync-nebius.ts";

const curated = [{ id: "org/Model-A", name: "Model A", family: "fam" }];

function raw(overrides: Partial<RawNebiusModel> = {}): RawNebiusModel {
  return {
    id: "org/Model-A",
    context_length: 131072,
    pricing: { prompt: "0.00000015", completion: "0.0000006" },
    supported_features: ["tools", "reasoning"],
    ...overrides,
  };
}

describe("buildNebiusCatalog", () => {
  it("converts per-token pricing to USD per 1M without float noise", () => {
    // 0.13/M is the case that surfaces float noise (0.13 * 1e6 -> 0.1299999…).
    const models = buildNebiusCatalog([raw({ pricing: { prompt: "0.00000013", completion: "0.0000004" } })], curated);
    expect(models["org/Model-A"]!.cost).toEqual({ input: 0.13, output: 0.4 });
  });

  it("derives toolCall and reasoning from supported_features", () => {
    const toolsOnly = buildNebiusCatalog([raw({ supported_features: ["tools"] })], curated);
    expect(toolsOnly["org/Model-A"]!.capabilities).toMatchObject({ toolCall: true, reasoning: false });

    const both = buildNebiusCatalog([raw({ supported_features: ["tools", "reasoning"] })], curated);
    expect(both["org/Model-A"]!.capabilities).toMatchObject({ toolCall: true, reasoning: true });
  });

  it("uses the real context and caps output at the default, never above context", () => {
    const big = buildNebiusCatalog([raw({ context_length: 1048576 })], curated);
    expect(big["org/Model-A"]!.limits).toEqual({ context: 1048576, output: 16384 });

    // A model whose whole window is below the default output cap must clamp to it.
    const small = buildNebiusCatalog([raw({ context_length: 8000 })], curated);
    expect(small["org/Model-A"]!.limits).toEqual({ context: 8000, output: 8000 });
  });

  it("skips a curated id the account doesn't serve", () => {
    const models = buildNebiusCatalog([raw({ id: "org/Different" })], curated);
    expect(models["org/Model-A"]).toBeUndefined();
    expect(Object.keys(models)).toHaveLength(0);
  });
});
