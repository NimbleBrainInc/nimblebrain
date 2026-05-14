import { describe, expect, it } from "bun:test";
import { scrubArgsForDispatch } from "../../../src/tools/scrub-args.ts";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("scrubArgsForDispatch — single-property cases", () => {
  it("strips nil UUID on a uuid-formatted field", () => {
    const schema = {
      type: "object",
      properties: {
        start_after: { type: "string", format: "uuid" },
      },
    };
    const result = scrubArgsForDispatch({ start_after: NIL_UUID }, schema);
    expect(result.args).toEqual({});
    expect(result.stripped).toEqual(["start_after"]);
  });

  it("strips empty string on a string field", () => {
    const schema = {
      type: "object",
      properties: { start: { type: "string" } },
    };
    const result = scrubArgsForDispatch({ start: "" }, schema);
    expect(result.args).toEqual({});
    expect(result.stripped).toEqual(["start"]);
  });

  it("strips empty array on an array field", () => {
    const schema = {
      type: "object",
      properties: { accountId: { type: "array", items: { type: "string" } } },
    };
    const result = scrubArgsForDispatch({ accountId: [] }, schema);
    expect(result.args).toEqual({});
    expect(result.stripped).toEqual(["accountId"]);
  });

  it("strips empty object on an object field", () => {
    const schema = {
      type: "object",
      properties: { filters: { type: "object" } },
    };
    const result = scrubArgsForDispatch({ filters: {} }, schema);
    expect(result.args).toEqual({});
    expect(result.stripped).toEqual(["filters"]);
  });
});

describe("scrubArgsForDispatch — keep-real-values", () => {
  it("keeps a real UUID on a uuid field", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
    };
    const input = { id: "11111111-2222-3333-4444-555555555555" };
    const result = scrubArgsForDispatch(input, schema);
    expect(result.args).toEqual(input);
    expect(result.stripped).toEqual([]);
  });

  it("keeps a non-empty string on a string field", () => {
    const schema = {
      type: "object",
      properties: { search: { type: "string" } },
    };
    const result = scrubArgsForDispatch({ search: "Wilson" }, schema);
    expect(result.args).toEqual({ search: "Wilson" });
    expect(result.stripped).toEqual([]);
  });

  it("keeps an integer with a meaningful value", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "integer" } },
    };
    const result = scrubArgsForDispatch({ limit: 300 }, schema);
    expect(result.args).toEqual({ limit: 300 });
    expect(result.stripped).toEqual([]);
  });

  it("keeps the schema's declared default value (we strip no-ops, not defaults)", () => {
    const schema = {
      type: "object",
      properties: {
        order: { type: "string", enum: ["asc", "desc"], default: "asc" },
      },
    };
    const result = scrubArgsForDispatch({ order: "asc" }, schema);
    expect(result.args).toEqual({ order: "asc" });
    expect(result.stripped).toEqual([]);
  });

  it("keeps a non-empty array even with one element", () => {
    const schema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    };
    const result = scrubArgsForDispatch({ tags: ["a"] }, schema);
    expect(result.args).toEqual({ tags: ["a"] });
    expect(result.stripped).toEqual([]);
  });
});

describe("scrubArgsForDispatch — required fields", () => {
  it("keeps a required field even if its value looks like a no-op", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const result = scrubArgsForDispatch({ id: "" }, schema);
    expect(result.args).toEqual({ id: "" });
    expect(result.stripped).toEqual([]);
  });

  it("strips optional siblings of a required field", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        cursor: { type: "string", format: "uuid" },
      },
      required: ["id"],
    };
    const result = scrubArgsForDispatch({ id: "x", cursor: NIL_UUID }, schema);
    expect(result.args).toEqual({ id: "x" });
    expect(result.stripped).toEqual(["cursor"]);
  });
});

describe("scrubArgsForDispatch — pass-through cases", () => {
  it("passes through unknown properties unchanged", () => {
    const schema = {
      type: "object",
      properties: { known: { type: "string" } },
    };
    const result = scrubArgsForDispatch({ unknown: "x" }, schema);
    expect(result.args).toEqual({ unknown: "x" });
    expect(result.stripped).toEqual([]);
  });

  it("returns input unchanged when schema has no properties", () => {
    const result = scrubArgsForDispatch({ x: "", y: NIL_UUID }, {});
    expect(result.args).toEqual({ x: "", y: NIL_UUID });
    expect(result.stripped).toEqual([]);
  });

  it("returns input unchanged on empty input", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const result = scrubArgsForDispatch({}, schema);
    expect(result.args).toEqual({});
    expect(result.stripped).toEqual([]);
  });

  it("does not strip empty string on a non-string field", () => {
    // "" on a uuid-formatted field is empty-string, which we treat as no-op
    // because the type is "string". But "" on a non-string declaration —
    // unusual but possible — should pass through.
    const schema = {
      type: "object",
      properties: { x: { type: "integer" } },
    };
    const result = scrubArgsForDispatch({ x: "" }, schema);
    expect(result.args).toEqual({ x: "" });
    expect(result.stripped).toEqual([]);
  });

  it("is idempotent — second pass strips nothing", () => {
    const schema = {
      type: "object",
      properties: {
        start_after: { type: "string", format: "uuid" },
        search: { type: "string" },
      },
    };
    const first = scrubArgsForDispatch({ start_after: NIL_UUID, search: "x" }, schema);
    const second = scrubArgsForDispatch(first.args, schema);
    expect(second.args).toEqual(first.args);
    expect(second.stripped).toEqual([]);
  });
});

describe("scrubArgsForDispatch — Mercury listTransactions smoke test", () => {
  // Fixture matches a real-world OpenAPI-derived MCP schema (the
  // listTransactions shape from Mercury's MCP). Only the properties
  // relevant to the scrubber are included; the upstream schema is larger.
  const schema = {
    type: "object",
    properties: {
      status: {
        type: "array",
        items: { type: "string" },
      },
      search: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      postedStart: { type: "string" },
      postedEnd: { type: "string" },
      accountId: { type: "array", items: { type: "string", format: "uuid" } },
      mercuryCategory: { type: "string" },
      categoryId: { type: "string" },
      start_at: { type: "string" },
      start_after: { type: "string", format: "uuid" },
      end_before: { type: "string", format: "uuid" },
      limit: { type: "integer", default: 1000 },
      order: { type: "string", enum: ["asc", "desc"], default: "asc" },
    },
    // required: null in the actual schema — no required fields
  };

  // Matches the args a model emits in practice for this schema shape:
  // sentinel placeholders on every optional cursor/date/category field
  // alongside the actually-meaningful status/search/limit/order.
  const modelInput = {
    status: ["sent"],
    search: "Wilson",
    start: "",
    end: "",
    postedStart: "",
    postedEnd: "",
    accountId: [],
    mercuryCategory: "",
    categoryId: "",
    start_at: "",
    start_after: NIL_UUID,
    end_before: NIL_UUID,
    limit: 300,
    order: "asc",
  };

  it("strips every no-op while keeping all meaningful args", () => {
    const result = scrubArgsForDispatch(modelInput, schema);

    expect(result.args).toEqual({
      status: ["sent"],
      search: "Wilson",
      limit: 300,
      order: "asc",
    });

    expect(new Set(result.stripped)).toEqual(
      new Set([
        "start",
        "end",
        "postedStart",
        "postedEnd",
        "accountId",
        "mercuryCategory",
        "categoryId",
        "start_at",
        "start_after",
        "end_before",
      ]),
    );
  });
});
