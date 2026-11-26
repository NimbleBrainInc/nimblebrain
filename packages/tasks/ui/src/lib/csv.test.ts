/** Run on a list…: pasted CSV becomes one input per row, typed by the input schema. */
import { describe, expect, test } from "bun:test";
import { itemsFromCsv, parseCsv, parseItems } from "./csv.ts";

const SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    seats: { type: "integer" },
    active: { type: "boolean" },
  },
  required: ["company"],
  additionalProperties: false,
};

describe("parseCsv", () => {
  test("handles quotes, doubled quotes, commas inside quotes, and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
});

describe("itemsFromCsv", () => {
  test("maps headers to fields and coerces each cell to its type", () => {
    const out = itemsFromCsv("company,seats,active\nAcme,12,yes\nGlobex,,false", SCHEMA);
    expect(out.errors).toEqual([]);
    expect(out.items).toEqual([
      { company: "Acme", seats: 12, active: true },
      { company: "Globex", active: false },
    ]);
  });

  test("refuses a column the schema does not have, and a missing required one", () => {
    expect(itemsFromCsv("company,extra\nA,1", SCHEMA).errors[0]).toContain("extra");
    expect(itemsFromCsv("seats\n1", SCHEMA).errors[0]).toContain("company");
  });

  test("names the row and field of a bad cell", () => {
    const out = itemsFromCsv("company,seats\nAcme,many", SCHEMA);
    expect(out.items).toEqual([]);
    expect(out.errors[0]).toBe('Row 1, seats: "many" is not a number.');
  });

  test("a required cell left empty is reported", () => {
    expect(itemsFromCsv("company,seats\n,3", SCHEMA).errors[0]).toBe("Row 1: company is required.");
  });

  test("without a schema every cell is a string", () => {
    expect(itemsFromCsv("a,b\n1,true").items).toEqual([{ a: "1", b: "true" }]);
  });

  test("lists at most five row problems", () => {
    const rows = Array.from({ length: 8 }, () => "x,notanumber").join("\n");
    const out = itemsFromCsv(`company,seats\n${rows}`, SCHEMA);
    expect(out.errors).toHaveLength(6);
    expect(out.errors[5]).toBe("…and 3 more.");
  });
});

describe("parseItems", () => {
  test("a JSON array is taken as is", () => {
    expect(parseItems('[{"company":"A"}, 2]')).toEqual({
      items: [{ company: "A" }, 2],
      errors: [],
      format: "json",
    });
  });

  test("bad JSON, an empty array, and empty text", () => {
    expect(parseItems("[1,").errors[0]).toContain("Not valid JSON");
    expect(parseItems("[]").errors).toEqual(["The array is empty."]);
    expect(parseItems("   ").format).toBe("empty");
  });

  test("anything else is CSV", () => {
    expect(parseItems("company\nAcme", SCHEMA).items).toEqual([{ company: "Acme" }]);
  });
});
