/**
 * Bundle-skill adapter.
 *
 * Synthesizes Layer 3 `Skill` objects from `skill://<serverName>/usage`
 * resources exposed by MCP bundles. This makes a bundle-side workflow guide
 * discoverable through the same tool-affined loading machinery that picks up
 * filesystem skills — no need for the chat to be scoped to a specific app
 * via `appContext`.
 *
 * Why this exists:
 *
 *   Bundles can publish a `skill://<name>/usage` resource — a markdown
 *   playbook teaching the agent how to chain tools, recover from errors,
 *   etc. (Reference: `synapse-collateral`'s SKILL.md.) The existing
 *   `getAppSkillResource` path only fired when the request had `appContext`
 *   pinning the conversation to that bundle. In a workspace-level chat where
 *   the bundle's tools are visible but no app is "entered," the skill went
 *   unread — including the directive that tells the model which tool to use.
 *   Production case: a cobranding turn looped on `list_documents` until the
 *   supervisor halted because the model never read the rules.
 *
 *   This adapter closes the gap. At chat-build time, for each MCP source in
 *   the active workspace registry, we probe for `skill://<name>/usage` and
 *   wrap any returned body in a synthetic `Skill` with
 *   `loadingStrategy: "dynamic"` and `toolAffinity: ["<name>__*"]`.
 *   The skill then flows through the standard `selectLayer3Skills` path: if
 *   any `<name>__*` tool is in the active toolset, the skill loads.
 *
 *   This is strictly additive. The `appContext`-driven `<app-guide>` injection
 *   remains untouched — it has different semantics (per-app focus, trust-score
 *   gating, reference-resource hint) than Layer 3 selection.
 */

import type { Skill, SkillScope } from "./types.ts";

/** Scope tag used on synthesized bundle skills. */
export const BUNDLE_SKILL_SCOPE: SkillScope = "bundle";

/** Priority for synthesized bundle skills. Mid-range — below `always` skills
 * that workspace authors set explicitly, above default catch-alls. */
const BUNDLE_SKILL_PRIORITY = 60;

export interface BundleSkillInput {
  /** MCP server name (matches the prefix used in surfaced tool names). */
  serverName: string;
  /** Body of the `skill://<name>/usage` resource. Already truncated to budget. */
  body: string;
}

/**
 * Synthesize a Layer 3 `Skill` from a bundle-exposed `skill://<name>/usage`
 * resource. The skill is `tool_affined` to `<serverName>__*`, so it loads
 * whenever the bundle's tools are in the active toolset.
 *
 * Pure function — no I/O, no caching. The caller (runtime) handles fetch +
 * cache via `getAppSkillResource`. Keeping the synthesis pure means it's
 * trivial to unit-test the manifest shape without spinning up a registry.
 *
 * Observability contract: when this skill is selected by
 * `selectLayer3Skills`, `buildSkillsLoadedPayload` will emit it on the
 * `skills.loaded` event with `id = skill://<name>/usage`, `scope = "bundle"`,
 * `loadedBy = "tool_affinity"`. Downstream consumers (SkillsPopover,
 * `skills__active_for`, `skills__loading_log`) already handle that shape —
 * the synthesized skill is byte-identical in payload structure to any
 * filesystem-sourced Layer 3 skill with the same scope / strategy.
 */
export function synthesizeBundleSkill(input: BundleSkillInput): Skill {
  const { serverName, body } = input;
  return {
    manifest: {
      name: `bundle:${serverName}`,
      description: `Workflow guidance from the ${serverName} bundle`,
      priority: BUNDLE_SKILL_PRIORITY,
      scope: BUNDLE_SKILL_SCOPE,
      loadingStrategy: "dynamic",
      toolAffinity: [`${serverName}__*`],
      status: "active",
    },
    body,
    sourcePath: `skill://${serverName}/usage`,
  };
}
