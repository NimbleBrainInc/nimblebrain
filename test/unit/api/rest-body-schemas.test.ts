import { describe, expect, test } from "bun:test";
import { Kind, type TSchema } from "@sinclair/typebox";
import * as rest from "../../../src/api/schemas/rest.ts";
import { validateAgainst } from "../../../src/api/schemas/validate.ts";

// The REST handlers check bodies with TypeBox `Value.Check`, which throws
// `Unknown type` on a node it has no Kind for. `StringEnum` (`Type.Unsafe`)
// carries none, so it belongs to AJV-validated tool inputs only.
function nodesWithoutKind(schema: unknown, path: string, out: string[]): string[] {
  if (schema === null || typeof schema !== "object") return out;
  const node = schema as Record<string | symbol, unknown>;
  if (!(Kind in node)) out.push(path || "(root)");
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [prop, sub] of Object.entries(value))
        nodesWithoutKind(sub, `${path}/${prop}`, out);
    } else if (
      (key === "items" || key === "anyOf" || key === "allOf" || key === "oneOf") &&
      value
    ) {
      const subs = Array.isArray(value) ? value : [value];
      for (const [i, sub] of subs.entries()) nodesWithoutKind(sub, `${path}/${key}[${i}]`, out);
    } else if (key === "additionalProperties" && value && typeof value === "object") {
      nodesWithoutKind(value, `${path}/additionalProperties`, out);
    }
  }
  return out;
}

describe("REST body schemas", () => {
  const schemas = Object.entries(rest).filter(
    ([, value]) => value !== null && typeof value === "object" && Kind in (value as object),
  ) as [string, TSchema][];

  test("every exported body schema is found", () => {
    expect(schemas.map(([name]) => name)).toEqual(
      expect.arrayContaining(["ChatRequestBody", "ToolCallRequestEnvelope"]),
    );
  });

  for (const [name, schema] of schemas) {
    test(`${name}: every node is TypeBox-native, so Value.Check can walk it`, () => {
      expect(nodesWithoutKind(schema, "", [])).toEqual([]);
    });
  }

  test("a chat body carrying a plugin request answer validates", () => {
    const body = {
      message: "Use Linear here.",
      pluginRequestAnswer: { serverName: "app-linear-mcp", answer: "use" },
    };
    expect(validateAgainst(body, rest.ChatRequestBody)).toEqual({ ok: true, reason: null });
  });

  test("an answer outside use / not_now is refused, not thrown", () => {
    const body = {
      message: "x",
      pluginRequestAnswer: { serverName: "app-linear-mcp", answer: "maybe" },
    };
    expect(validateAgainst(body, rest.ChatRequestBody).ok).toBe(false);
  });
});
