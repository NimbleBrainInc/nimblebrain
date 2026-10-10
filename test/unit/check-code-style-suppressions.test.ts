import { describe, expect, test } from "bun:test";
import { isPlaceholderReason, suppressionReason } from "../../scripts/check-code-style.ts";

/**
 * The suppression-reason pass catches only reasons that say nothing; whether
 * a real reason holds is left to review. These pin both halves: the
 * placeholder forms are flagged, and a reason with substance passes even when
 * it opens with one of those words.
 */
const flagged = (line: string) => {
  const reason = suppressionReason(line);
  return reason !== null && isPlaceholderReason(reason);
};

describe("suppressionReason", () => {
  test("reads the reason from a line comment and a JSX comment", () => {
    expect(suppressionReason("  // biome-ignore lint/a/b: Stable.")).toBe("stable");
    expect(
      suppressionReason("      {/* biome-ignore lint/a11y/x: the backdrop is not a control */}"),
    ).toBe("the backdrop is not a control");
  });

  test("is null for a line with no suppression", () => {
    expect(suppressionReason("const x = 1; // not a suppression")).toBeNull();
  });
});

describe("isPlaceholderReason", () => {
  test("flags a reason that only asserts the suppression is wanted", () => {
    expect(flagged("// biome-ignore lint/suspicious/noArrayIndexKey: intentional")).toBe(true);
    expect(
      flagged("// biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on mount"),
    ).toBe(true);
    expect(flagged("// biome-ignore lint/suspicious/noExplicitAny: Safe.")).toBe(true);
  });

  test("flags a reason that points at another comment", () => {
    expect(flagged("// biome-ignore lint/suspicious/noArrayIndexKey: same as above")).toBe(true);
    expect(flagged("// biome-ignore lint/a11y/useSemanticElements: see above")).toBe(true);
  });

  test("passes a reason with substance", () => {
    expect(
      flagged(
        "// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars is the mitigation",
      ),
    ).toBe(false);
    expect(
      flagged(
        "// biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the data changes",
      ),
    ).toBe(false);
  });
});
