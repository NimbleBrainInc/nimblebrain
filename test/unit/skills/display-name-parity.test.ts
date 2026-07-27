/**
 * "What is this skill called, given only its id" exists in three places, each
 * forced by a boundary that forbids sharing code: the runtime leaf, the
 * conversations bundle (deployable independently), and the web tier (can't
 * import from `src/`).
 *
 * They must agree. The defect this whole change fixes was one copy of a naming
 * rule being refined while another sat a directory away without it, so every
 * connector skill rendered as `SKILL` — a divergence no test would have caught,
 * because each copy was individually consistent.
 *
 * Table-driven over the shapes that actually reach these: the SEP-2640
 * entrypoint (where the name is the *directory*, which is the case that broke),
 * filesystem skills, and the in-memory sentinel.
 */

import { describe, expect, test } from "bun:test";
import { skillNameFromId } from "../../../src/bundles/conversations/src/jsonl-reader.ts";
import { skillDisplayName } from "../../../src/skills/display-name.ts";
import { nameFromSkillId } from "../../../web/src/lib/skill-display.ts";

const CASES: Array<[id: string, expected: string]> = [
  // The entrypoint case: every connector skill's id ends in `/SKILL.md`, so a
  // last-segment rule names them all `SKILL`.
  ["skill://acme/billing/refunds/SKILL.md", "refunds"],
  ["skill://bassethound/upgrade/SKILL.md", "upgrade"],
  ["skill://git-workflow/SKILL.md", "git-workflow"],
  // Filesystem skills.
  ["/work/skills/release-notes.md", "release-notes"],
  ["skills/mpak-guide.md", "mpak-guide"],
  ["release-notes.md", "release-notes"],
  // In-memory sentinel (workspace identity override) — no path, no extension.
  ["skill-in-memory:identity-override", "skill-in-memory:identity-override"],
  // Degenerate: a bare entrypoint with no directory to name it.
  ["SKILL.md", "SKILL"],
];

describe("skill-name derivation — all three copies agree", () => {
  for (const [id, expected] of CASES) {
    test(`${id} → ${expected}`, () => {
      // The runtime copy takes the whole entry; with no recorded `name` it
      // falls through to the derivation, which is what is under test.
      expect(skillDisplayName({ id })).toBe(expected);
      expect(skillNameFromId(id)).toBe(expected);
      expect(nameFromSkillId(id)).toBe(expected);
    });
  }

  test("a recorded name always wins over the derivation", () => {
    expect(skillDisplayName({ id: "skill://acme/billing/SKILL.md", name: "billing" })).toBe(
      "billing",
    );
  });
});
