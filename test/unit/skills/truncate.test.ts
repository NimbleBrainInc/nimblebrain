/**
 * Unit tests for the structure-aware markdown truncator.
 *
 * Verifies budget enforcement, section preservation, and fallback behavior
 * when a single section exceeds the budget. Replaces mid-string slicing
 * that bit production (a bundle "rules" appendix was lost mid-rule).
 */

import { describe, expect, test } from "bun:test";
import { truncateMarkdownToBudget } from "../../../src/skills/truncate.ts";

describe("truncateMarkdownToBudget", () => {
  test("no-op when content fits within budget", () => {
    const content = "# Title\n\nShort body.";
    const result = truncateMarkdownToBudget(content, 1000);
    expect(result.body).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.sectionsOmitted).toBe(0);
  });

  test("drops trailing sections when budget exceeded", () => {
    // Each section: heading (3) + newline (1) + 80 chars = ~84
    const sectionA = `# A\n${"a".repeat(80)}`;
    const sectionB = `# B\n${"b".repeat(80)}`;
    const sectionC = `# C\n${"c".repeat(80)}`;
    const content = `${sectionA}\n${sectionB}\n${sectionC}`;
    // Content is ~254 chars. Budget 200 with 64-char marker reserve leaves
    // ~136 for body — fits A+B (~169) won't fit; just A (~84) fits.
    const result = truncateMarkdownToBudget(content, 200);
    expect(result.truncated).toBe(true);
    expect(result.sectionsOmitted).toBeGreaterThanOrEqual(1);
    expect(result.body).toContain("# A");
    expect(result.body).not.toContain("# C");
    expect(result.body).toMatch(/\[truncated/);
  });

  test("drops multiple trailing sections and pluralizes marker", () => {
    const sections = ["# A", "# B", "# C", "# D"]
      .map((h) => `${h}\n${"x".repeat(30)}`)
      .join("\n");
    // Only fit ~one section after marker reserve.
    const result = truncateMarkdownToBudget(sections, 100);
    expect(result.truncated).toBe(true);
    expect(result.sectionsOmitted).toBeGreaterThanOrEqual(2);
    expect(result.body).toMatch(/\[truncated: \d+ sections omitted\]/);
  });

  test("falls back to paragraph-break truncation when first section is too large", () => {
    // Single huge section, well over budget, with paragraph breaks.
    const para1 = "Paragraph one with some text.";
    const para2 = "Paragraph two has different content here.";
    const para3 = "Paragraph three sits at the end of the section.";
    const content = `# Only Section\n\n${para1}\n\n${para2}\n\n${para3}`;
    // Budget just big enough for the heading + first paragraph after marker reserve.
    const result = truncateMarkdownToBudget(content, 120);
    expect(result.truncated).toBe(true);
    expect(result.body).toContain("# Only Section");
    expect(result.body).toContain(para1);
    // Should NOT include the last paragraph.
    expect(result.body).not.toContain(para3);
    // Truncation marker present.
    expect(result.body).toMatch(/\[truncated/);
  });

  test("falls back to line break when no paragraph break fits", () => {
    // Single section, no `\n\n` break inside the budget — should still
    // cut at a newline (no mid-line slice).
    const longLine1 = "a".repeat(100);
    const longLine2 = "b".repeat(100);
    const content = `# Big\n${longLine1}\n${longLine2}`;
    const result = truncateMarkdownToBudget(content, 80);
    expect(result.truncated).toBe(true);
    // No mid-line slice: the body should end at a newline boundary, not
    // mid-`a`s or mid-`b`s.
    const bodyBeforeMarker = result.body.split("\n\n[truncated")[0]!;
    // Either ends right after "# Big" (line break) or includes some run
    // that ends at a newline — never partial line.
    expect(bodyBeforeMarker.endsWith("a") && !bodyBeforeMarker.endsWith("\n"))
      .toBe(false);
  });

  test("empty content returns empty result", () => {
    const result = truncateMarkdownToBudget("", 1000);
    expect(result.body).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.sectionsOmitted).toBe(0);
  });

  test("budget of 0 returns empty body and flags truncation when content present", () => {
    const result = truncateMarkdownToBudget("# Hello", 0);
    expect(result.body).toBe("");
    expect(result.truncated).toBe(true);
  });

  test("handles preamble before first heading as its own section", () => {
    const content = `Some preamble text.\n\n# First Heading\nbody\n# Second Heading\nmore body`;
    // Budget that fits preamble and first section but not second.
    const result = truncateMarkdownToBudget(content, 120);
    if (result.truncated) {
      expect(result.body).toContain("preamble text");
    } else {
      expect(result.body).toBe(content);
    }
  });

  test("preserves all headings of varying depths", () => {
    const content = `# H1\nbody\n## H2\nbody\n### H3\nbody\n#### H4\nbody`;
    const result = truncateMarkdownToBudget(content, 10_000);
    // Under budget — should be unchanged.
    expect(result.body).toBe(content);
    expect(result.truncated).toBe(false);
  });

  test("realistic 6.5KB skill body fits within 12000 budget unchanged", () => {
    // Mirrors the actual production case: synapse-collateral's SKILL.md
    // is ~6.5KB, well below the 12000 budget.
    const fakeSkill = [
      "# Collateral Studio",
      "Voice substitution placeholder section.",
      "## Tool Selection",
      "x".repeat(2000),
      "## Error Recovery",
      "y".repeat(2000),
      "## Rules",
      "z".repeat(2000),
    ].join("\n\n");
    const result = truncateMarkdownToBudget(fakeSkill, 12000);
    expect(result.truncated).toBe(false);
    expect(result.body).toContain("## Rules");
    // Critical: the trailing "Rules" section MUST survive (this was the
    // mid-rule slicing bug we're fixing).
    expect(result.body.endsWith("z".repeat(2000))).toBe(true);
  });
});
