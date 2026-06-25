import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { log } from "../observability/log.ts";
import { mapFrontmatterToManifest, validateFrontmatter } from "./schemas/skill-manifest.ts";
import { MAX_SKILL_BODY_CHARS, truncateMarkdownToBudget } from "./truncate.ts";
import type { Skill, SkillScope } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "builtin");
const CORE_DIR = join(__dirname, "core");

/** Subdirectories that the multi-scope loader must skip. */
const RESERVED_SUBDIR_PREFIX = "_";

/** Load built-in skills shipped with the package. */
export function loadBuiltinSkills(): Skill[] {
  return loadSkillDir(BUILTIN_DIR, "builtin");
}

/** Load core skills that are always injected into the system prompt. */
export function loadCoreSkills(): Skill[] {
  return loadSkillDir(CORE_DIR, "core");
}

/**
 * Read a skill directory's entries, logging (not throwing, not silently
 * swallowing) if the listing fails. A read error here means the dir existed
 * (`existsSync` passed) but couldn't be listed — permissions, I/O, or a TOCTOU
 * race where it was removed/rewritten under us. The old bare `return` dropped
 * the whole pool with zero signal; `[]` + a log keeps the failure visible. The
 * `label` and `depth` only shape the message.
 */
function readSkillDirEntries(dir: string, label: string, depth: number): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    log.error(
      `[skill] Could not read ${label} skills dir "${dir}" (${code})` +
        (depth === 0
          ? " — it contributes no skills this load"
          : ` at depth ${depth} — this subtree is skipped`),
      { dir, label, depth, code },
    );
    return [];
  }
}

/**
 * Parse one skill file, isolating a read/parse failure to THAT file. A single
 * unreadable or half-written file (e.g. mid-rewrite by a concurrent
 * `skills__update`, or malformed frontmatter that throws inside gray-matter)
 * is logged and dropped — it must never throw out of a directory loop and lose
 * every other skill in the pool (or crash `buildSkills` at boot).
 */
function parseSkillFileGuarded(path: string): Skill | null {
  try {
    // Prompt-load path: the SOLE place the per-skill body cap is applied.
    // Read/inspect callers (skills__read, writer, debug audit) get the full
    // body by default, so no read door can silently truncate stored content.
    return parseSkillFile(path, { cap: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    log.error(`[skill] Skipping unreadable skill file "${path}" (${code})`, { path, code });
    return null;
  }
}

/**
 * Load all SKILL.md files from a directory. Non-recursive. Used for the
 * vendored builtin/core dirs and the user-writable global/config skill dirs
 * (`runtime.ts` boot path, CLI). Both the directory read and each file parse
 * are guarded so one bad dir or one bad file degrades to a logged skip instead
 * of crashing the load — see `readSkillDirEntries` / `parseSkillFileGuarded`.
 */
export function loadSkillDir(dir: string, label = "local"): Skill[] {
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  for (const entry of readSkillDirEntries(dir, label, 0)) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const skill = parseSkillFileGuarded(join(dir, entry.name));
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
  // Shared read/parse guards (see `readSkillDirEntries` / `parseSkillFileGuarded`):
  // `loadScopedSkills` already returned [] for a non-existent top-level dir, so a
  // read failure here means the dir existed but couldn't be listed — logged, not
  // swallowed (the old bare `return` dropped the whole scope with zero signal,
  // the production incident this fix targets). One bad file drops only itself.
  for (const entry of readSkillDirEntries(dir, `${scope}-scope`, depth)) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const skill = parseSkillFileGuarded(join(dir, entry.name));
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

/**
 * Parse a single SKILL.md file into a Skill object. Returns null if invalid.
 * `opts.cap` defaults to false (full body); only the prompt-load path
 * (`parseSkillFileGuarded`) passes `{ cap: true }`.
 */
export function parseSkillFile(path: string, opts?: { cap?: boolean }): Skill | null {
  const raw = readFileSync(path, "utf-8");
  return parseSkillContent(raw, path, opts);
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

/**
 * Paths already warned about body truncation — dedup so an oversized skill warns
 * once per process, not once per chat turn (`loadConversationSkills` re-parses
 * the live workspace/user dirs on every turn).
 */
const warnedTruncatedPaths = new Set<string>();

/** Parse SKILL.md content string. Exported for testing. */
export function parseSkillContent(
  raw: string,
  sourcePath: string,
  opts?: { cap?: boolean },
): Skill | null {
  const { data, content } = matter(raw);

  // Strict-validate the frontmatter against the canonical schema; fail-soft per
  // skill (skip + warn, never throw — mirrors `parseSkillFileGuarded`). The
  // mapper is the ONE place the on-disk (nested/kebab) → runtime (flat/camel)
  // transform lives; `scope` is stamped afterwards by `collectScopedSkills`.
  const result = validateFrontmatter(data);
  if (!result.ok) {
    // Turn a silent skip into an actionable instruction when the file is still
    // in the pre-cutover format (legacy top-level fields) — the operator likely
    // deployed without running the one-time migration.
    const looksLegacy = [
      "type",
      "requires-bundles",
      "applies-to-tools",
      "loading-strategy",
      "loading_strategy",
    ].some((k) => k in data);
    const hint = looksLegacy
      ? " — legacy format detected; run `bun run migrate:skill-frontmatter`"
      : "";
    log.warn(
      `[skill] invalid frontmatter in ${sourcePath} — skipped: ${result.errors.join("; ")}${hint}`,
    );
    return null;
  }
  const manifest = mapFrontmatterToManifest(result.value);

  // Body cap applies ONLY when explicitly requested (`cap: true`). The sole
  // caller that asks is the prompt-load path (`parseSkillFileGuarded`); the
  // default is the FULL body, so read/inspect/round-trip callers (skills__read,
  // writer.readSkill / listSkills) never see — or persist — a truncated copy of
  // user-authored content.
  const trimmed = content.trim();
  let body = trimmed;
  if (opts?.cap === true) {
    const capped = truncateMarkdownToBudget(trimmed, MAX_SKILL_BODY_CHARS);
    body = capped.body;
    if (capped.truncated && !warnedTruncatedPaths.has(sourcePath)) {
      warnedTruncatedPaths.add(sourcePath);
      const omitted =
        capped.sectionsOmitted > 0
          ? ` (${capped.sectionsOmitted} section${capped.sectionsOmitted === 1 ? "" : "s"} omitted)`
          : "";
      log.warn(
        `[skill] body capped to ${MAX_SKILL_BODY_CHARS} chars${omitted} in ${sourcePath} — trim the skill or move depth into references/`,
      );
    }
  }
  return { manifest, body, sourcePath };
}

/**
 * Boot-time partition of the *raw* skill cache by role: `always` = the context
 * channel (Layer 0/1, sorted by priority); `dynamic` = matchable/conditional
 * (tool-affinity Layer 3 + matcher).
 *
 * NOTE — do not confuse with `partitionSkillsByRole` in `select.ts`. This one
 * runs once at boot over the full on-disk set and intentionally keeps *disabled*
 * `always` skills in the `context` cache (no per-turn status gate).
 * `partitionSkillsByRole` is the per-conversation router and DOES drop disabled
 * skills. Same split, different lifecycle — pick by call site (boot vs. turn).
 */
export function partitionSkills(skills: Skill[]): { context: Skill[]; skills: Skill[] } {
  const context = skills
    .filter((s) => s.manifest.loadingStrategy === "always")
    .sort((a, b) => a.manifest.priority - b.manifest.priority);
  const matchable = skills.filter((s) => s.manifest.loadingStrategy === "dynamic");
  return { context, skills: matchable };
}
