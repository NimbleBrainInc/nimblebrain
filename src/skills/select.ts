/**
 * Phase 2 — Layer 3 skill selection.
 *
 * Pure function over (skills, activeTools) → selected skills with reason
 * metadata. Implements the `always` and `tool_affined` loading strategies.
 * Future strategies (`retrieval`, `explicit`) are accepted as input without
 * throwing, but produce no output in Phase 2.
 *
 * No filesystem access, no event emission, no global state — designed to be
 * trivially composed into the runtime by Task 006.
 */

import { bareToolName } from "../tools/namespace.ts";
import type { Skill } from "./types.ts";

/**
 * Phase 2 values for how a skill ended up in the selected set.
 *
 * Phase 6 will add `"retrieval"`; Phase 7 will add `"explicit"`.
 *
 * Note: the loading-strategy NAME is `tool_affined` (manifest field), but the
 * `loadedBy` value emitted on the `skills.loaded` event is `tool_affinity`.
 * That's deliberate per the spec event shape.
 */
export type LoadedBy = "always" | "tool_affinity";

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
 * Match a tool name against an `applies_to_tools` glob pattern.
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
 * Select Layer 3 skills for the current turn based on each skill's
 * `loadingStrategy` and the active tool set.
 *
 * Phase 2: implements `always` and `tool_affined` only.
 *  - Skills with `status !== "active"` are skipped.
 *  - Skills with no `loadingStrategy` are skipped (they remain on the legacy
 *    `SkillMatcher` path — they're not Layer 3 candidates yet).
 *  - Future strategies (`retrieval`, `explicit`) are skipped silently.
 *
 * Returned skills are sorted by `manifest.priority` ascending (lowest number =
 * highest priority).
 */
export function selectLayer3Skills(input: SelectInput): SelectedSkill[] {
  const selected: SelectedSkill[] = [];

  for (const skill of input.skills) {
    const { manifest } = skill;

    if (manifest.status !== undefined && manifest.status !== "active") {
      continue;
    }

    const strategy = manifest.loadingStrategy;
    if (strategy === undefined) {
      continue;
    }

    if (strategy === "always") {
      selected.push({
        skill,
        loadedBy: "always",
        reason: "loading_strategy: always",
      });
      continue;
    }

    if (strategy === "tool_affined") {
      const patterns = manifest.appliesToTools;
      if (!patterns || patterns.length === 0) {
        continue;
      }
      const matched: string[] = [];
      for (const pattern of patterns) {
        if (input.activeTools.some((tool) => toolMatches(tool, pattern))) {
          matched.push(pattern);
        }
      }
      if (matched.length === 0) {
        continue;
      }
      selected.push({
        skill,
        loadedBy: "tool_affinity",
        reason: `applies_to_tools matched ${matched.join(", ")}`,
      });
    }

    // `retrieval` and `explicit` strategies — Phase 6/7. Silently skip.
  }

  selected.sort((a, b) => a.skill.manifest.priority - b.skill.manifest.priority);
  return selected;
}

/**
 * Partition a conversation skill pool by ROLE — the single composition-routing
 * authority. A skill's `type` decides its channel, by construction:
 *
 *  - `context` → always-on identity/voice content. Goes to the context channel
 *    (Layer 0/1), rendered from every tier (core/builtin/org + workspace + user),
 *    sorted by priority. Disabled context skills are dropped here (the always-on
 *    channel has no per-turn status gate of its own).
 *  - everything else (`skill`) → capability content for the conditional channels:
 *    tool-affinity Layer 3 (`selectLayer3Skills`) and the keyword matcher.
 *
 * The two sets are DISJOINT by `type`, so a skill can never enter two channels —
 * there is no overlap to de-duplicate downstream. Role placement replaces the
 * old "context skills also default to `always` and get selected into Layer 3"
 * conflation that required after-the-fact filtering.
 */
export function partitionSkillsByRole(pool: Skill[]): { context: Skill[]; capability: Skill[] } {
  const context: Skill[] = [];
  const capability: Skill[] = [];
  for (const s of pool) {
    if (s.manifest.type === "context") {
      if (s.manifest.status === undefined || s.manifest.status === "active") context.push(s);
    } else {
      capability.push(s);
    }
  }
  context.sort((a, b) => a.manifest.priority - b.manifest.priority);
  return { context, capability };
}
