/**
 * `selectTaskSkills`: the names a task gives, resolved against the run's skill
 * pools. Each resolves to at most one Layer 3 entry, and a name nothing
 * resolves is reported missing so the run can be refused.
 */

import { describe, expect, test } from "bun:test";
import type { SelectedSkill } from "../../../src/skills/select.ts";
import { selectTaskSkills } from "../../../src/skills/task-skills.ts";
import type { Skill, SkillStatus } from "../../../src/skills/types.ts";

function makeSkill(name: string, opts: { status?: SkillStatus; sourcePath?: string } = {}): Skill {
  return {
    manifest: {
      name,
      description: `${name} description`,
      loadingStrategy: "dynamic",
      priority: 50,
      status: opts.status ?? "active",
    },
    body: `# ${name}\n`,
    sourcePath: opts.sourcePath ?? `/virtual/${name}.md`,
  };
}

const RUNBOOK = makeSkill("invoice-runbook");
const CHECKLIST = makeSkill("close-checklist");

const names = (sel: SelectedSkill[]) => sel.map((s) => s.skill.manifest.name);

describe("selectTaskSkills", () => {
  test("resolves each name in the order given, tagged loadedBy task", () => {
    const { selected, missing } = selectTaskSkills({
      names: ["close-checklist", "invoice-runbook"],
      alwaysOn: [],
      alreadySelected: [],
      overlays: [],
      capability: [RUNBOOK, CHECKLIST],
    });
    expect(names(selected)).toEqual(["close-checklist", "invoice-runbook"]);
    expect(selected.every((s) => s.loadedBy === "task")).toBe(true);
    expect(missing).toEqual([]);
  });

  test("reports a name with no active skill as missing", () => {
    const { selected, missing } = selectTaskSkills({
      names: ["invoice-runbook", "no-such-skill", "close-checklist"],
      alwaysOn: [],
      alreadySelected: [],
      overlays: [],
      capability: [RUNBOOK, makeSkill("close-checklist", { status: "disabled" })],
    });
    expect(names(selected)).toEqual(["invoice-runbook"]);
    expect(missing).toEqual(["no-such-skill", "close-checklist"]);
  });

  test("leaves out a skill tool-affinity already selected, so it composes once", () => {
    const { selected, missing } = selectTaskSkills({
      names: ["invoice-runbook"],
      alwaysOn: [],
      alreadySelected: [{ skill: RUNBOOK, loadedBy: "tool_affinity", reason: "matched" }],
      overlays: [],
      capability: [RUNBOOK],
    });
    expect(selected).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("leaves out an always-on skill, which every run already carries", () => {
    const voice = makeSkill("house-voice");
    const { selected, missing } = selectTaskSkills({
      names: ["house-voice"],
      alwaysOn: [voice],
      alreadySelected: [],
      overlays: [],
      capability: [],
    });
    expect(selected).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("takes the first active skill of a name, as nb__use_skill does", () => {
    const workspaceTier = makeSkill("invoice-runbook", { sourcePath: "/ws/invoice-runbook.md" });
    const published = makeSkill("invoice-runbook", { sourcePath: "skill://srv/invoice-runbook" });
    const { selected } = selectTaskSkills({
      names: ["invoice-runbook"],
      alwaysOn: [],
      alreadySelected: [],
      overlays: [],
      capability: [workspaceTier, published],
    });
    expect(selected.map((s) => s.skill.sourcePath)).toEqual(["/ws/invoice-runbook.md"]);
  });

  test("a name given twice resolves once", () => {
    const { selected } = selectTaskSkills({
      names: ["invoice-runbook", "invoice-runbook"],
      alwaysOn: [],
      alreadySelected: [],
      overlays: [],
      capability: [RUNBOOK],
    });
    expect(names(selected)).toEqual(["invoice-runbook"]);
  });

  test("defers a name only a connector overlay holds; a filesystem or published skill wins", () => {
    const { selected, deferred, missing } = selectTaskSkills({
      names: ["crm-guide", "invoice-runbook", "no-such-skill"],
      alwaysOn: [],
      alreadySelected: [],
      overlays: ["crm-guide", "invoice-runbook"],
      capability: [RUNBOOK],
    });
    expect(names(selected)).toEqual(["invoice-runbook"]);
    expect(deferred).toEqual(["crm-guide"]);
    expect(missing).toEqual(["no-such-skill"]);
  });
});
