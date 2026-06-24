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

import { bareToolName } from "../tools/namespace.ts";
import type { Skill } from "./types.ts";

/**
 * How a skill ended up in the Layer-3 selected set. Layer 3 is the conditional
 * channel for `dynamic` skills; today the only mechanism is tool-affinity.
 * (`always` skills compose into the context channel, not here.)
 */
export type LoadedBy = "tool_affinity";

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
 * Match a tool name against a `tool-affinity` glob pattern.
 *
 * Supported patterns:
 *  - `*` — matches anything
 *  - `<prefix>__*` — starts-with check
 *  - `*__<suffix>` — ends-with check
 *  - exact equality otherwise
 *
 * Empty pattern returns false. More complex patterns (e.g. `*__patch_*`) are
 * out of scope for Phase 2 — they fall through to exact-match, so they only
 * match the literal pattern string.
 *
 * Stage 2 (T006) — tool names from the cross-workspace aggregator carry a
 * `ws_<id>-` namespace prefix. Patterns in skill manifests and `appContext`-
 * driven affinity rules are typically authored against the BARE form
 * (`<source>__*`). Match against both the full namespaced name AND the
 * bare inner form so legacy patterns keep working unchanged and
 * namespace-aware patterns (`ws_<id>-<source>__*`) also match precisely.
 */
export function toolMatches(toolName: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (pattern === "*") return true;

  // Derive the inner form once. If `toolName` is namespaced
  // (`ws_<id>-<inner>`) we strip the prefix and try both forms; otherwise
  // we just use the original name. Two candidates keeps the matcher's
  // logic shape (one pattern, one rule) intact below. Stripping goes
  // through the canonical `bareToolName` parser so the separator lives in
  // exactly one place.
  const inner = bareToolName(toolName);
  const candidates = inner === toolName ? [toolName] : [toolName, inner];

  if (pattern.endsWith("__*")) {
    const prefix = pattern.slice(0, -1);
    return candidates.some((c) => c.startsWith(prefix));
  }
  if (pattern.startsWith("*__")) {
    const suffix = pattern.slice(1);
    return candidates.some((c) => c.endsWith(suffix));
  }
  return candidates.some((c) => c === pattern);
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
