import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { log } from "../../src/cli/log.ts";
import { toolSchemaForLlm } from "../../src/engine/tool-schema-for-llm.ts";

/**
 * `toolSchemaForLlm` is the single boundary that translates MCP-spec
 * tool inputSchemas into the shape OpenAI and Anthropic both accept:
 * root `type: "object"` with explicit `properties`, no top-level
 * composition (oneOf / anyOf / allOf / enum / not).
 *
 * MCP servers routinely emit shapes the spec allows but providers reject.
 * The transform absorbs the contract gap at one place; downstream
 * validation (Ajv over the original schema) backs every actual call, so
 * the merge strategy can be permissive without compromising safety.
 */
describe("toolSchemaForLlm", () => {
  describe("base shape", () => {
    it("treats null/undefined as 'no input' (silent coerce)", () => {
      const warnSpy = spyOn(log, "warn");
      expect(toolSchemaForLlm(undefined)).toEqual({ type: "object", properties: {} });
      expect(toolSchemaForLlm(null)).toEqual({ type: "object", properties: {} });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("fills properties: {} when an object schema omits it", () => {
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
      const original: Record<string, unknown> = {
        type: "object",
        oneOf: [{ properties: { a: { type: "string" } } }],
      };
      const snapshot = JSON.parse(JSON.stringify(original));
      toolSchemaForLlm(original);
      expect(original).toEqual(snapshot);
    });
  });

  describe("defensive coercion for malformed input", () => {
    let warnSpy: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns and coerces when input is a string", () => {
      expect(toolSchemaForLlm("not-a-schema", "my_tool")).toEqual({
        type: "object",
        properties: {},
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('"my_tool"');
      expect(msg).toContain("string");
    });

    it("warns and coerces when input is an array", () => {
      toolSchemaForLlm([], "list_tool");
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain("array");
      expect(msg).toContain('"list_tool"');
    });

    it("warns and coerces when input is a number", () => {
      toolSchemaForLlm(42);
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain("number");
      expect(msg).toContain("<unknown>");
    });

    it("fixes properties: null defensively (no warning — schema itself is valid)", () => {
      const result = toolSchemaForLlm({ type: "object", properties: null });
      expect(result).toEqual({ type: "object", properties: {} });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("fixes properties: <non-object> defensively", () => {
      const result = toolSchemaForLlm({ type: "object", properties: "nope" });
      expect(result).toEqual({ type: "object", properties: {} });
    });

    it("fixes properties: <array> defensively", () => {
      const result = toolSchemaForLlm({ type: "object", properties: [] });
      expect(result).toEqual({ type: "object", properties: {} });
    });
  });

  describe("top-level oneOf — union-merge with intersected required", () => {
    it("unions properties across branches", () => {
      // Dropbox `list_folder`-style: model 'path' or 'shared_link' as
      // mutually-exclusive branches. We want the LLM to be able to call
      // either; Ajv over the original schema gates the actual call.
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
      expect(result.type).toBe("object");
      expect((result as Record<string, unknown>).oneOf).toBeUndefined();
      expect(result.properties).toEqual({
        path: { type: "string" },
        shared_link: { type: "string" },
      });
      // Intersection of [path] and [shared_link] is empty → no root required.
      expect(result.required).toBeUndefined();
    });

    it("intersects required across oneOf branches", () => {
      const result = toolSchemaForLlm({
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" }, mode: { type: "string" } },
            required: ["path", "mode"],
          },
          {
            type: "object",
            properties: { path: { type: "string" }, recursive: { type: "boolean" } },
            required: ["path"],
          },
        ],
      });
      // path is required in BOTH branches → required.
      // mode is required in only one branch → not universally required.
      expect(result.required).toEqual(["path"]);
    });

    it("last branch wins on property-key collision", () => {
      const result = toolSchemaForLlm({
        oneOf: [
          { type: "object", properties: { x: { type: "string" } } },
          { type: "object", properties: { x: { type: "number" } } },
        ],
      });
      expect(result.properties).toEqual({ x: { type: "number" } });
    });

    it("preserves root-level metadata (description, etc.)", () => {
      const result = toolSchemaForLlm({
        description: "Pick exactly one path style",
        oneOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      });
      expect(result.description).toBe("Pick exactly one path style");
      expect(result.properties).toEqual({
        a: { type: "string" },
        b: { type: "string" },
      });
    });

    it("merges root-level properties with branch properties", () => {
      const result = toolSchemaForLlm({
        type: "object",
        properties: { common: { type: "string" } },
        oneOf: [
          { properties: { a: { type: "string" } } },
          { properties: { b: { type: "string" } } },
        ],
      });
      expect(result.properties).toEqual({
        common: { type: "string" },
        a: { type: "string" },
        b: { type: "string" },
      });
    });
  });

  describe("top-level anyOf — union-merge with intersected required", () => {
    it("merges anyOf identically to oneOf", () => {
      const result = toolSchemaForLlm({
        anyOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      });
      expect(result.properties).toEqual({
        a: { type: "string" },
        b: { type: "string" },
      });
      // Intersection of [a] and [] is empty.
      expect(result.required).toBeUndefined();
      expect((result as Record<string, unknown>).anyOf).toBeUndefined();
    });
  });

  describe("top-level allOf — union-merge with unioned required", () => {
    it("unions both properties AND required (allOf means all hold)", () => {
      const result = toolSchemaForLlm({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
        ],
      });
      expect(result.properties).toEqual({
        a: { type: "string" },
        b: { type: "number" },
      });
      expect(result.required).toEqual(expect.arrayContaining(["a", "b"]));
      expect((result as Record<string, unknown>).allOf).toBeUndefined();
    });
  });

  describe("top-level enum / not — stripped", () => {
    it("drops a top-level enum, coercing to type: object", () => {
      expect(toolSchemaForLlm({ enum: ["a", "b", "c"] })).toEqual({
        type: "object",
        properties: {},
      });
    });

    it("drops a top-level not, coercing to type: object", () => {
      expect(toolSchemaForLlm({ not: { type: "string" } })).toEqual({
        type: "object",
        properties: {},
      });
    });
  });

  describe("composition inside properties is preserved", () => {
    it("leaves nested oneOf inside a property untouched", () => {
      // Providers only restrict the top level; preserving nested
      // composition is more informative than walking and flattening.
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
