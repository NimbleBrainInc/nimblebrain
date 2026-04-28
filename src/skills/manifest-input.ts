/**
 * Coerce agent-supplied skill input into a typed `SkillManifest`.
 *
 * Agents and UIs alike send loose JSON shaped by JSON Schema. The on-disk
 * format uses kebab-case keys (`loading-strategy`, `applies-to-tools`)
 * matching the existing `allowed-tools` ↔ `allowedTools` convention from
 * the loader/writer; some agent flows send snake_case. This module
 * accepts both (and camelCase) and emits the canonical camelCase
 * `SkillManifest` that the writer round-trips.
 *
 * This is the SINGLE input→manifest mapping for the platform. The
 * `nb__skills` mutation tools (create/update) call into the helpers
 * below; if any future caller adds a Phase 5+ field, it lands here once
 * and propagates to every entry point.
 */

import type { SkillManifest } from "./types.ts";

/**
 * Build a complete manifest for a freshly-created skill. Defaults match
 * what the loader would fill in on parse (`type=skill`, `priority=50`,
 * `version=1.0.0`). Unknown keys are silently ignored.
 */
export function coerceManifestInput(
  name: string,
  raw: Record<string, unknown> | undefined,
): SkillManifest {
  const r = raw ?? {};
  const get = <T>(...keys: string[]): T | undefined => {
    for (const k of keys) {
      if (r[k] !== undefined) return r[k] as T;
    }
    return undefined;
  };

  const type = (get<string>("type") ?? "skill") as SkillManifest["type"];
  const priority = typeof get("priority") === "number" ? (get<number>("priority") as number) : 50;
  const allowedTools = get<string[]>("allowedTools", "allowed-tools", "allowed_tools");
  const requiresBundles = get<string[]>("requiresBundles", "requires-bundles", "requires_bundles");
  const scope = get<SkillManifest["scope"]>("scope");
  const loadingStrategy = get<SkillManifest["loadingStrategy"]>(
    "loadingStrategy",
    "loading-strategy",
    "loading_strategy",
  );
  const appliesToTools = get<string[]>("appliesToTools", "applies-to-tools", "applies_to_tools");
  const status = get<SkillManifest["status"]>("status");
  const overrides = get<SkillManifest["overrides"]>("overrides");
  const derivedFrom = get<string>("derivedFrom", "derived-from", "derived_from");
  const description = (get<string>("description") ?? "") as string;
  const version = (get<string>("version") ?? "1.0.0") as string;

  // Build a metadata block from loose input (`triggers`, `keywords`,
  // `category`, `tags`) for parity with the legacy mapping. Any
  // already-shaped `metadata` object on the input wins.
  let metadata: SkillManifest["metadata"];
  const explicitMeta = get<SkillManifest["metadata"]>("metadata");
  if (explicitMeta) {
    metadata = explicitMeta;
  } else {
    const triggers = get<string[]>("triggers");
    const keywords = get<string[]>("keywords");
    const category = get<string>("category");
    const tags = get<string[]>("tags");
    if (
      Array.isArray(triggers) ||
      Array.isArray(keywords) ||
      typeof category === "string" ||
      Array.isArray(tags)
    ) {
      metadata = {
        keywords: keywords ?? [],
        triggers: triggers ?? [],
        ...(category ? { category } : {}),
        ...(tags ? { tags } : {}),
      };
    }
  }

  return {
    name,
    description,
    version,
    type,
    priority,
    ...(allowedTools ? { allowedTools } : {}),
    ...(requiresBundles ? { requiresBundles } : {}),
    ...(metadata ? { metadata } : {}),
    ...(scope ? { scope } : {}),
    ...(loadingStrategy ? { loadingStrategy } : {}),
    ...(appliesToTools ? { appliesToTools } : {}),
    ...(status ? { status } : {}),
    ...(overrides ? { overrides } : {}),
    ...(derivedFrom ? { derivedFrom } : {}),
  };
}

/**
 * Coerce a partial manifest patch for use with `writer.updateSkill`.
 * Only fields actually present on the input are emitted, so the writer's
 * merge logic can distinguish "user didn't say" from "user set to undefined".
 */
export function coerceManifestPatch(raw: Record<string, unknown>): Partial<SkillManifest> {
  const patch: Partial<SkillManifest> = {};
  if (typeof raw.description === "string") patch.description = raw.description;
  if (typeof raw.type === "string") patch.type = raw.type as SkillManifest["type"];
  if (typeof raw.priority === "number") patch.priority = raw.priority;

  const allowed = raw.allowedTools ?? raw["allowed-tools"] ?? raw.allowed_tools;
  if (Array.isArray(allowed)) patch.allowedTools = allowed as string[];

  const requires = raw.requiresBundles ?? raw["requires-bundles"] ?? raw.requires_bundles;
  if (Array.isArray(requires)) patch.requiresBundles = requires as string[];

  if (typeof raw.scope === "string") patch.scope = raw.scope as SkillManifest["scope"];

  const ls = raw.loadingStrategy ?? raw["loading-strategy"] ?? raw.loading_strategy;
  if (typeof ls === "string") patch.loadingStrategy = ls as SkillManifest["loadingStrategy"];

  const att = raw.appliesToTools ?? raw["applies-to-tools"] ?? raw.applies_to_tools;
  if (Array.isArray(att)) patch.appliesToTools = att as string[];

  if (typeof raw.status === "string") patch.status = raw.status as SkillManifest["status"];

  if (Array.isArray(raw.overrides)) patch.overrides = raw.overrides as SkillManifest["overrides"];

  const derived = raw.derivedFrom ?? raw["derived-from"] ?? raw.derived_from;
  if (typeof derived === "string") patch.derivedFrom = derived;

  if (raw.metadata !== undefined) {
    patch.metadata = raw.metadata as SkillManifest["metadata"];
  }

  return patch;
}
