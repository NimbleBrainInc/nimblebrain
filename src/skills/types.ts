/**
 * Skill runtime types. The manifest shape is the canonical one defined in
 * `schemas/skill-manifest.ts` (the single source of truth, validated on load);
 * this module re-exports it and adds the `Skill` wrapper (manifest + body +
 * sourcePath) the loader and consumers use.
 */

export type {
  SkillLoadingStrategy,
  SkillManifest,
  SkillProvenance,
  SkillScope,
  SkillStatus,
} from "./schemas/skill-manifest.ts";

import type { SkillManifest } from "./schemas/skill-manifest.ts";

export interface Skill {
  manifest: SkillManifest;
  body: string;
  sourcePath: string;
}
