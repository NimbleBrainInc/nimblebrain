import { describe, expect, it } from "bun:test";
import { coerceInputForSchema } from "../../../src/tools/coerce-input.ts";

describe("coerceInputForSchema — nested object recovery", () => {
  const schema = {
    type: "object" as const,
    properties: {
      manifest: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
      },
      body: { type: "string" },
    },
    required: ["manifest", "body"],
  };

  it("parses a string-encoded nested object", () => {
    const input = {
      manifest: '{"name":"foo","description":"bar"}',
      body: "x",
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.manifest).toEqual({ name: "foo", description: "bar" });
    expect(out.body).toBe("x");
  });

  it("leaves a properly shaped nested object untouched (idempotent)", () => {
    const input = {
      manifest: { name: "foo", description: "bar" },
      body: "x",
    };
    const out = coerceInputForSchema(input, schema);
    expect(out).toEqual(input);
  });

  it("leaves a non-JSON string untouched so the validator catches it", () => {
    const input = {
      manifest: "not json at all",
      body: "x",
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.manifest).toBe("not json at all");
  });

  it("does not coerce a string field whose schema declares type: string", () => {
    const input = {
      manifest: { name: "foo", description: "bar" },
      body: '{"this":"would parse but is meant to stay a string"}',
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.body).toBe('{"this":"would parse but is meant to stay a string"}');
  });
});

describe("coerceInputForSchema — nested array recovery", () => {
  const schema = {
    type: "object" as const,
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            find: { type: "string" },
            replace: { type: "string" },
          },
        },
      },
    },
  };

  it("parses a string-encoded array of objects", () => {
    const input = {
      edits: '[{"find":"a","replace":"b"},{"find":"c","replace":"d"}]',
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toEqual([
      { find: "a", replace: "b" },
      { find: "c", replace: "d" },
    ]);
  });

  it("leaves a properly shaped array untouched", () => {
    const input = { edits: [{ find: "a", replace: "b" }] };
    const out = coerceInputForSchema(input, schema);
    expect(out).toEqual(input);
  });

  it("recovers per-element string-encoding inside a real array", () => {
    // Array is fine, but each element was stringified individually — also
    // a real shape we've seen models emit.
    const input = {
      edits: ['{"find":"a","replace":"b"}', '{"find":"c","replace":"d"}'],
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toEqual([
      { find: "a", replace: "b" },
      { find: "c", replace: "d" },
    ]);
  });
});

describe("coerceInputForSchema — depth and edge cases", () => {
  it("recovers a doubly-nested string-encoded object", () => {
    const schema = {
      type: "object" as const,
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: { type: "object", properties: { v: { type: "string" } } },
          },
        },
      },
    };
    const input = { outer: '{"inner":"{\\"v\\":\\"hello\\"}"}' };
    const out = coerceInputForSchema(input, schema);
    expect(out).toEqual({ outer: { inner: { v: "hello" } } });
  });

  it("ignores unknown properties not declared in the schema", () => {
    const schema = {
      type: "object" as const,
      properties: { known: { type: "object" } },
    };
    const input = { known: '{"a":1}', unknown: '{"b":2}' };
    const out = coerceInputForSchema(input, schema);
    expect(out.known).toEqual({ a: 1 });
    // Unknown is left alone — the validator decides via additionalProperties.
    expect(out.unknown).toBe('{"b":2}');
  });

  it("returns input unchanged when schema is empty", () => {
    const input = { manifest: '{"a":1}' };
    const out = coerceInputForSchema(input, {});
    expect(out).toEqual(input);
  });

  it("does not attempt to parse a string that doesn't look like JSON", () => {
    // Cheap sniff guard: only strings starting with { or [ are tried.
    // Avoids JSON.parse on every string field for performance.
    const schema = {
      type: "object" as const,
      properties: { manifest: { type: "object" } },
    };
    const input = { manifest: "hello world" };
    const out = coerceInputForSchema(input, schema);
    expect(out.manifest).toBe("hello world");
  });

  it("handles a schema that allows multiple types (union)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        edits: { type: ["array", "null"], items: { type: "object" } },
      },
    };
    const input = { edits: '[{"find":"a"}]' };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toEqual([{ find: "a" }]);
  });
});
