import { expect, test } from "bun:test";
import { inferSchema, parseJsonOutput } from "./inferSchema.ts";

test("infers a schema from a value", () => {
  expect(
    inferSchema({ name: "Acme", seats: 3, score: 0.5, ok: true, tags: ["a"], x: null }),
  ).toEqual({
    type: "object",
    properties: {
      name: { type: "string" },
      seats: { type: "integer" },
      score: { type: "number" },
      ok: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      x: { type: "null" },
    },
    required: ["name", "seats", "score", "ok", "tags", "x"],
  });
});

test("reads JSON output, fenced or bare, and nothing else", () => {
  expect(parseJsonOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(parseJsonOutput(" [1,2] ")).toEqual([1, 2]);
  expect(parseJsonOutput("Here you go: {}")).toBeUndefined();
  expect(parseJsonOutput("{broken")).toBeUndefined();
});
