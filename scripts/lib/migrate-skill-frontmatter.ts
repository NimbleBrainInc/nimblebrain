/**
 * Pure transform for the one-time skill-frontmatter migration.
 *
 * Converts a LEGACY SKILL.md frontmatter (flat top-level `type` / `version` /
 * `priority` / `scope` / `applies-to-tools` / `requires-bundles` /
 * `loading_strategy`, plus `metadata.{triggers,keywords}`) into the canonical
 * shape the runtime now validates: standard fields top-level, NimbleBrain
 * config nested under `metadata.nimblebrain.*`. See
 * `src/skills/schemas/skill-manifest.ts` and `research/SPEC-skill-system.md` §6.4.
 *
 * The legacy → canonical mapping:
 *   - `type: context`                 → `loading-strategy: always`
 *   - `type: skill` (or unset)        → `loading-strategy: dynamic`
 *   - explicit `loading[-_]strategy`  → `always` if "always", else `dynamic`
 *                                       (legacy `tool_affined` / `retrieval` /
 *                                       `explicit` / `trigger` all collapse to
 *                                       `dynamic`; the mechanism is re-derived
 *                                       from tool-affinity / triggers at load)
 *   - top-level `priority`            → `metadata.nimblebrain.priority`
 *   - `applies-to-tools`              → `metadata.nimblebrain.tool-affinity`
 *   - `metadata.triggers`            → `metadata.nimblebrain.triggers`
 *   - `status` (if present)           → `metadata.nimblebrain.status`
 *   - top-level/`meta` `version`      → `metadata.version` (canonical conventional)
 *
 * DROPPED (deliberately, matching the cutover): `type` (replaced by
 * `loading-strategy`), `requires-bundles` (bundles are sunset), `metadata.keywords`
 * (folded into description at authoring time), top-level `scope` (stamped from the
 * directory tier at load, never persisted), and any non-canonical `metadata.*`
 * keys the runtime doesn't model (e.g. `tags`, `category`).
 *
 * Serialization is delegated to the writer's `serializeSkill` so a migrated
 * file is byte-identical to one freshly written through `skills__create`.
 *
 * Pure — no I/O. The CLI wrapper (`scripts/migrate-skill-frontmatter.ts`) does
 * the filesystem walk; this module is unit-tested directly.
 */

import matter from "gray-matter";
import type {
  SkillLoadingStrategy,
  SkillManifest,
  SkillStatus,
} from "../../src/skills/schemas/skill-manifest.ts";
import { validateFrontmatter } from "../../src/skills/schemas/skill-manifest.ts";
import { serializeSkill } from "../../src/skills/writer.ts";

/** Top-level keys that only ever appear in the legacy shape. */
const LEGACY_TOP_LEVEL_KEYS = [
  "type",
  "version",
  "priority",
  "scope",
  "applies-to-tools",
  "appliesToTools",
  "requires-bundles",
  "requiresBundles",
  "loading-strategy",
  "loading_strategy",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a legacy list (array, or a space-separated string) into a string[]. */
function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof v === "string" && v.trim().length > 0) {
    return v.trim().split(/\s+/);
  }
  return undefined;
}

/**
 * Resolve the legacy strategy/type pair into the two-value enum. An explicit
 * legacy strategy wins over `type` (mirrors the old loader precedence); only
 * "always" survives as `always`, everything else becomes `dynamic` (the actual
 * mechanism is re-derived from tool-affinity / triggers at load time).
 */
function resolveStrategy(rawStrategy: unknown, type: unknown): SkillLoadingStrategy {
  if (typeof rawStrategy === "string" && rawStrategy.trim().length > 0) {
    return rawStrategy.trim().toLowerCase().replace(/_/g, "-") === "always"
      ? "always"
      : "dynamic";
  }
  return type === "context" ? "always" : "dynamic";
}

/**
 * Project legacy parsed frontmatter → the canonical runtime `SkillManifest`.
 * Unknown/dropped fields are simply not carried over.
 */
export function migrateFrontmatterToManifest(legacy: Record<string, unknown>): SkillManifest {
  const meta = isRecord(legacy.metadata) ? legacy.metadata : {};

  const loadingStrategy = resolveStrategy(
    legacy["loading-strategy"] ?? legacy.loading_strategy,
    legacy.type,
  );

  const priority = typeof legacy.priority === "number" ? legacy.priority : 50;

  const rawStatus = legacy.status ?? meta.status;
  const status: SkillStatus = rawStatus === "disabled" ? "disabled" : "active";

  const toolAffinity = asStringArray(
    legacy["applies-to-tools"] ?? legacy.appliesToTools ?? meta["applies-to-tools"],
  );
  const triggers = asStringArray(meta.triggers);
  const allowedTools = asStringArray(legacy["allowed-tools"] ?? legacy.allowedTools);
  const author = typeof meta.author === "string" ? meta.author : undefined;
  // `version` is a canonical conventional field (`metadata.version`) the runtime
  // models and round-trips through create — so carry it across rather than drop
  // it. Legacy authored it top-level; the canonical home is `metadata.version`.
  const versionRaw = legacy.version ?? meta.version;
  const version = typeof versionRaw === "string" ? versionRaw : undefined;

  // Fold legacy `keywords` into the description rather than dropping them — the
  // catalog/retrieval activation signal must survive the cutover (the standard
  // keeps "when to use" terms in the description). Idempotent: a migrated file
  // is canonical (no `keywords`), so it's never re-folded.
  const keywords = asStringArray(meta.keywords);
  const baseDescription = String(legacy.description ?? "");
  const folded =
    keywords && keywords.length > 0
      ? `${baseDescription} Use when the user mentions: ${keywords.join(", ")}.`.trim()
      : baseDescription;
  // Clamp to the schema's 1024 description cap so folding keywords can't push a
  // migrated skill past validation (the loader would otherwise skip it).
  const description = folded.length > 1024 ? `${folded.slice(0, 1021)}...` : folded;

  return {
    name: String(legacy.name ?? ""),
    description,
    loadingStrategy,
    priority,
    status,
    ...(toolAffinity ? { toolAffinity } : {}),
    ...(triggers ? { triggers } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(typeof legacy.license === "string" ? { license: legacy.license } : {}),
    ...(typeof legacy.compatibility === "string"
      ? { compatibility: legacy.compatibility }
      : {}),
    ...(author ? { author } : {}),
    ...(version ? { version } : {}),
  };
}

/** True when the parsed frontmatter still carries any legacy signal. */
function hasLegacyShape(data: Record<string, unknown>): boolean {
  if (LEGACY_TOP_LEVEL_KEYS.some((k) => k in data)) return true;
  const meta = isRecord(data.metadata) ? data.metadata : {};
  // `keywords` is always legacy; `triggers` directly under `metadata` is legacy
  // (the canonical home is `metadata.nimblebrain.triggers`).
  if ("keywords" in meta) return true;
  if ("triggers" in meta && !isRecord(meta.nimblebrain)) return true;
  return false;
}

export interface MigrationResult {
  content: string;
  changed: boolean;
  /**
   * Set when the migrated output would FAIL the loader's strict
   * `validateFrontmatter` (e.g. a non-conforming legacy name like `My_Skill`,
   * an empty description). The caller reports this as an error so a silent-skip
   * at load becomes a loud, actionable migration failure. `content` is the
   * original (unwritten) text when `error` is set.
   */
  error?: string;
}

/**
 * Migrate one SKILL.md's full text. Idempotent: a file already in canonical
 * shape (a `metadata.nimblebrain` block and no legacy signal) is returned
 * unchanged. Throws only if `raw` isn't parseable frontmatter (the caller
 * decides whether to skip or fail).
 */
export function migrateSkillContent(raw: string): MigrationResult {
  const parsed = matter(raw);
  const data = isRecord(parsed.data) ? (parsed.data as Record<string, unknown>) : {};

  // Not a skill file (e.g. a stray NOTES.md under a skills/ tree with no or
  // foreign frontmatter): skip rather than write junk `name: ""` frontmatter.
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) return { content: raw, changed: false };

  const alreadyCanonical =
    isRecord(data.metadata) && isRecord(data.metadata.nimblebrain) && !hasLegacyShape(data);
  if (alreadyCanonical) return { content: raw, changed: false };

  const manifest = migrateFrontmatterToManifest(data);
  // `serializeSkill` re-wraps the body with leading/trailing newlines, so feed
  // it the trimmed body to avoid accumulating blank lines on repeated runs.
  const content = serializeSkill(manifest, parsed.content.trim());

  // Validate the OUTPUT against the same schema the loader enforces. The loader
  // fails soft (skip + warn), so without this a file that can't be loaded would
  // be reported "migrated" and then silently vanish from prompts. Surface it as
  // an error (e.g. a legacy name like `My_Skill` that the strict pattern rejects).
  const check = validateFrontmatter(matter(content).data);
  if (!check.ok) {
    return { content: raw, changed: false, error: check.errors.join("; ") };
  }
  return { content, changed: true };
}
