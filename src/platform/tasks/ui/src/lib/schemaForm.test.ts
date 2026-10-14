/**
 * Run now draws a form from a flat input schema and sends exactly the shape
 * the schema asks for; anything a form cannot express falls back to JSON.
 */
import { describe, expect, test } from "bun:test";
import {
  builderProblem,
  buildInput,
  fieldsFromSchema,
  flatFields,
  initialValues,
  schemaFromFields,
} from "./schemaForm.ts";

const SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string", description: "Who to research" },
    seats: { type: "integer" },
    score: { type: "number" },
    urgent: { type: "boolean" },
    tier: { type: "string", enum: ["a", "b"] },
  },
  required: ["company", "tier"],
};

describe("flatFields", () => {
  test("reads each scalar property, in order, with required and enum", () => {
    const fields = flatFields(SCHEMA);
    expect(fields?.map((f) => [f.name, f.type, f.required])).toEqual([
      ["company", "string", true],
      ["seats", "integer", false],
      ["score", "number", false],
      ["urgent", "boolean", false],
      ["tier", "string", true],
    ]);
    expect(fields?.[4]?.options).toEqual(["a", "b"]);
    expect(fields?.[0]?.description).toBe("Who to research");
  });

  test("is null for a schema a form cannot hold", () => {
    expect(flatFields({ type: "object", properties: { a: { type: "object" } } })).toBeNull();
    expect(flatFields({ type: "object", properties: { a: { type: "array" } } })).toBeNull();
    expect(flatFields({ type: "array", items: {} })).toBeNull();
    expect(flatFields({ oneOf: [] })).toBeNull();
    expect(flatFields(null)).toBeNull();
  });
});

describe("buildInput", () => {
  const fields = flatFields(SCHEMA)!;

  test("coerces numbers and booleans and leaves out empty optional fields", () => {
    const values = {
      ...initialValues(fields),
      company: " Acme ",
      seats: "12",
      tier: "b",
      urgent: true,
    };
    expect(buildInput(fields, values)).toEqual({
      input: { company: "Acme", seats: 12, urgent: true, tier: "b" },
      errors: {},
    });
  });

  test("names each bad field", () => {
    const { errors } = buildInput(fields, {
      ...initialValues(fields),
      company: "",
      seats: "1.5",
      score: "abc",
      tier: "z",
    });
    expect(errors).toEqual({
      company: "Required",
      seats: "Enter a whole number",
      score: "Enter a number",
      tier: "Pick one of the options",
    });
  });

  test("a required select starts on its first option", () => {
    expect(initialValues(fields).tier).toBe("a");
  });
});

describe("the field builder", () => {
  test("round-trips through a schema", () => {
    const rows = [
      { name: "company", type: "string" as const, required: true, description: "Who" },
      { name: "seats", type: "integer" as const, required: false, description: "" },
    ];
    const schema = schemaFromFields(rows);
    expect(schema).toEqual({
      type: "object",
      properties: { company: { type: "string", description: "Who" }, seats: { type: "integer" } },
      required: ["company"],
      additionalProperties: false,
    });
    expect(fieldsFromSchema(schema)).toEqual(rows);
  });

  test("no rows is no schema; an enum is not builder-shaped", () => {
    expect(schemaFromFields([])).toBeNull();
    expect(fieldsFromSchema(SCHEMA)).toBeNull();
  });

  test("refuses bad and duplicate names", () => {
    const row = { type: "string" as const, required: false, description: "" };
    expect(builderProblem([{ ...row, name: "1st" }])).toContain("not a field name");
    expect(
      builderProblem([
        { ...row, name: "a" },
        { ...row, name: "a" },
      ]),
    ).toContain("Two fields");
    expect(builderProblem([{ ...row, name: "ok_name" }])).toBeNull();
  });
});
