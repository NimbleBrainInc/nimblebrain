/**
 * Canonical skill manifest schema — the single source of truth.
 *
 * One TypeBox definition (`SkillFrontmatter`) validates the on-disk SKILL.md
 * frontmatter; `mapFrontmatterToManifest` projects it into the flat camelCase
 * runtime `SkillManifest` the rest of the runtime consumes. Replaces the prior
 * hand-written interface + lenient hand-parser + separate tool schema (three
 * drifting definitions). See `research/SPEC-skill-system.md` §6.4.
 *
 * Two artifacts:
 *  - SOURCE skill (NimbleBrainInc/skills): pristine Agent Skills standard —
 *    `name`, `description`, `license?`, `compatibility?`, `allowed-tools?`,
 *    `metadata.{author,version}?`. No `metadata.nimblebrain` block.
 *  - RUNTIME skill (vendored core/builtin, or materialized into a tenant
 *    workspace): the standard fields PLUS our config nested under
 *    `metadata.nimblebrain.*`. This is what the loader reads.
 *
 * The standard's `metadata` is a string→string map; we nest an object under
 * `metadata.nimblebrain` on the runtime copy only (never re-exported), so a
 * strict `skills-ref` check applies to the source, not here.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Union-of-literals (Value.Check-compatible), inlined to avoid a tools/ import. */
const lit = <T extends string>(...vals: T[]) => Type.Union(vals.map((v) => Type.Literal(v)));

// ── On-disk schema (the validated contract) ──────────────────────────────

/** Runtime-stamped audit trail. Written at create, never hand-authored. */
const ProvenanceSchema = Type.Object(
  {
    origin: lit("chat", "admin", "vendored", "connector", "import"),
    "conversation-id": Type.Optional(Type.String()),
    "created-by": Type.Optional(Type.String()),
    "created-at": Type.Optional(Type.String()),
    "updated-at": Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * The NimbleBrain runtime extension — nests under `metadata.nimblebrain`.
 * `loading-strategy` is the only required member: if a skill declares a
 * `nimblebrain` block at all, it must say how it loads.
 */
export const NimblebrainSkillMetaSchema = Type.Object(
  {
    "loading-strategy": lit("always", "dynamic"),
    priority: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    status: Type.Optional(lit("active", "disabled")),
    "tool-affinity": Type.Optional(Type.Array(Type.String())),
    triggers: Type.Optional(Type.Array(Type.String())),
    provenance: Type.Optional(ProvenanceSchema),
  },
  { additionalProperties: false },
);

/** Full on-disk SKILL.md frontmatter (standard fields + our nested extension). */
export const SkillFrontmatterSchema = Type.Object(
  {
    // Standard, top-level. `name`: standard rules (lowercase + hyphens, ≤64,
    // no leading/trailing/consecutive hyphen) — also must match the dir name,
    // enforced by the loader since the pattern can't express it.
    name: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 }),
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    license: Type.Optional(Type.String()),
    compatibility: Type.Optional(Type.String({ maxLength: 500 })),
    // Standard `allowed-tools` is a SPACE-SEPARATED string (tools the skill may call).
    "allowed-tools": Type.Optional(Type.String()),
    metadata: Type.Optional(
      Type.Object(
        {
          author: Type.Optional(Type.String()),
          version: Type.Optional(Type.String()),
          nimblebrain: Type.Optional(NimblebrainSkillMetaSchema),
        },
        // Generic standard metadata (tags, category, …) passes through.
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: false },
);

export type SkillFrontmatter = Static<typeof SkillFrontmatterSchema>;

// ── Runtime types (flat camelCase — what the rest of the runtime consumes) ──

export type SkillScope = "org" | "workspace" | "user" | "bundle";
export type SkillLoadingStrategy = "always" | "dynamic";
export type SkillStatus = "active" | "disabled";

export interface SkillProvenance {
  origin: "chat" | "admin" | "vendored" | "connector" | "import";
  conversationId?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  loadingStrategy: SkillLoadingStrategy;
  priority: number;
  status: SkillStatus;
  toolAffinity?: string[];
  triggers?: string[];
  /** Standard `allowed-tools` — tools the skill may CALL (≠ toolAffinity). */
  allowedTools?: string[];
  license?: string;
  compatibility?: string;
  author?: string;
  version?: string;
  provenance?: SkillProvenance;
  // Stamped at load (never authored, never in the file):
  scope?: SkillScope;
}

// ── Validation + mapping ─────────────────────────────────────────────────

export type FrontmatterValidation =
  | { ok: true; value: SkillFrontmatter }
  | { ok: false; errors: string[] };

/**
 * Strict-validate raw parsed frontmatter against the canonical schema.
 * Returns typed errors (path + message) for the loader to `log.warn` and
 * skip the skill (fail-soft per skill — never throw).
 */
export function validateFrontmatter(data: unknown): FrontmatterValidation {
  if (Value.Check(SkillFrontmatterSchema, data)) {
    return { ok: true, value: data };
  }
  const errors = [...Value.Errors(SkillFrontmatterSchema, data)].map(
    (e) => `${e.path || "/"}: ${e.message}`,
  );
  return { ok: false, errors };
}

function mapProvenance(
  p: NonNullable<NonNullable<SkillFrontmatter["metadata"]>["nimblebrain"]>["provenance"],
): SkillProvenance | undefined {
  if (!p) return undefined;
  return {
    origin: p.origin,
    ...(p["conversation-id"] ? { conversationId: p["conversation-id"] } : {}),
    ...(p["created-by"] ? { createdBy: p["created-by"] } : {}),
    ...(p["created-at"] ? { createdAt: p["created-at"] } : {}),
    ...(p["updated-at"] ? { updatedAt: p["updated-at"] } : {}),
  };
}

/**
 * Project validated frontmatter → the flat runtime manifest. The ONE place the
 * on-disk (nested, kebab, standard) ⇄ runtime (flat, camel) transform lives.
 *
 * Defaults: a skill with no `nimblebrain` block (a pristine source loaded
 * directly) is treated as `dynamic` (on-demand, the cheap default), priority 50,
 * active. `allowed-tools` (space-separated string) splits to an array.
 */
export function mapFrontmatterToManifest(
  fm: SkillFrontmatter,
  stamped: { scope?: SkillScope } = {},
): SkillManifest {
  const nb = fm.metadata?.nimblebrain;
  const allowed = fm["allowed-tools"]?.trim();
  const provenance = mapProvenance(nb?.provenance);
  return {
    name: fm.name,
    description: fm.description,
    loadingStrategy: nb?.["loading-strategy"] ?? "dynamic",
    priority: nb?.priority ?? 50,
    status: nb?.status ?? "active",
    ...(nb?.["tool-affinity"]?.length ? { toolAffinity: nb["tool-affinity"] } : {}),
    ...(nb?.triggers?.length ? { triggers: nb.triggers } : {}),
    ...(allowed ? { allowedTools: allowed.split(/\s+/) } : {}),
    ...(fm.license ? { license: fm.license } : {}),
    ...(fm.compatibility ? { compatibility: fm.compatibility } : {}),
    ...(fm.metadata?.author ? { author: fm.metadata.author } : {}),
    ...(fm.metadata?.version ? { version: fm.metadata.version } : {}),
    ...(provenance ? { provenance } : {}),
    ...(stamped.scope ? { scope: stamped.scope } : {}),
  };
}
