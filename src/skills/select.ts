/**
 * Skill routing by role, and the tool-affinity glob matcher.
 *
 * `always` skills compose into the context channel every turn. A `dynamic`
 * skill bound to tools reaches the model before the first call to one of them
 * (the engine's hold, ADR-0053); one bound to nothing is loaded from the
 * catalog when the model asks.
 *
 * No filesystem access, no event emission, no global state.
 */

import { toolNameMatchesPattern } from "../tools/tool-pattern.ts";
import type { Skill } from "./types.ts";

/**
 * How a skill ended up composed into a turn's prompt, for `skills.loaded`
 * telemetry:
 *   - `always`        — always-on context skill (composes every turn by role)
 *   - `trigger`       — `dynamic` skill whose trigger phrase matched the message
 *     (the `SkillMatcher`)
 *   - `tool_affinity` — read only: recorded runs from before bound skills moved
 *     to the engine's hold carry it, and nothing emits it now (ADR-0034).
 *
 * Stamped at the telemetry-collection site (`collectLoadedSkills`).
 */
export type LoadedBy = "always" | "tool_affinity" | "trigger";

export interface SelectedSkill {
  skill: Skill;
  loadedBy: LoadedBy;
  /** Human-readable explanation, suitable for telemetry. */
  reason: string;
}

/**
 * Glob-match a tool name against a skill's `toolAffinity` pattern.
 *
 * A thin alias for `toolNameMatchesPattern`, the single matcher shared with
 * `surfacing.ts`. Kept as a named export because `toolAffinity` is its own
 * concept at this layer; see that function for the pattern grammar.
 */
export function toolMatches(toolName: string, pattern: string): boolean {
  return toolNameMatchesPattern(toolName, pattern);
}

/**
 * Partition a conversation skill pool by ROLE — the single composition-routing
 * authority. A skill's `loading-strategy` decides its channel, by construction:
 *
 *  - `always` → always-on identity/voice content. Goes to the context channel
 *    (Layer 0/1), rendered from every tier (core/builtin/org + workspace + user),
 *    sorted by priority. Disabled skills are dropped here (the always-on
 *    channel has no per-turn status gate of its own).
 *  - `dynamic` → capability content: delivered before its bound tool's first
 *    call, by a trigger phrase, or from the catalog.
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
