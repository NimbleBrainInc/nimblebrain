// ---------------------------------------------------------------------------
// On-disk schema for skill manifests (YAML frontmatter at the top of a
// `.md` file). Demonstrates the Ring-3 pattern from the schemas migration:
//
//   - The on-disk shape is a SUPERSET of the LLM-facing tool input
//     (`SkillsCreateInput` from `src/tools/platform/schemas/skills.ts`).
//   - The LLM-facing schema deliberately excludes operator-only fields
//     (`allowedTools`, `requiresBundles`, `loadingStrategy`, `appliesToTools`,
//     `overrides`, `derivedFrom`) — they live on the type and the on-disk
//     format only; agents can't author them.
//   - Both schemas live as TypeBox declarations; the on-disk type is the
//     reference, the tool input is a `Pick<>` — drift between the two is
//     a compile error.
//
// Migration scope: this module is the only on-disk schema in the PR
// that established the pattern. The remaining on-disk formats
// (FileEntry, Automation, ConversationEvent, WorkspaceConfig, MCPB
// manifest) are tracked in #163 for a follow-up PR. Use this file as
// the template: declare the SUPERSET shape (writer + operator-only
// fields), let any LLM-facing tool input be a `Pick<>` of the subset.
//
// No runtime validation is wired today — the loader (`src/skills/loader.ts`)
// continues to use its existing permissive parser. Schema-validating reads
// is a separate decision that should account for backwards compatibility
// with already-on-disk files (an aggressive validator would reject manifests
// that older writers produced).
// ---------------------------------------------------------------------------

import { type Static, Type } from "@sinclair/typebox";

// ── Shared types (mirrors src/skills/types.ts) ───────────────────────────

const SkillType = Type.Union([Type.Literal("skill"), Type.Literal("context")]);

const SkillScope = Type.Union([
  Type.Literal("org"),
  Type.Literal("workspace"),
  Type.Literal("user"),
  Type.Literal("bundle"),
]);

const SkillStatus = Type.Union([
  Type.Literal("active"),
  Type.Literal("draft"),
  Type.Literal("disabled"),
  Type.Literal("archived"),
]);

const SkillLoadingStrategy = Type.Union([
  Type.Literal("always"),
  Type.Literal("tool_affined"),
  Type.Literal("retrieval"),
  Type.Literal("explicit"),
]);

const SkillOverride = Type.Object({
  bundle: Type.Optional(Type.String()),
  skill: Type.Optional(Type.String()),
  reason: Type.String(),
});

const SkillMetadata = Type.Object({
  keywords: Type.Array(Type.String()),
  triggers: Type.Array(Type.String()),
  category: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  author: Type.Optional(Type.String()),
  created_at: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
});

// ── On-disk manifest schema ──────────────────────────────────────────────

/**
 * Full on-disk skill manifest (YAML frontmatter). Includes operator-only
 * fields that don't appear in the LLM-facing `SkillsCreateInput`. The
 * loader writes this shape; the LLM-facing tool input is a `Pick<>` of
 * a subset of these fields.
 *
 * Fields at the bottom of the object (`overrides`, `derivedFrom`) are
 * "designed but not yet enforced" — the loader parses them so a manifest
 * authored against the full schema round-trips cleanly when those
 * features land.
 */
export const SkillManifestOnDisk = Type.Object({
  name: Type.String({
    pattern: "^[a-zA-Z0-9_-]+$",
    description: "Becomes the filename. Alphanumeric, dash, underscore.",
  }),
  description: Type.String(),
  version: Type.String({ description: "Semver. Default 1.0.0." }),
  type: SkillType,
  priority: Type.Number({ minimum: 0, maximum: 100 }),
  // ---- Operator-only fields (not in LLM-facing schema) ------------------
  allowedTools: Type.Optional(Type.Array(Type.String())),
  requiresBundles: Type.Optional(Type.Array(Type.String())),
  metadata: Type.Optional(SkillMetadata),
  // ---- Phase 2 visibility additions -------------------------------------
  scope: Type.Optional(SkillScope),
  loadingStrategy: Type.Optional(SkillLoadingStrategy),
  appliesToTools: Type.Optional(Type.Array(Type.String())),
  status: Type.Optional(SkillStatus),
  // ---- Designed-but-not-enforced (parsed for forward-compat) ------------
  overrides: Type.Optional(Type.Array(SkillOverride)),
  derivedFrom: Type.Optional(Type.String()),
});
export type SkillManifestOnDisk = Static<typeof SkillManifestOnDisk>;
