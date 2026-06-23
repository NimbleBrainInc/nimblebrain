/**
 * Shared predicate: "how would this skill load?"
 *
 * Single source of truth for the callers that must agree on whether a skill is
 * reachable by any loader path:
 *
 *   - `skills__list` reports a `loading` descriptor, and `skills__read` shows a
 *     `loads:` header, so a dead (catalog-only) skill is visible instead of
 *     silently inert.
 *   - `createSkill` surfaces the resolved mechanism in its confirmation note.
 *
 * The precedence below mirrors the real loader/selector/matcher behavior:
 *   - `loading-strategy: always` → the always-on context channel
 *     (`select.ts` `partitionSkillsByRole`).
 *   - `dynamic` + tool-affinity → Layer 3 (`select.ts` `selectLayer3Skills`).
 *   - `dynamic` + triggers → the per-request matcher (`matcher.ts`).
 *   - otherwise catalog-only — no active loader path until the catalog ships.
 *
 * Pure — no I/O, no Runtime, no globals.
 */

import type { SkillManifest } from "./types.ts";

/**
 * The subset of manifest fields that determine the loading mechanism. Both the
 * canonical `SkillManifest` and the narrower `skills__read` detail metadata
 * (whose `loadingStrategy` is a plain string) satisfy this shape.
 */
export type LoadingSignals = {
  loadingStrategy?: string;
  toolAffinity?: string[];
  triggers?: string[];
};

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
 * Resolve how `manifest` would load. Precedence is significant: `always` wins
 * over tool-affinity, which wins over triggers.
 */
export function resolveLoadingMechanism(manifest: LoadingSignals): SkillLoadingMechanism {
  // 1. `always` → the always-on context channel.
  if (manifest.loadingStrategy === "always") return "always";

  // `dynamic` skills reach the prompt via one of two signals today:
  // 2. Tool-affinity (Layer 3, `selectLayer3Skills`).
  if (manifest.toolAffinity && manifest.toolAffinity.length > 0) return "tool_affinity";

  // 3. Trigger phrases (the matcher, Layer 4).
  if (manifest.triggers && manifest.triggers.length > 0) return "trigger";

  // 4. Otherwise catalog-only (model-activated) — no active loader path until
  //    the catalog ships, so nothing reaches it yet.
  return "none";
}

/** True when some loader path would reach `manifest`. */
export function wouldLoad(manifest: SkillManifest): boolean {
  return resolveLoadingMechanism(manifest) !== "none";
}
