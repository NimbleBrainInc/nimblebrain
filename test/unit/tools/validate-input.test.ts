import { describe, expect, it } from "bun:test";
import { validateToolInput } from "../../../src/tools/validate-input.ts";

const schema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    count: { type: "number" },
  },
  required: ["name"],
};

describe("validateToolInput", () => {
  it("accepts valid input", () => {
    const result = validateToolInput({ name: "hello", count: 5 }, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects missing required field", () => {
    const result = validateToolInput({ count: 5 }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("name");
    }
  });

  it("rejects wrong type", () => {
    const result = validateToolInput({ name: 123 }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("string");
    }
  });

  it("allows extra unknown fields by default", () => {
    const result = validateToolInput({ name: "hello", extra: true }, schema);
    expect(result.valid).toBe(true);
  });

  it("passes through when schema has no constraints", () => {
    const result = validateToolInput({ anything: "goes" }, { type: "object" });
    expect(result.valid).toBe(true);
  });

  it("passes through for empty schema", () => {
    const result = validateToolInput({ anything: "goes" }, {});
    expect(result.valid).toBe(true);
  });

  // Regression: a schema whose only constraint is `additionalProperties: false`
  // (or minProperties/patternProperties, etc.) must still be compiled and
  // enforced. A previous allowlist heuristic only checked `properties`,
  // `required`, and composition keywords — a soundness trap once this helper
  // began running on every InlineSource call.
  it("enforces additionalProperties: false even with no `properties`/`required`", () => {
    const schema = { type: "object" as const, additionalProperties: false };
    const ok = validateToolInput({}, schema);
    expect(ok.valid).toBe(true);

    const rejected = validateToolInput({ stray: 1 }, schema);
    expect(rejected.valid).toBe(false);
  });

  it("caches compiled validators for same schema reference", () => {
    // Call twice with the same schema object — second should use cache
    const r1 = validateToolInput({ name: "a" }, schema);
    const r2 = validateToolInput({ name: "b" }, schema);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
  });
});

// Regression: optional fields passed as null must be handled correctly.
// The files__write bug (description: null) was caused by a schema declaring
// type: "string" for an optional field — AJV rejects null against bare "string".
describe("validateToolInput — nullable optional fields", () => {
  const strictSchema = {
    type: "object" as const,
    properties: {
      filename: { type: "string" },
      description: { type: "string" },
    },
    required: ["filename"],
  };

  const nullableSchema = {
    type: "object" as const,
    properties: {
      filename: { type: "string" },
      description: { type: ["string", "null"] },
    },
    required: ["filename"],
  };

  it("rejects null for a type: 'string' optional field", () => {
    const result = validateToolInput({ filename: "a.txt", description: null }, strictSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("description");
      expect(result.error).toContain("string");
    }
  });

  it("accepts omitted optional field (type: 'string')", () => {
    const result = validateToolInput({ filename: "a.txt" }, strictSchema);
    expect(result.valid).toBe(true);
  });

  it("accepts null for a type: ['string', 'null'] optional field", () => {
    const result = validateToolInput({ filename: "a.txt", description: null }, nullableSchema);
    expect(result.valid).toBe(true);
  });

  it("accepts a string for a type: ['string', 'null'] optional field", () => {
    const result = validateToolInput({ filename: "a.txt", description: "notes" }, nullableSchema);
    expect(result.valid).toBe(true);
  });

  it("accepts omitted optional field (type: ['string', 'null'])", () => {
    const result = validateToolInput({ filename: "a.txt" }, nullableSchema);
    expect(result.valid).toBe(true);
  });

  it("rejects wrong type for a nullable field (number instead of string|null)", () => {
    const result = validateToolInput({ filename: "a.txt", description: 42 }, nullableSchema);
    expect(result.valid).toBe(false);
  });
});
