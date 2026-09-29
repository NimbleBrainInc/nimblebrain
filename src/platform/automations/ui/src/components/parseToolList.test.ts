/**
 * The form's allowed-tools field is one comma-separated string. A blank field
 * must produce no list at all, since an empty list is what "all tools" means.
 */

import { expect, test } from "bun:test";
import { parseToolList } from "./CreateAutomationForm.tsx";

test("splits on commas and trims each pattern", () => {
  expect(parseToolList(" gmail__* , files__read")).toEqual(["gmail__*", "files__read"]);
});

test("drops blanks, so an empty field yields no patterns", () => {
  expect(parseToolList("")).toEqual([]);
  expect(parseToolList(" , ,")).toEqual([]);
});
