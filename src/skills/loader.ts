import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type { Skill, SkillManifest, SkillMetadata, SkillType } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "builtin");
const CORE_DIR = join(__dirname, "core");

const VALID_TYPES = new Set(["context", "skill"]);

/** Load built-in skills shipped with the package. */
export function loadBuiltinSkills(): Skill[] {
  return loadSkillDir(BUILTIN_DIR);
}

/** Load core skills that are always injected into the system prompt. */
export function loadCoreSkills(): Skill[] {
  return loadSkillDir(CORE_DIR);
}

/** Load all SKILL.md files from a directory. Non-recursive. */
export function loadSkillDir(dir: string): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const path = join(dir, entry.name);
      const skill = parseSkillFile(path);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

/** Parse a single SKILL.md file into a Skill object. Returns null if invalid. */
export function parseSkillFile(path: string): Skill | null {
  const raw = readFileSync(path, "utf-8");
  return parseSkillContent(raw, path);
}

/** Parse SKILL.md content string. Exported for testing. */
export function parseSkillContent(raw: string, sourcePath: string): Skill | null {
  const { data, content } = matter(raw);

  const name = data.name;
  if (typeof name !== "string" || !name) return null;

  // Parse type with default + warning
  let type: SkillType = "skill";
  if (data.type && VALID_TYPES.has(data.type)) {
    type = data.type as SkillType;
  } else if (data.type) {
    console.error(
      `[skill] Warning: invalid type "${data.type}" in ${sourcePath}, defaulting to "skill"`,
    );
  } else {
    console.error(`[skill] Warning: missing type in ${sourcePath}, defaulting to "skill"`);
  }

  // Parse priority with default + warning
  let priority = 50;
  if (typeof data.priority === "number") {
    priority = data.priority;
  } else if (data.priority !== undefined) {
    console.error(`[skill] Warning: invalid priority in ${sourcePath}, defaulting to 50`);
  } else {
    console.error(`[skill] Warning: missing priority in ${sourcePath}, defaulting to 50`);
  }

  const rawMeta = data.metadata;
  const metadata: SkillMetadata | undefined = rawMeta
    ? {
        keywords: toStringArray(rawMeta.keywords),
        triggers: toStringArray(rawMeta.triggers),
        category: rawMeta.category as string | undefined,
        tags: toStringArray(rawMeta.tags),
        author: rawMeta.author as string | undefined,
        created_at: rawMeta.created_at as string | undefined,
        source: rawMeta.source as string | undefined,
      }
    : undefined;

  const manifest: SkillManifest = {
    name,
    description: (data.description as string) ?? "",
    version: (data.version as string) ?? "0.0.0",
    type,
    priority,
    allowedTools: toStringArray(data["allowed-tools"]),
    requiresBundles: toOptionalStringArray(data["requires-bundles"]),
    metadata,
  };

  return { manifest, body: content.trim(), sourcePath };
}

/** Partition skills into context (sorted by priority) and matchable skills. */
export function partitionSkills(skills: Skill[]): { context: Skill[]; skills: Skill[] } {
  const context = skills
    .filter((s) => s.manifest.type === "context")
    .sort((a, b) => a.manifest.priority - b.manifest.priority);
  const matchable = skills.filter((s) => s.manifest.type === "skill");
  return { context, skills: matchable };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function toOptionalStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return undefined;
}
