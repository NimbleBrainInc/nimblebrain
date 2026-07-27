/**
 * Layer 3 skill selection (the conditional channel).
 *
 * Pure function over (skills, activeTools) → selected skills with reason
 * metadata. Selects `dynamic` skills whose `tool-affinity` globs match an active
 * tool. `always` skills compose into the context channel (Layer 0/1), not here;
 * a `dynamic` skill with no tool-affinity is catalog-only (model-activated).
 *
 * No filesystem access, no event emission, no global state.
 */

import { toolNameMatchesPattern } from "../tools/tool-pattern.ts";
import type { Skill } from "./types.ts";

/**
 * How a skill ended up composed into a turn's prompt — the loading mechanism,
 * for `skills.loaded` telemetry:
 *   - `always`        — always-on context skill (composes every turn by role)
 *   - `tool_affinity` — `dynamic` skill whose tool-affinity glob matched an
 *     active tool (Layer 3, the conditional channel this module selects)
 *   - `trigger`       — `dynamic` skill whose trigger phrase matched the message
 *     (Layer 4, the `SkillMatcher`)
 *
 * `selectLayer3Skills` only ever produces `tool_affinity`; the other two are
 * stamped at the telemetry-collection site (`collectLoadedSkills`).
 */
export type LoadedBy = "always" | "tool_affinity" | "trigger";

export interface SelectedSkill {
  skill: Skill;
  loadedBy: LoadedBy;
  /** Human-readable explanation, suitable for telemetry. */
  reason: string;
}

export interface SelectInput {
  /** Layer 3 skills to consider — already merged across scopes. */
  skills: Skill[];
  /** Names of tools currently in the active tool set. */
  activeTools: string[];
}

/**
 * Glob-match a tool name against a skill's `toolAffinity` pattern.
 *
 * A thin alias for `toolNameMatchesPattern`, the single matcher shared with
 * `surfacing.ts`. Kept as a named export because `toolAffinity` is its own
 * concept at this layer; see that function for the pattern grammar and for why
 * the retired `ws_<id>-` prefix is normalized on both sides while the `my_`
 * personal-connector marker is normalized on neither.
 */
export function toolMatches(toolName: string, pattern: string): boolean {
  return toolNameMatchesPattern(toolName, pattern);
}

/**
 * Select Layer 3 skills for the current turn: `dynamic` skills whose
 * `toolAffinity` globs match a tool in the active set. `always` skills are NOT
 * here — they compose into the context channel (Layer 0/1) by role. A `dynamic`
 * skill with no `toolAffinity` is catalog-only (model-activated; not selected
 * here until the catalog ships). Disabled skills are skipped.
 *
 * Returned sorted by `manifest.priority` ascending (lowest = highest priority).
 */
export function selectLayer3Skills(input: SelectInput): SelectedSkill[] {
  const selected: SelectedSkill[] = [];

  for (const skill of input.skills) {
    const { manifest } = skill;

    if (manifest.status !== "active") continue;
    if (manifest.loadingStrategy !== "dynamic") continue;

    const patterns = manifest.toolAffinity;
    if (!patterns || patterns.length === 0) continue;

    const matched = patterns.filter((pattern) =>
      input.activeTools.some((tool) => toolMatches(tool, pattern)),
    );
    if (matched.length === 0) continue;

    selected.push({
      skill,
      loadedBy: "tool_affinity",
      reason: `tool-affinity matched ${matched.join(", ")}`,
    });
  }

  selected.sort((a, b) => a.skill.manifest.priority - b.skill.manifest.priority);
  return selected;
}

/**
 * Partition a conversation skill pool by ROLE — the single composition-routing
 * authority. A skill's `loading-strategy` decides its channel, by construction:
 *
 *  - `always` → always-on identity/voice content. Goes to the context channel
 *    (Layer 0/1), rendered from every tier (core/builtin/org + workspace + user),
 *    sorted by priority. Disabled skills are dropped here (the always-on
 *    channel has no per-turn status gate of its own).
 *  - `dynamic` → capability content for the conditional channels: tool-affinity
 *    Layer 3 (`selectLayer3Skills`) and the trigger matcher.
 *
 * The two sets are DISJOINT by `loading-strategy`, so a skill can never enter
 * two channels — there is no overlap to de-duplicate downstream.
 *
 * NOTE — this is the PER-CONVERSATION router (drops disabled skills). Its
 * boot-time counterpart is `partitionSkills` in `loader.ts`, which partitions
 * the raw cache once and keeps disabled `always` skills. Pick by call site.
 */
export function partitionSkillsByRole(pool: Skill[]): { context: Skill[]; capability: Skill[] } {
  const context: Skill[] = [];
  const capability: Skill[] = [];
  for (const s of pool) {
    if (s.manifest.loadingStrategy === "always") {
      if (s.manifest.status === "active") context.push(s);
    } else {
      capability.push(s);
    }
  }
  context.sort((a, b) => a.manifest.priority - b.manifest.priority);
  return { context, capability };
}
