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

describe("coerceInputForSchema — scalar string recovery", () => {
  // Mirrors the real failure: automations__runs `limit` is Type.Number, the
  // model sent "5", and validation rejected the whole call.
  it("coerces a stringified number for a number param", () => {
    const schema = {
      type: "object" as const,
      properties: { limit: { type: "number" } },
    };
    expect(coerceInputForSchema({ limit: "5" }, schema)).toEqual({ limit: 5 });
  });

  it("coerces a stringified integer for an integer param", () => {
    const schema = {
      type: "object" as const,
      properties: { top: { type: "integer" } },
    };
    expect(coerceInputForSchema({ top: "30" }, schema)).toEqual({ top: 30 });
  });

  it("rejects a non-integer string for an integer param (left for the validator)", () => {
    const schema = {
      type: "object" as const,
      properties: { top: { type: "integer" } },
    };
    expect(coerceInputForSchema({ top: "30.5" }, schema)).toEqual({ top: "30.5" });
  });

  it("coerces stringified booleans for a boolean param", () => {
    const schema = {
      type: "object" as const,
      properties: { enabled: { type: "boolean" } },
    };
    expect(coerceInputForSchema({ enabled: "true" }, schema)).toEqual({ enabled: true });
    expect(coerceInputForSchema({ enabled: "false" }, schema)).toEqual({ enabled: false });
  });

  it("leaves a non-numeric string for a number param (validator surfaces it)", () => {
    const schema = {
      type: "object" as const,
      properties: { limit: { type: "number" } },
    };
    expect(coerceInputForSchema({ limit: "abc" }, schema)).toEqual({ limit: "abc" });
  });

  it("does NOT retype a value the schema accepts as a string", () => {
    const schema = {
      type: "object" as const,
      properties: { id: { type: "string" } },
    };
    expect(coerceInputForSchema({ id: "42" }, schema)).toEqual({ id: "42" });
  });

  it("does NOT coerce inside a string|number union (string branch accepts it)", () => {
    const schema = {
      type: "object" as const,
      properties: { val: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };
    expect(coerceInputForSchema({ val: "5" }, schema)).toEqual({ val: "5" });
  });

  it("recovers a stringified number through a Pydantic Optional[int] union", () => {
    const schema = {
      type: "object" as const,
      properties: { limit: { anyOf: [{ type: "integer" }, { type: "null" }] } },
    };
    expect(coerceInputForSchema({ limit: "5" }, schema)).toEqual({ limit: 5 });
  });

  it("leaves an already-correct number untouched (idempotent)", () => {
    const schema = {
      type: "object" as const,
      properties: { limit: { type: "number" } },
    };
    expect(coerceInputForSchema({ limit: 5 }, schema)).toEqual({ limit: 5 });
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

describe("coerceInputForSchema — anyOf / oneOf union resolution", () => {
  // Pydantic v2 encodes `Optional[T]` (= `T | None`) as
  // `{anyOf: [{type: T-shape}, {type: "null"}]}` — the canonical shape
  // for any optional structural parameter on a FastMCP bundle. These
  // tests pin the behavior that recovers stringified values arriving at
  // such properties (the live `patch_source(edits=...)` bug).

  it("anyOf [array, null]: parses a stringified array (Pydantic Optional[list[...]])", () => {
    const schema = {
      type: "object" as const,
      properties: {
        edits: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  find: { type: "string" },
                  replace: { type: "string" },
                },
              },
            },
            { type: "null" },
          ],
        },
      },
    };
    const input = {
      edits: '[{"find":"a","replace":"b"},{"find":"c","replace":"d"}]',
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toEqual([
      { find: "a", replace: "b" },
      { find: "c", replace: "d" },
    ]);
  });

  it("anyOf [object, null]: parses a stringified object (Pydantic Optional[dict])", () => {
    const schema = {
      type: "object" as const,
      properties: {
        manifest: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
              },
            },
            { type: "null" },
          ],
        },
      },
    };
    const input = { manifest: '{"name":"foo","description":"bar"}' };
    const out = coerceInputForSchema(input, schema);
    expect(out.manifest).toEqual({ name: "foo", description: "bar" });
  });

  it("oneOf [array, null]: parses a stringified array", () => {
    const schema = {
      type: "object" as const,
      properties: {
        edits: {
          oneOf: [{ type: "array", items: { type: "object" } }, { type: "null" }],
        },
      },
    };
    const input = { edits: '[{"find":"a"}]' };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toEqual([{ find: "a" }]);
  });

  it("anyOf [array, null]: leaves an already-correct array unchanged (idempotent)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        edits: {
          anyOf: [
            { type: "array", items: { type: "object" } },
            { type: "null" },
          ],
        },
      },
    };
    const input = { edits: [{ find: "a" }] };
    const out = coerceInputForSchema(input, schema);
    expect(out).toEqual(input);
  });

  it("anyOf [array, null]: leaves null unchanged (still a valid value for the union)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        edits: {
          anyOf: [
            { type: "array", items: { type: "object" } },
            { type: "null" },
          ],
        },
      },
    };
    const input = { edits: null };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toBeNull();
  });

  it("anyOf [array, null]: recurses through array items after collapsing the union", () => {
    // The recovered array's elements are themselves stringified objects —
    // we should keep walking after resolving the union, not stop at the
    // outer-shape recovery.
    const schema = {
      type: "object" as const,
      properties: {
        edits: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  find: { type: "string" },
                  replace: { type: "string" },
                },
              },
            },
            { type: "null" },
          ],
        },
      },
    };
    const input = {
      edits: ['{"find":"a","replace":"b"}', '{"find":"c","replace":"d"}'],
    };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toEqual([
      { find: "a", replace: "b" },
      { find: "c", replace: "d" },
    ]);
  });

  it("does not coerce a JSON-looking string when a `string` branch is present (str | list)", () => {
    // A union that accepts a string accepts the value as-is, so coercion's
    // "stringified misencoding" premise doesn't hold. Leave it untouched and
    // let the validator adjudicate — coercing would silently change a
    // legitimate string into a list.
    const schema = {
      type: "object" as const,
      properties: {
        value: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
    };
    const input = { value: "[draft]" };
    const out = coerceInputForSchema(input, schema);
    expect(out.value).toBe("[draft]");
  });

  it("leaves a multi-structural union (array | object, no null) untouched", () => {
    // We deliberately do not disambiguate 2+ structural branches; the value
    // passes through for the validator. Re-add disambiguation additively if a
    // real bundle ever ships such a param.
    const schema = {
      type: "object" as const,
      properties: {
        payload: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "object", properties: { kind: { type: "string" } } },
          ],
        },
      },
    };
    const input = { payload: '["a","b","c"]' };
    const out = coerceInputForSchema(input, schema);
    expect(out.payload).toBe('["a","b","c"]');
  });

  it("anyOf wrapping the root: nested coercion still finds the property branch", () => {
    // Realistic shape if a future Upjack/FastMCP tool emits an outer
    // `anyOf` at root (e.g. result-union from `# type: <X> | <Y>`). The
    // resolver must walk through to find the structural object branch
    // before walking its properties.
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            edits: {
              anyOf: [
                { type: "array", items: { type: "object" } },
                { type: "null" },
              ],
            },
          },
        },
        { type: "null" },
      ],
    };
    const input = { edits: '[{"find":"a"}]' };
    const out = coerceInputForSchema(input, schema as Record<string, unknown>);
    expect(out.edits).toEqual([{ find: "a" }]);
  });

  it("non-JSON string at an anyOf property passes through unchanged for the validator", () => {
    const schema = {
      type: "object" as const,
      properties: {
        edits: {
          anyOf: [
            { type: "array", items: { type: "object" } },
            { type: "null" },
          ],
        },
      },
    };
    const input = { edits: "not json" };
    const out = coerceInputForSchema(input, schema);
    expect(out.edits).toBe("not json");
  });
});
