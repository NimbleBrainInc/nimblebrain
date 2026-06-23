/**
 * Shared predicate: "how would this skill load?"
 *
 * Single source of truth for the two callers that must agree on whether a
 * skill is reachable by any loader path:
 *
 *   - `createSkill` (tools/platform/skills.ts) derives `loading-strategy:
 *     always` for an otherwise-dead `type: skill` at create time.
 *   - `skills__list` reports a `loading` descriptor so a dead skill is
 *     visible instead of silently inert.
 *
 * The precedence below mirrors the real loader/selector/matcher behavior:
 *   - `loader.ts` resolves `loadingStrategy` (explicit → applies-to-tools).
 *     It no longer synthesizes `always` for `type: context` (PR-2c); those
 *     skills compose via the Layer 0/1 path (`activeContextSkills()`)
 *     regardless of strategy, so this predicate still reports `"always"` for
 *     them below — describing how they COMPOSE, decoupled from the loader's
 *     strategy field.
 *   - `select.ts` (Layer 3) loads `always` and `tool_affined`; it *silently
 *     skips* `retrieval` / `explicit` (Phase 6/7, not yet enforced) and any
 *     skill with no strategy.
 *   - `matcher.ts` loads `type: skill` skills by trigger/keyword.
 *
 * Pure — no I/O, no Runtime, no globals.
 */

import type { SkillManifest } from "./types.ts";

/**
 * The mechanism by which a skill would load *today*. `"none"` means no loader
 * path reaches it — the dead state issue #391 is about.
 *
 * Note the value names differ from `SkillLoadingStrategy` deliberately:
 * `"tool_affinity"` matches the `loadedBy` event vocabulary in `select.ts`
 * (the strategy is `tool_affined`; the load reason is `tool_affinity`), and
 * `"trigger"` is the matcher path which has no strategy enum at all.
 */
export type SkillLoadingMechanism = "always" | "tool_affinity" | "trigger" | "none";

/**
 * Resolve how `manifest` would load. Precedence is significant — an explicit
 * strategy wins over type/metadata inference, matching `loader.ts`.
 */
export function resolveLoadingMechanism(manifest: SkillManifest): SkillLoadingMechanism {
  // 1. Explicit Layer-3 strategies that actually load today.
  if (manifest.loadingStrategy === "always") return "always";
  if (manifest.loadingStrategy === "tool_affined") return "tool_affinity";

  // `retrieval` / `explicit` are accepted by the loader for forward-compat
  // but `select.ts` silently skips them — they do NOT load today, so they
  // fall through to the inference below (and typically resolve to "none").

  // 2. Tool-affinity by presence of patterns (loader infers `tool_affined`).
  if (manifest.appliesToTools && manifest.appliesToTools.length > 0) {
    return "tool_affinity";
  }

  // 3. Context skills always compose via the Layer 0/1 path
  //    (`activeContextSkills()`), regardless of `loadingStrategy` — so report
  //    `"always"` even though the loader no longer synthesizes it (PR-2c).
  if (manifest.type === "context") return "always";

  // 4. A `type: skill` with triggers/keywords rides the legacy matcher.
  const triggers = manifest.metadata?.triggers ?? [];
  const keywords = manifest.metadata?.keywords ?? [];
  if (triggers.length > 0 || keywords.length > 0) return "trigger";

  // 5. Nothing reaches it.
  return "none";
}

/** True when some loader path would reach `manifest`. */
export function wouldLoad(manifest: SkillManifest): boolean {
  return resolveLoadingMechanism(manifest) !== "none";
}
