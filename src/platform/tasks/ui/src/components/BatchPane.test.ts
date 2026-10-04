import { describe, expect, it } from "bun:test";
import type { BatchItemResult } from "../types.ts";
import { outputColumns } from "./BatchPane.tsx";

function row(index: number, output?: BatchItemResult["output"]): BatchItemResult {
  return { index, inputSummary: "{}", state: "done", ...(output ? { output } : {}) };
}

describe("outputColumns", () => {
  it("takes every output key in first-seen order, at most six", () => {
    expect(outputColumns([row(0, { a: 1, b: 2 }), row(1), row(2, { c: "x", a: 3 })])).toEqual([
      "a",
      "b",
      "c",
    ]);
    const wide = Object.fromEntries("abcdefgh".split("").map((k) => [k, 1]));
    expect(outputColumns([row(0, wide)])).toHaveLength(6);
  });

  it("is empty when no row has structured output", () => {
    expect(outputColumns([row(0), row(1)])).toEqual([]);
  });
});
