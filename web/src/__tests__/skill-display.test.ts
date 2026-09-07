// ---------------------------------------------------------------------------
// skill-display — the shared ledger display helpers.
//
// Covered here rather than incidentally through the two component tests,
// because two of these branches are load-bearing and neither surface exercises
// them: an unrecognized loading mechanism (which must appear, not vanish), and
// a connector-tier skill with no recorded connector (every run predating the
// field), which is the back-compat claim.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import {
  groupByMechanism,
  nameFromSkillId,
  SCOPE_CLASS,
  SCOPE_LABEL,
  skillProvenanceLabel,
} from "../lib/skill-display";

describe("skillProvenanceLabel", () => {
  test("names the publishing connector when there is one", () => {
    expect(skillProvenanceLabel({ scope: "provided", connector: "acme-mcp" })).toBe("acme-mcp");
  });

  // A row recorded before the entry carried a `connector` field has the tier
  // and nothing else. In the ledger that tier can only be a connector's own
  // guidance, so it reads "connector" rather than the stored tier name.
  test("falls back to the tier, which reads `connector` for the provided tier", () => {
    expect(skillProvenanceLabel({ scope: "provided" })).toBe("connector");
    expect(skillProvenanceLabel({ scope: "org" })).toBe("org");
    expect(skillProvenanceLabel({ scope: "workspace" })).toBe("workspace");
    expect(skillProvenanceLabel({ scope: "user" })).toBe("user");
  });

  // A recorded event may name a tier this build's union does not list — the
  // runtime never rewrites history to match a later vocabulary (ADR-0034).
  // The row reads as what it was, not as a blank.
  test("falls back to the stored string for a tier the union no longer lists", () => {
    expect(skillProvenanceLabel({ scope: "retired-tier" as never })).toBe("retired-tier");
  });

  test("no label or class exposes the tier's wire name", () => {
    expect(Object.values(SCOPE_LABEL)).not.toContain("provided");
    expect(Object.values(SCOPE_CLASS)).not.toContain("ledger-scope--provided");
    expect(SCOPE_CLASS.provided).toBe("ledger-scope--connector");
  });
});

describe("groupByMechanism", () => {
  const skill = (name: string, loadedBy: string) => ({ name, loadedBy });

  test("orders unconditional loads before matched ones", () => {
    const groups = groupByMechanism([
      skill("b", "tool_affinity"),
      skill("c", "trigger"),
      skill("a", "always"),
    ]);
    expect(groups.map((g) => g.mechanism)).toEqual(["always", "tool_affinity", "trigger"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Always on",
      "Matched your tools",
      "Matched what you said",
    ]);
  });

  test("preserves input order within a group", () => {
    const groups = groupByMechanism([
      skill("first", "tool_affinity"),
      skill("second", "tool_affinity"),
    ]);
    expect(groups[0]!.skills.map((s) => s.name)).toEqual(["first", "second"]);
  });

  // A mechanism added to the runtime must show up unlabelled rather than be
  // dropped — silently losing a row would misreport what equipped the turn.
  test("an unrecognized mechanism appears last, under its own raw key", () => {
    const groups = groupByMechanism([skill("x", "semantic_match"), skill("a", "always")]);
    expect(groups.map((g) => g.mechanism)).toEqual(["always", "semantic_match"]);
    expect(groups[1]!.label).toBe("semantic_match");
    expect(groups[1]!.skills).toHaveLength(1);
  });

  test("no groups for no skills", () => {
    expect(groupByMechanism([])).toEqual([]);
  });
});

describe("nameFromSkillId", () => {
  // The guard exists so a frame missing `name` can't print a raw entrypoint
  // URI — the exact output the ledger work removed.
  test("names a connector skill by its directory, not the entrypoint file", () => {
    expect(nameFromSkillId("skill://acme/billing/refunds/SKILL.md")).toBe("refunds");
    expect(nameFromSkillId("skill://git-workflow/SKILL.md")).toBe("git-workflow");
  });

  test("strips the extension from a filesystem skill", () => {
    expect(nameFromSkillId("/work/skills/release-notes.md")).toBe("release-notes");
  });
});
