import { describe, expect, test } from "bun:test";
import { assertJsonSchema, checkAgainstSchema } from "../../src/platform/tasks/json-schema.ts";
import { validateToolInput } from "../../src/tools/validate-input.ts";

const DRAFT_2020 = "https://json-schema.org/draft/2020-12/schema";

describe("validateToolInput: the schema's declared dialect", () => {
  test("test_validate_2020_12_schema_validates_instead_of_throwing", () => {
    const schema = {
      $schema: DRAFT_2020,
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    expect(validateToolInput({ q: "x" }, schema).valid).toBe(true);
    expect(validateToolInput({}, schema).valid).toBe(false);
  });

  test("test_validate_2020_12_schema_with_trailing_hash_compiles", () => {
    const schema = { $schema: `${DRAFT_2020}#`, type: "object", required: ["q"] };
    expect(validateToolInput({}, schema).valid).toBe(false);
  });

  test("test_validate_2020_12_prefixItems_rejects_bad_input", () => {
    const schema = {
      $schema: DRAFT_2020,
      type: "object",
      properties: {
        pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
      },
    };
    expect(validateToolInput({ pair: ["a", 1] }, schema).valid).toBe(true);
    expect(validateToolInput({ pair: [1, "a"] }, schema).valid).toBe(false);
  });

  test("test_validate_draft07_array_items_unchanged", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    };
    expect(validateToolInput({ pair: ["a", 1] }, schema).valid).toBe(true);
    expect(validateToolInput({ pair: [1, "a"] }, schema).valid).toBe(false);
  });

  test("test_validate_undeclared_dialect_stays_draft07", () => {
    const schema = {
      type: "object",
      properties: { pair: { type: "array", items: [{ type: "string" }] } },
    };
    expect(validateToolInput({ pair: [1] }, schema).valid).toBe(false);
  });

  test("test_validate_uncompilable_schema_refuses_by_default", () => {
    const schema = { $schema: "http://json-schema.org/draft-04/schema#", type: "object" };
    expect(validateToolInput({ any: 1 }, schema)).toMatchObject({
      valid: false,
      error: expect.stringContaining("input schema does not compile"),
    });
  });

  test("test_validate_uncompilable_schema_passes_when_caller_opts_in", () => {
    const schema = { $schema: "http://json-schema.org/draft-04/schema#", type: "object" };
    expect(validateToolInput({ any: 1 }, schema, { uncompilable: "pass" }).valid).toBe(true);
    expect(validateToolInput({ any: 2 }, schema, { uncompilable: "pass" }).valid).toBe(true);
  });

  test("test_validate_schemas_sharing_an_id_both_compile", () => {
    const a = { $id: "https://example.com/shared.json", type: "object", required: ["a"] };
    const b = { $id: "https://example.com/shared.json", type: "object", required: ["b"] };
    expect(validateToolInput({}, a).valid).toBe(false);
    expect(validateToolInput({}, b).valid).toBe(false);
  });
});

describe("task schemas: the schema's declared dialect", () => {
  test("test_task_schema_2020_12_is_accepted_and_checked", () => {
    const schema = { $schema: DRAFT_2020, type: "object", required: ["x"] };
    expect(() => assertJsonSchema(schema, "outputSchema")).not.toThrow();
    expect(checkAgainstSchema(schema, {}).valid).toBe(false);
  });

  test("test_task_schema_uncompilable_is_refused", () => {
    const schema = { $schema: "http://json-schema.org/draft-04/schema#", type: "object" };
    expect(() => assertJsonSchema(schema, "outputSchema")).toThrow(/not a valid JSON Schema/);
  });
});
