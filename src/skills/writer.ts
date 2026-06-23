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
 * Convert a SkillManifest into the canonical on-disk frontmatter shape:
 * standard fields top-level (`name`, `description`, `license`, `compatibility`,
 * `allowed-tools` as a space-separated string, `metadata.{author,version}`),
 * with NimbleBrain runtime config nested under `metadata.nimblebrain.*` (kebab).
 * `scope` is NOT written — it's stamped at load from the directory tier.
 * Round-trips through gray-matter / `parseSkillContent`.
 */
function manifestToFrontmatter(manifest: SkillManifest): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    name: manifest.name,
    description: manifest.description,
  };
  if (manifest.license) fm.license = manifest.license;
  if (manifest.compatibility) fm.compatibility = manifest.compatibility;
  // Standard `allowed-tools` is a space-separated string.
  if (manifest.allowedTools && manifest.allowedTools.length > 0) {
    fm["allowed-tools"] = manifest.allowedTools.join(" ");
  }

  const nb: Record<string, unknown> = {
    "loading-strategy": manifest.loadingStrategy,
    priority: manifest.priority,
    status: manifest.status,
  };
  if (manifest.toolAffinity && manifest.toolAffinity.length > 0) {
    nb["tool-affinity"] = manifest.toolAffinity;
  }
  if (manifest.triggers && manifest.triggers.length > 0) {
    nb.triggers = manifest.triggers;
  }
  if (manifest.provenance) {
    const p = manifest.provenance;
    const prov: Record<string, unknown> = { origin: p.origin };
    if (p.conversationId) prov["conversation-id"] = p.conversationId;
    if (p.createdBy) prov["created-by"] = p.createdBy;
    if (p.createdAt) prov["created-at"] = p.createdAt;
    if (p.updatedAt) prov["updated-at"] = p.updatedAt;
    nb.provenance = prov;
  }

  const metadata: Record<string, unknown> = { nimblebrain: nb };
  if (manifest.author) metadata.author = manifest.author;
  if (manifest.version) metadata.version = manifest.version;
  fm.metadata = metadata;

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
 * (YAML frontmatter + body). Exported so the one-time frontmatter migration
 * (`scripts/migrate-skill-frontmatter.ts`) emits byte-identical canonical
 * output to a freshly-written skill — no second serializer to drift.
 */
export function serializeSkill(manifest: SkillManifest, body: string): string {
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
    // Authoring round-trip: read the FULL stored body (no prompt cap) so an
    // edit never persists a truncated copy.
    return parseSkillContent(raw, filePath, { cap: false });
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

  // Merge provided keys over the existing manifest (Partial → absent keys keep
  // their existing value). `name` rename is handled by the caller (file move).
  const merged: SkillManifest = { ...existing.manifest, ...partialManifest };

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
        const skill = parseSkillContent(raw, filePath, { cap: false });
        if (skill) skills.push(skill);
      } catch {
        // Skip unparseable files
      }
    }
  }
  return skills;
}
