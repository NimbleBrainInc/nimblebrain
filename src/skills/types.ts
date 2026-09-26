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
  /** The body, or `""` while {@link Skill.loadBody} has not been resolved. */
  body: string;
  sourcePath: string;
  /**
   * Present on a skill whose body is fetched only when needed (a
   * server-published skill, per the MCP Skills Extension). Resolve it with
   * `hydrateSkill` where the body reaches the model; everything else reads the
   * manifest alone.
   */
  loadBody?: () => Promise<string | null>;
}
