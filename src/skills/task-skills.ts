/**
 * The skills an unattended run's definition names (`TaskRequest.skills`).
 *
 * A task that names a skill means every run uses it, so its body belongs in the
 * run's cached system prompt from the first model call, beside the Layer 3
 * skills tool-affinity selected. Loading it with `nb__use_skill` instead costs a
 * model call, and puts the body after the run's own input, where no other run
 * can reuse its cache.
 *
 * Pure function over the pools composition already holds; no filesystem
 * access, no body fetch, no event emission.
 */

import type { SelectedSkill } from "./select.ts";
import type { Skill } from "./types.ts";

export interface TaskSkillSelection {
  /** Skills to compose as Layer 3, in the order named, bodies not yet fetched. */
  selected: SelectedSkill[];
  /** Names nothing in the pools resolves to an active skill. */
  missing: string[];
}

/** The identity a skill is de-duplicated by across channels. */
function keyOf(skill: Skill): string {
  return skill.sourcePath || `name:${skill.manifest.name}`;
}

/**
 * Resolve the names a task gives against the run's skill pools.
 *
 * - `alwaysOn`: skills already composed every run (the context channel). A name
 *   among them is already in the prompt, so it is neither added nor missing.
 * - `alreadySelected`: the run's tool-affinity Layer 3 selection. A skill there
 *   is composed once, as that selection.
 * - `capability`: the activatable skills, filesystem tiers first, then the
 *   workspace's server-published skills, the order `nb__use_skill` resolves a
 *   name in. The first active skill of a name wins.
 */
export function selectTaskSkills(input: {
  names: readonly string[];
  alwaysOn: readonly Skill[];
  alreadySelected: readonly SelectedSkill[];
  capability: readonly Skill[];
}): TaskSkillSelection {
  const composed = new Set(input.alwaysOn.map((s) => s.manifest.name));
  const selectedKeys = new Set(input.alreadySelected.map((s) => keyOf(s.skill)));
  const selected: SelectedSkill[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const name of input.names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (composed.has(name)) continue;
    const skill = input.capability.find(
      (s) => s.manifest.name === name && s.manifest.status === "active",
    );
    if (!skill) {
      missing.push(name);
      continue;
    }
    if (selectedKeys.has(keyOf(skill))) continue;
    selectedKeys.add(keyOf(skill));
    selected.push({ skill, loadedBy: "task", reason: "named by the task" });
  }
  return { selected, missing };
}
