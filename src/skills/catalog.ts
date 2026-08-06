/**
 * Skill catalog — the model-facing index of on-demand skills.
 *
 * Pure functions over the pools the request path already computes: the
 * conversation tiers' `dynamic` (capability) skills, the focused workspace's
 * `dynamic` bundle skills, and the curated connector-overlay candidates. The
 * catalog lists what CAN be activated; it never encodes what IS loaded —
 * entries are name + description only, sorted and deduplicated, so the
 * rendered section is byte-stable between install/authoring events and safe
 * for the cached stable prompt segment.
 *
 * No filesystem access, no event emission, no global state.
 */

import type { ConnectorSkillCandidate } from "../engine/types.ts";
import type { Skill } from "./types.ts";

/**
 * One activatable skill, with the body the activation tool delivers. The
 * catalog renders only `name` + `description` (see {@link toCatalogEntries});
 * the full shape backs `skills__use`'s name validation and body lookup.
 */
export interface ActivatableSkill {
  name: string;
  description?: string;
  body: string;
  /** Provenance label for the activation block (`org` / `workspace` / `user` / `bundle` / `connector`). */
  scope: string;
}

/** One catalog line: what the stable-segment section renders per skill. */
export interface SkillCatalogEntry {
  name: string;
  description?: string;
}

/**
 * Merge the three activatable pools into one deterministic list.
 *
 * - `fsCapability` / `bundleCapability` are `dynamic` skills (the capability
 *   half of `partitionSkillsByRole`); disabled ones are dropped here — the
 *   catalog must not offer a skill an operator muted.
 * - `connectorCandidates` are the curated overlays (always active by
 *   materialization).
 *
 * Deduplicated by name — first pool wins (filesystem > bundle > connector,
 * matching the tier-override direction of `mergeScopedSkills`) — then sorted
 * by name via codepoint comparison (never locale-sensitive collation), so the
 * output is byte-stable for identical inputs.
 */
export function collectActivatableSkills(pools: {
  fsCapability: Skill[];
  bundleCapability: Skill[];
  connectorCandidates: ConnectorSkillCandidate[];
}): ActivatableSkill[] {
  const byName = new Map<string, ActivatableSkill>();
  const addSkill = (s: Skill) => {
    if (s.manifest.status !== "active") return;
    if (byName.has(s.manifest.name)) return;
    byName.set(s.manifest.name, {
      name: s.manifest.name,
      ...(s.manifest.description ? { description: s.manifest.description } : {}),
      body: s.body,
      scope: s.manifest.scope ?? "org",
    });
  };
  for (const s of pools.fsCapability) addSkill(s);
  for (const s of pools.bundleCapability) addSkill(s);
  for (const c of pools.connectorCandidates) {
    if (byName.has(c.name)) continue;
    byName.set(c.name, {
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      body: c.body,
      scope: c.scope,
    });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Project activatable skills to the name+description lines the catalog section renders. */
export function toCatalogEntries(skills: ActivatableSkill[]): SkillCatalogEntry[] {
  return skills.map((s) => ({
    name: s.name,
    ...(s.description ? { description: s.description } : {}),
  }));
}
