import { describe, expect, it } from "bun:test";
import { toolSchemaForLlm } from "../../src/engine/tool-schema-for-llm.ts";

/**
 * `toolSchemaForLlm` is the single boundary where MCP-spec JSON Schema
 * gets transformed into the narrower shape that OpenAI and Anthropic
 * both accept for tool input schemas:
 *
 *   1. Root must be `type: "object"` with an explicit `properties` key.
 *   2. Root must NOT contain `oneOf` / `anyOf` / `allOf` / `enum` / `not`.
 *
 * MCP servers (Dropbox, etc.) routinely emit schemas that violate (1) or
 * (2). Anthropic's `tools.N.custom.input_schema` and OpenAI's
 * `tools[N].function.parameters` validators both reject them with the
 * same constraint set, so this is a universal LLM-tool-boundary concern,
 * not a per-provider quirk.
 */
describe("toolSchemaForLlm", () => {
  describe("base shape", () => {
    it("returns an empty object schema for non-object input", () => {
      expect(toolSchemaForLlm(undefined)).toEqual({ type: "object", properties: {} });
      expect(toolSchemaForLlm(null)).toEqual({ type: "object", properties: {} });
      expect(toolSchemaForLlm("nope")).toEqual({ type: "object", properties: {} });
    });

    it("fills properties: {} when an object schema omits it", () => {
      // Dropbox `get_usage_and_quota` ships this shape.
      expect(toolSchemaForLlm({ type: "object" })).toEqual({
        type: "object",
        properties: {},
      });
    });

    it("preserves an existing valid object schema verbatim", () => {
      const schema = {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      };
      expect(toolSchemaForLlm(schema)).toEqual(schema);
    });

    it("coerces a missing root type to object", () => {
      expect(toolSchemaForLlm({ properties: { x: { type: "string" } } })).toEqual({
        type: "object",
        properties: { x: { type: "string" } },
      });
    });

    it("does not mutate the input object", () => {
      const original: Record<string, unknown> = { type: "object" };
      toolSchemaForLlm(original);
      expect(original).toEqual({ type: "object" });
    });
  });

  describe("top-level oneOf / anyOf — first-branch wins", () => {
    it("collapses a top-level oneOf to its first branch", () => {
      // Dropbox `list_folder`-style: model "either path or shared link"
      // as a oneOf. Take the first branch — every valid call to the tool
      // must satisfy ONE branch, and synthesizing a union schema would
      // let the model emit invalid mix-and-match payloads.
      const result = toolSchemaForLlm({
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { shared_link: { type: "string" } },
            required: ["shared_link"],
          },
        ],
      });
      expect(result).toEqual({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      });
      expect((result as Record<string, unknown>).oneOf).toBeUndefined();
    });

    it("collapses a top-level anyOf to its first branch", () => {
      const result = toolSchemaForLlm({
        anyOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      });
      expect(result).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      });
    });

    it("preserves root-level description/title when collapsing oneOf", () => {
      const result = toolSchemaForLlm({
        description: "Pick exactly one auth style",
        oneOf: [
          { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
          { type: "object", properties: { key: { type: "string" } } },
        ],
      });
      expect(result).toEqual({
        type: "object",
        description: "Pick exactly one auth style",
        properties: { token: { type: "string" } },
        required: ["token"],
      });
    });
  });

  describe("top-level allOf — deep merge", () => {
    it("merges allOf branch properties into a single object", () => {
      const result = toolSchemaForLlm({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
        ],
      });
      expect(result.type).toBe("object");
      expect(result.properties).toEqual({
        a: { type: "string" },
        b: { type: "number" },
      });
      expect(result.required).toEqual(expect.arrayContaining(["a", "b"]));
      expect((result as Record<string, unknown>).allOf).toBeUndefined();
    });
  });

  describe("top-level enum / not — dropped", () => {
    it("drops a top-level enum, coercing to type: object", () => {
      const result = toolSchemaForLlm({ enum: ["a", "b", "c"] });
      expect(result).toEqual({ type: "object", properties: {} });
    });

    it("drops a top-level not, coercing to type: object", () => {
      const result = toolSchemaForLlm({ not: { type: "string" } });
      expect(result).toEqual({ type: "object", properties: {} });
    });
  });

  describe("composition inside properties is preserved", () => {
    it("leaves nested oneOf inside a property untouched", () => {
      // Anthropic's error message specifies "at the top level" — nested
      // composition is fine and we must NOT walk into it (loses real info).
      const nested = {
        type: "object",
        properties: {
          payload: {
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
      };
      expect(toolSchemaForLlm(nested)).toEqual(nested);
    });
  });
});
