/** The criteria editor says what the runtime would refuse before a save is sent. */
import { describe, expect, test } from "bun:test";
import {
  draftFromVerdict,
  draftsValid,
  emptyDraft,
  fromCriteria,
  idFromRule,
  toCriteria,
  validateDrafts,
} from "./criteria.ts";

function draft(patch: Partial<ReturnType<typeof emptyDraft>>) {
  return { ...emptyDraft("c1"), rule: "Cites a source", ...patch };
}

describe("validateDrafts", () => {
  test("a boolean rule with an id is valid", () => {
    expect(draftsValid([draft({})])).toBe(true);
  });

  test("needs an id of the allowed shape, a rule, and unique ids", () => {
    const { items } = validateDrafts([
      draft({ id: "has space" }),
      draft({ id: "dup", rule: "" }),
      draft({ id: "dup" }),
    ]);
    expect(items[0]?.[0]).toContain("Id:");
    expect(items[1]).toContain("Write the rule.");
    expect(items[1]).toContain('Another criterion has the id "dup".');
  });

  test("a score needs 2 to 10 distinct levels and a passing level among them", () => {
    expect(validateDrafts([draft({ type: "score", levels: "only" })]).items[0]).toContain(
      "A score needs 2 to 10 levels.",
    );
    expect(validateDrafts([draft({ type: "score", levels: "a\na" })]).items[0]).toContain(
      "Levels must differ.",
    );
    expect(
      validateDrafts([draft({ type: "score", levels: "low\nhigh", passLevel: 2 })]).items[0],
    ).toContain("The passing level is not one of the levels.");
  });

  test("a choice needs options and at least one passing option", () => {
    const { items } = validateDrafts([draft({ type: "choice", options: "yes\nno" })]);
    expect(items[0]).toContain("Pick the option or options that pass.");
    expect(draftsValid([draft({ type: "choice", options: "yes\nno", passOptions: ["yes"] })])).toBe(
      true,
    );
  });

  test("caps the list at 50", () => {
    const many = Array.from({ length: 51 }, (_, i) => draft({ id: `c${i}` }));
    expect(validateDrafts(many).list[0]).toContain("50");
  });
});

describe("toCriteria / fromCriteria", () => {
  test("round-trip every type", () => {
    const drafts = [
      draft({ id: "a", passTrue: false }),
      draft({ id: "b", type: "score", levels: "low\nmid\nhigh", passLevel: 1 }),
      draft({ id: "c", type: "choice", options: "x\ny\nz", passOptions: ["x", "z"] }),
      draft({ id: "d", type: "choice", options: "x\ny", passOptions: ["y"] }),
    ];
    const criteria = toCriteria(drafts);
    expect(criteria).toEqual([
      { id: "a", rule: "Cites a source", type: "boolean", pass: false },
      { id: "b", rule: "Cites a source", type: "score", levels: ["low", "mid", "high"], pass: 1 },
      {
        id: "c",
        rule: "Cites a source",
        type: "choice",
        options: ["x", "y", "z"],
        pass: ["x", "z"],
      },
      { id: "d", rule: "Cites a source", type: "choice", options: ["x", "y"], pass: "y" },
    ]);
    expect(toCriteria(fromCriteria(criteria))).toEqual(criteria);
  });

  test("a default boolean sends no pass", () => {
    expect(toCriteria([draft({})])[0]).toEqual({
      id: "c1",
      rule: "Cites a source",
      type: "boolean",
    });
  });
});

describe("seeding from a verdict", () => {
  test("an id from the rule's first words, unique", () => {
    expect(idFromRule("Every claim cites a source!", [])).toBe("every-claim-cites-a");
    expect(idFromRule("Every claim cites a source", ["every-claim-cites-a"])).toBe(
      "every-claim-cites-a-2",
    );
    expect(idFromRule("!!!", [])).toBe("criterion");
  });

  test("accept keeps the note as the rule; reject rules the problem out", () => {
    expect(draftFromVerdict("pass", "Lists three prospects", []).rule).toBe(
      "Lists three prospects",
    );
    const bad = draftFromVerdict("fail", "No sources", []);
    expect(bad.rule).toBe("The deliverable does not have this problem: No sources");
    expect(bad.id).toBe("no-sources");
    expect(draftsValid([bad])).toBe(true);
  });
});
