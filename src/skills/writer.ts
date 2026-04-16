import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { parseSkillContent } from "./loader.ts";
import type { Skill, SkillManifest } from "./types.ts";

// ---------------------------------------------------------------------------
// Skill file CRUD — atomic persistence for skill markdown files.
//
// Uses the write-temp-then-rename pattern from BundleLifecycleManager to
// prevent partial writes from corrupting existing files.
// ---------------------------------------------------------------------------

/**
 * Convert a SkillManifest into a kebab-case YAML-friendly plain object
 * that round-trips through gray-matter / parseSkillContent.
 */
function manifestToFrontmatter(manifest: SkillManifest): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    type: manifest.type,
    priority: manifest.priority,
  };

  // Only emit arrays when they have entries (matches loader: empty → [])
  if (manifest.allowedTools && manifest.allowedTools.length > 0) {
    fm["allowed-tools"] = manifest.allowedTools;
  }
  if (manifest.requiresBundles && manifest.requiresBundles.length > 0) {
    fm["requires-bundles"] = manifest.requiresBundles;
  }

  if (manifest.metadata) {
    const meta: Record<string, unknown> = {};
    if (manifest.metadata.keywords.length > 0) meta.keywords = manifest.metadata.keywords;
    if (manifest.metadata.triggers.length > 0) meta.triggers = manifest.metadata.triggers;
    if (manifest.metadata.category) meta.category = manifest.metadata.category;
    if (manifest.metadata.tags && manifest.metadata.tags.length > 0)
      meta.tags = manifest.metadata.tags;
    if (manifest.metadata.author) meta.author = manifest.metadata.author;
    if (manifest.metadata.created_at) meta.created_at = manifest.metadata.created_at;
    if (manifest.metadata.source) meta.source = manifest.metadata.source;
    if (Object.keys(meta).length > 0) {
      fm.metadata = meta;
    }
  }

  return fm;
}

/**
 * Atomically write a file: write to a `.tmp` sibling, then rename over
 * the target. If the rename fails the original file is untouched.
 */
function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Serialize a manifest + body into a complete skill markdown string
 * (YAML frontmatter + body).
 */
function serializeSkill(manifest: SkillManifest, body: string): string {
  const fm = manifestToFrontmatter(manifest);
  return matter.stringify(`\n${body}\n`, fm);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a new skill file at `{dir}/{name}.md` with YAML frontmatter.
 * Creates the directory if it doesn't exist. Uses atomic write.
 */
export function writeSkill(dir: string, name: string, manifest: SkillManifest, body: string): void {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.md`);
  const content = serializeSkill(manifest, body);
  atomicWriteFile(filePath, content);
}

/**
 * Read and parse a skill file by name. Returns null if the file doesn't
 * exist or fails to parse.
 */
export function readSkill(dir: string, name: string): Skill | null {
  const filePath = join(dir, `${name}.md`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseSkillContent(raw, filePath);
  } catch {
    return null;
  }
}

/**
 * Update an existing skill file. Reads the current file, merges any
 * provided partial manifest fields, optionally replaces the body, and
 * writes back atomically. Throws if the file doesn't exist.
 */
export function updateSkill(
  dir: string,
  name: string,
  partialManifest?: Partial<SkillManifest>,
  newBody?: string,
): void {
  const existing = readSkill(dir, name);
  if (!existing) {
    throw new Error(`Skill "${name}" not found in ${dir}`);
  }

  const merged: SkillManifest = { ...existing.manifest };

  if (partialManifest) {
    if (partialManifest.name !== undefined) merged.name = partialManifest.name;
    if (partialManifest.description !== undefined) merged.description = partialManifest.description;
    if (partialManifest.version !== undefined) merged.version = partialManifest.version;
    if (partialManifest.type !== undefined) merged.type = partialManifest.type;
    if (partialManifest.priority !== undefined) merged.priority = partialManifest.priority;
    if (partialManifest.allowedTools !== undefined)
      merged.allowedTools = partialManifest.allowedTools;
    if (partialManifest.requiresBundles !== undefined)
      merged.requiresBundles = partialManifest.requiresBundles;
    if (partialManifest.metadata !== undefined) merged.metadata = partialManifest.metadata;
  }

  const body = newBody !== undefined ? newBody : existing.body;
  writeSkill(dir, name, merged, body);
}

/**
 * Delete a skill file. No-op if the file doesn't exist.
 */
export function deleteSkill(dir: string, name: string): void {
  const filePath = join(dir, `${name}.md`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/**
 * List and parse all skill `.md` files in a directory.
 * Returns an empty array if the directory doesn't exist.
 */
export function listSkills(dir: string): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const filePath = join(dir, entry.name);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const skill = parseSkillContent(raw, filePath);
        if (skill) skills.push(skill);
      } catch {
        // Skip unparseable files
      }
    }
  }
  return skills;
}
