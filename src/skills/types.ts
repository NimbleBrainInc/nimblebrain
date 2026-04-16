export type SkillType = "context" | "skill";

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  type: SkillType;
  priority: number;
  allowedTools?: string[];
  requiresBundles?: string[];
  metadata?: SkillMetadata;
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
