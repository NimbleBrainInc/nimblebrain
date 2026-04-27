export type SkillType = "context" | "skill";

/**
 * Phase 2 — Layer 3 visibility additions.
 *
 * `scope` is stamped at load time by `loadScopedSkills` based on the source
 * directory. `loadingStrategy` and `appliesToTools` drive the Phase 2 Layer 3
 * selection (`always` + `tool_affined`); `retrieval` and `explicit` are
 * accepted for forward-compatibility and parsed without enforcement.
 *
 * `overrides` and `derivedFrom` are designed-but-not-enforced: future phases
 * (3 for overrides, 4 for derived-from / authoring) interpret them. Today the
 * loader parses them so a manifest authored against the full schema round-
 * trips cleanly when those features land.
 */
export type SkillScope = "platform" | "workspace" | "user" | "bundle";
export type SkillLoadingStrategy = "always" | "tool_affined" | "retrieval" | "explicit";
export type SkillStatus = "active" | "draft" | "disabled" | "archived";

export interface SkillOverride {
  bundle?: string;
  skill?: string;
  reason: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  type: SkillType;
  priority: number;
  allowedTools?: string[];
  requiresBundles?: string[];
  metadata?: SkillMetadata;
  // ---- Phase 2 additions (all optional) -----------------------------------
  scope?: SkillScope;
  loadingStrategy?: SkillLoadingStrategy;
  appliesToTools?: string[];
  status?: SkillStatus;
  overrides?: SkillOverride[];
  derivedFrom?: string;
}

export interface SkillMetadata {
  keywords: string[];
  triggers: string[];
  category?: string;
  tags?: string[];
  author?: string;
  created_at?: string;
  source?: string;
}

export interface Skill {
  manifest: SkillManifest;
  body: string;
  sourcePath: string;
}
