import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type {
  Skill,
  SkillLoadingStrategy,
  SkillManifest,
  SkillMetadata,
  SkillOverride,
  SkillScope,
  SkillStatus,
  SkillType,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "builtin");
const CORE_DIR = join(__dirname, "core");

const VALID_TYPES = new Set(["context", "skill"]);
const VALID_LOADING_STRATEGIES = new Set<SkillLoadingStrategy>([
  "always",
  "tool_affined",
  "retrieval",
  "explicit",
]);
const VALID_STATUSES = new Set<SkillStatus>(["active", "draft", "disabled", "archived"]);
const VALID_SCOPES = new Set<SkillScope>(["org", "workspace", "user", "bundle"]);
/**
 * Scope rename — `platform` was the original Phase-2 label for the
 * org-wide tier. We accept it as a back-compat alias on read so any
 * skill file still on disk with `scope: platform` keeps loading; the
 * value is normalised to `org` in the manifest, and the writer always
 * emits the new label.
 */
const SCOPE_ALIASES: Record<string, SkillScope> = { platform: "org" };

/** Subdirectories that the multi-scope loader must skip. */
const RESERVED_SUBDIR_PREFIX = "_";

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

/**
 * Load skills from a directory and stamp `manifest.scope` on each result.
 *
 * Behavior:
 *   - Skips reserved subdirectories whose name begins with `_` (e.g.
 *     `_versions/`, `_archived/`) — these are reserved by Phase 3 for
 *     versioning and archived storage.
 *   - Recurses up to `MAX_SUBDIR_DEPTH` (currently 2) levels deep so
 *     `bundles/<bundle>/<skill>.md` under a workspace skill dir is
 *     discovered. The path is convention only; the loader stamps the
 *     scope passed in regardless of nesting depth.
 *   - Returns `[]` if the directory does not exist (caller-friendly —
 *     missing user/workspace dirs are not an error).
 *
 * Phase 2: callers stamp the scope based on which dir they're loading.
 * No frontmatter override — if the user puts `scope: bundle` in a file
 * that lives under `workspaces/.../skills/`, the loader still stamps
 * `workspace`. Scope follows the filesystem.
 */
export function loadScopedSkills(dir: string, scope: SkillScope): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  collectScopedSkills(dir, scope, skills, 0);
  return skills;
}

/**
 * Maximum subdirectory depth the multi-scope loader will recurse to find
 * `*.md` skill files. Depth 0 = the dir passed to `loadScopedSkills`.
 * Depth 2 lets us discover `bundles/<bundle>/<skill>.md` (the workspace
 * convention for bundle-scoped skills) without opening up unbounded
 * recursion.
 */
const MAX_SUBDIR_DEPTH = 2;

/**
 * Merge platform / workspace / user skill pools by `manifest.name` with
 * later layers overriding earlier ones (user > workspace > platform).
 *
 * Used by the runtime's per-conversation overlay: the platform pool comes
 * from the boot-time set built by `buildSkills`, while workspace and user
 * pools are read live for each conversation. Returned in insertion order
 * (platform-only first, then workspace-only, then user-only / overrides).
 *
 * Pure function — no I/O — so it can be unit-tested without a Runtime.
 */
export function mergeScopedSkills(platform: Skill[], workspace: Skill[], user: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of platform) byName.set(s.manifest.name, s);
  for (const s of workspace) byName.set(s.manifest.name, s);
  for (const s of user) byName.set(s.manifest.name, s);
  return Array.from(byName.values());
}

function collectScopedSkills(dir: string, scope: SkillScope, out: Skill[], depth: number): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const path = join(dir, entry.name);
      const skill = parseSkillFile(path);
      if (skill) {
        skill.manifest.scope = scope;
        out.push(skill);
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name.startsWith(RESERVED_SUBDIR_PREFIX)) continue;
      if (depth >= MAX_SUBDIR_DEPTH) continue;
      collectScopedSkills(join(dir, entry.name), scope, out, depth + 1);
    }
  }
}

/** Parse a single SKILL.md file into a Skill object. Returns null if invalid. */
export function parseSkillFile(path: string): Skill | null {
  const raw = readFileSync(path, "utf-8");
  return parseSkillContent(raw, path);
}

/**
 * Read the file's mtime as ISO 8601. Returns the empty string if the file
 * cannot be statted (in-memory or non-existent paths). Used by Phase 2
 * `skills.loaded` events as a cheap version stamp.
 */
export function readSkillMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return "";
  }
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

  // ---- Phase 2 fields -----------------------------------------------------

  // `applies-to-tools` accepts both kebab and snake case; only emit when
  // we actually got a non-empty array.
  const appliesToTools = toOptionalStringArray(
    data["applies-to-tools"] ?? data.applies_to_tools ?? data.appliesToTools,
  );

  // `loading-strategy` resolution:
  //   1. Use the value if it's a recognized strategy.
  //   2. Else if applies-to-tools is set → tool_affined.
  //   3. Else if type === "context" → always.
  //   4. Else undefined (legacy `type: skill` keeps using SkillMatcher).
  const rawLoadingStrategy =
    data["loading-strategy"] ?? data.loading_strategy ?? data.loadingStrategy;
  let loadingStrategy: SkillLoadingStrategy | undefined;
  if (typeof rawLoadingStrategy === "string") {
    if (VALID_LOADING_STRATEGIES.has(rawLoadingStrategy as SkillLoadingStrategy)) {
      loadingStrategy = rawLoadingStrategy as SkillLoadingStrategy;
    } else {
      console.error(
        `[skill] Warning: invalid loading-strategy "${rawLoadingStrategy}" in ${sourcePath}, falling back to default`,
      );
    }
  }
  if (!loadingStrategy) {
    if (appliesToTools && appliesToTools.length > 0) {
      loadingStrategy = "tool_affined";
    } else if (type === "context") {
      loadingStrategy = "always";
    }
  }

  // `status` defaults to "active" when missing or invalid.
  let status: SkillStatus = "active";
  if (typeof data.status === "string") {
    if (VALID_STATUSES.has(data.status as SkillStatus)) {
      status = data.status as SkillStatus;
    } else {
      console.error(
        `[skill] Warning: invalid status "${data.status}" in ${sourcePath}, defaulting to "active"`,
      );
    }
  }

  // `scope` from frontmatter is honored only if it's a known value. The
  // multi-scope loader (`loadScopedSkills`) overwrites this based on the
  // source dir; parsing it here lets standalone authoring tools round-trip
  // the field without losing it.
  let scope: SkillScope | undefined;
  if (typeof data.scope === "string") {
    const aliased = SCOPE_ALIASES[data.scope];
    if (aliased) {
      scope = aliased;
    } else if (VALID_SCOPES.has(data.scope as SkillScope)) {
      scope = data.scope as SkillScope;
    } else {
      console.error(`[skill] Warning: invalid scope "${data.scope}" in ${sourcePath}, ignoring`);
    }
  }

  const overrides = parseOverrides(data.overrides);
  const derivedFromRaw = data["derived-from"] ?? data.derived_from ?? data.derivedFrom;
  const derivedFrom = typeof derivedFromRaw === "string" ? derivedFromRaw : undefined;

  const manifest: SkillManifest = {
    name,
    description: (data.description as string) ?? "",
    version: (data.version as string) ?? "0.0.0",
    type,
    priority,
    allowedTools: toStringArray(data["allowed-tools"]),
    requiresBundles: toOptionalStringArray(data["requires-bundles"]),
    metadata,
    ...(scope ? { scope } : {}),
    ...(loadingStrategy ? { loadingStrategy } : {}),
    ...(appliesToTools && appliesToTools.length > 0 ? { appliesToTools } : {}),
    status,
    ...(overrides && overrides.length > 0 ? { overrides } : {}),
    ...(derivedFrom ? { derivedFrom } : {}),
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

function parseOverrides(value: unknown): SkillOverride[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const overrides: SkillOverride[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const reason = typeof e.reason === "string" ? e.reason : "";
    const override: SkillOverride = { reason };
    if (typeof e.bundle === "string") override.bundle = e.bundle;
    if (typeof e.skill === "string") override.skill = e.skill;
    overrides.push(override);
  }
  return overrides.length > 0 ? overrides : undefined;
}
