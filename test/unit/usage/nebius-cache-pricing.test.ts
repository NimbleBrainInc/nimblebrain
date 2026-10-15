import { describe, expect, it } from "bun:test";
import { getModelByString } from "../../../src/model/catalog.ts";
import nebiusData from "../../../src/model/catalog-nebius.json";
import { costBreakdown, resolveRates } from "../../../src/usage/cost.ts";

const ids = Object.keys(nebiusData.nebius.models);

describe("Nebius cached-token pricing", () => {
  it("loads every catalogued Nebius model with a price", () => {
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const model = getModelByString(`nebius:${id}`);
      expect(model).toBeDefined();
      expect(model!.cost.input).toBeGreaterThan(0);
      expect(model!.cost.output).toBeGreaterThan(0);
    }
  });

  it("prices a cached token at the catalog's cache-read rate, or at input when none is published", () => {
    for (const id of ids) {
      const modelString = `nebius:${id}`;
      const cost = getModelByString(modelString)!.cost;
      const cachedRate = cost.cacheRead ?? cost.input;
      expect(resolveRates(modelString)!.cacheRead).toBe(cachedRate);

      // 10k prompt tokens, 8k of them reported as served from the prefix cache.
      const b = costBreakdown(modelString, {
        inputTokens: 10_000,
        cacheReadTokens: 8_000,
        outputTokens: 0,
      });
      expect(b.input).toBeCloseTo((2_000 * cost.input) / 1_000_000, 10);
      expect(b.cacheRead).toBeCloseTo((8_000 * cachedRate) / 1_000_000, 10);
    }
  });
});
