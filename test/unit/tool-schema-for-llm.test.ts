import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { log } from "../../src/cli/log.ts";
import { toolSchemaForLlm } from "../../src/engine/tool-schema-for-llm.ts";

/**
 * `toolSchemaForLlm` is the single boundary that translates MCP-spec
 * tool inputSchemas into the shape OpenAI and Anthropic both accept:
 * root `type: "object"` with explicit `properties`, no top-level
 * composition (oneOf / anyOf / allOf / enum / not).
 *
 * Strategy summary (see docstring on the implementation for rationale):
 *   - oneOf / anyOf → first-branch wins (lossy but recoverable for the LLM)
 *   - allOf → union-merge (semantically faithful)
 *   - enum / not → strip
 *   - Always emit type: "object" with a plain-object properties block
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

  describe("top-level oneOf — first-branch wins", () => {
    let warnSpy: ReturnType<typeof spyOn>;
    beforeEach(() => {
      warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("collapses a top-level oneOf to its first branch", () => {
      // Dropbox `list_folder`-style: model 'path' vs 'cursor' continuation
      // as mutually-exclusive branches. We pick the first; the LLM gets a
      // schema it can satisfy in one shot.
      const result = toolSchemaForLlm({
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          {
            type: "object",
            properties: { cursor: { type: "string" } },
            required: ["cursor"],
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

    it("preserves root metadata (description, etc.) when collapsing", () => {
      const result = toolSchemaForLlm({
        description: "Pick exactly one path style",
        oneOf: [
          { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
          { type: "object", properties: { key: { type: "string" } } },
        ],
      });
      expect(result.description).toBe("Pick exactly one path style");
      expect(result.properties).toEqual({ token: { type: "string" } });
      expect(result.required).toEqual(["token"]);
    });

    it("does NOT warn when oneOf has only one branch (no loss)", () => {
      toolSchemaForLlm({
        oneOf: [{ type: "object", properties: { x: { type: "string" } } }],
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns when oneOf has multiple branches, listing dropped property names", () => {
      toolSchemaForLlm(
        {
          oneOf: [
            { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
            { type: "object", properties: { shared_link: { type: "string" } } },
          ],
        },
        "com-dropbox-mcp__list_folder",
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('"com-dropbox-mcp__list_folder"');
      expect(msg).toContain("3 branches");
      expect(msg).toContain("cursor");
      expect(msg).toContain("shared_link");
      // The kept branch's property (path) should NOT appear in the lost list.
      // (Substring check is fine; "path" isn't in cursor / shared_link.)
      expect(msg).not.toMatch(/unreachable.*\bpath\b/);
    });

    it("warns with a placeholder when no novel properties exist in dropped branches", () => {
      toolSchemaForLlm({
        oneOf: [
          { type: "object", properties: { x: { type: "string" } } },
          { type: "object", properties: { x: { type: "number" } } }, // same name, different shape
        ],
      });
      const msg = warnSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain("(none — branches reshape kept properties)");
    });
  });

  describe("top-level anyOf — first-branch wins (identical to oneOf)", () => {
    it("collapses anyOf to its first branch", () => {
      const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
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
      expect((result as Record<string, unknown>).anyOf).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe("top-level allOf — union-merge with unioned required", () => {
    it("unions properties AND required (allOf means all hold simultaneously)", () => {
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
