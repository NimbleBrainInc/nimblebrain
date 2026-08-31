import { type Static, Type } from "@sinclair/typebox";
import { NumberEnum, StringEnum } from "./_shared.ts";

// ── Shared building blocks ───────────────────────────────────────────────

const ScopeAll = StringEnum(["org", "workspace", "user", "bundle"] as const, {
  description: "Filter to a single tier of the skill catalog.",
});

const ScopeWritable = StringEnum(["org", "workspace", "user"] as const, {
  description: "Tier to write the skill into. Bundle (Layer 1) is not writable.",
});

const SkillStatus = StringEnum(["active", "disabled"] as const, {
  description: "`active` to load, `disabled` to suppress. Default `active`.",
});

const LoadingStrategy = StringEnum(["always", "dynamic"] as const, {
  description:
    "`always` = always-on context (Layer 0/1); `dynamic` = on-demand (loads via tool-affinity, triggers, or the catalog). Default `dynamic`.",
});

// LLM-facing manifest fields shared by create + update — a flat `Pick` of the
// canonical schema (`schemas/skill-manifest.ts`). Operator/stamped fields
// (`scope`, `provenance`) are excluded per `tools/platform/CLAUDE.md §1.4`; the
// handler maps these to the nested on-disk `metadata.nimblebrain.*` shape.
const ManifestFields = {
  name: Type.String({
    pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
    description: "Becomes the filename. Lowercase letters, numbers, single hyphens.",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: "What the skill does AND when to use it (the catalog activation signal).",
  }),
  loadingStrategy: Type.Optional(LoadingStrategy),
  priority: Type.Optional(
    Type.Number({
      minimum: 11,
      maximum: 99,
      description: "Selection priority. 11–99 for non-core (0–10 reserved for core). Default 50.",
    }),
  ),
  status: Type.Optional(SkillStatus),
  toolAffinity: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tool-name globs (e.g. `gmail__*`); a dynamic skill auto-loads when one is active.",
    }),
  ),
  triggers: Type.Optional(
    Type.Array(Type.String(), {
      description: "Exact phrases that deterministically activate a dynamic skill.",
    }),
  ),
  allowedTools: Type.Optional(
    Type.Array(Type.String(), { description: "Tools the skill is permitted to call." }),
  ),
};

// ── Tool input schemas ───────────────────────────────────────────────────

export const SkillsListInput = Type.Object({
  scope: Type.Optional(ScopeAll),
  layer: Type.Optional(
    NumberEnum([1, 3] as const, {
      description: "Filter to Layer 1 (vendored) or Layer 3 (orchestration) skills.",
    }),
  ),
  loading_strategy: Type.Optional(
    StringEnum(["always", "dynamic"] as const, {
      description: "Filter by loading strategy (`always` or `dynamic`).",
    }),
  ),
  tool_affinity: Type.Optional(
    Type.String({
      description: "A tool name; returns only skills whose `tool-affinity` glob matches it.",
    }),
  ),
  status: Type.Optional(
    StringEnum(["active", "disabled"] as const, {
      description: "Filter by enablement state. Defaults to all statuses when omitted.",
    }),
  ),
  modified_since: Type.Optional(
    Type.String({
      description: "ISO 8601 timestamp; only skills modified at or after this are returned.",
    }),
  ),
});
export type SkillsListInput = Static<typeof SkillsListInput>;

export const SkillsReadInput = Type.Object(
  {
    id: Type.String({
      description: "Skill identifier — filesystem path or `skill://` URI.",
    }),
    version: Type.Optional(
      Type.String({
        description:
          "Read a historical snapshot instead of the live file. Version ids come " +
          "from `skills__history`. Omit for the current body.",
      }),
    ),
  },
  { required: ["id"] },
);
export type SkillsReadInput = Static<typeof SkillsReadInput>;

export const SkillsLoadingLogInput = Type.Object({
  conversation_id: Type.Optional(
    Type.String({ description: "Filter to a single conversation id." }),
  ),
  skill: Type.Optional(
    Type.String({
      description:
        "Filter to one skill, by name or by stable id. Only prompt-composed " +
        "skills carry an id, so name is the form that works across channels.",
    }),
  ),
  loaded_by: Type.Optional(
    StringEnum(["always", "tool_affinity", "trigger", "tool_use", "activation"] as const, {
      description:
        "Filter to one loading channel. `always`/`tool_affinity`/`trigger` composed into " +
        "the system prompt; `tool_use` is a surface-once overlay firing on a matching tool " +
        "call; `activation` is the model loading a Skill Catalog entry by name.",
    }),
  ),
  since: Type.Optional(Type.String({ description: "ISO 8601 lower bound (inclusive)." })),
  until: Type.Optional(Type.String({ description: "ISO 8601 upper bound (inclusive)." })),
});
export type SkillsLoadingLogInput = Static<typeof SkillsLoadingLogInput>;

export const SkillsCreateInput = Type.Object(
  {
    scope: ScopeWritable,
    manifest: Type.Object(ManifestFields, {
      required: ["name", "description"],
      description: "YAML frontmatter for the skill file. Identity + selection metadata.",
    }),
    body: Type.String({
      description: "Markdown body — the prose below the frontmatter.",
    }),
  },
  { required: ["scope", "manifest", "body"] },
);
export type SkillsCreateInput = Static<typeof SkillsCreateInput>;

// Update: partial of ManifestFields minus `name` — renames are not patchable
// via update (the name is the filename; the path-derived id would drift).
// All fields optional (omitted fields keep their current values), unlike
// create where name + description are required.
const UpdateManifestFields = {
  description: Type.Optional(ManifestFields.description),
  loadingStrategy: ManifestFields.loadingStrategy,
  priority: ManifestFields.priority,
  status: ManifestFields.status,
  toolAffinity: ManifestFields.toolAffinity,
  triggers: ManifestFields.triggers,
  allowedTools: ManifestFields.allowedTools,
};

export const SkillsUpdateInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
    manifest: Type.Optional(
      Type.Object(UpdateManifestFields, {
        description: "Partial manifest patch. Omitted fields keep their current values.",
      }),
    ),
    body: Type.Optional(
      Type.String({
        description:
          "Markdown to add or write. Omit to keep the current body. " +
          "When present, `body_mode` is REQUIRED — this tool will not guess " +
          "between adding to the skill and overwriting it.",
      }),
    ),
    body_mode: Type.Optional(
      Type.Union([Type.Literal("append"), Type.Literal("replace")], {
        description:
          "`append` adds `body` after the current content (use this to add a rule). " +
          "`replace` overwrites the whole body. Required whenever `body` is given.",
      }),
    ),
  },
  { required: ["id"] },
);
export type SkillsUpdateInput = Static<typeof SkillsUpdateInput>;

export const SkillsHistoryInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
  },
  { required: ["id"] },
);
export type SkillsHistoryInput = Static<typeof SkillsHistoryInput>;

export const SkillsRestoreInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
    version: Type.String({
      description: "Version id from `skills__history`. Its body becomes the live body.",
    }),
  },
  { required: ["id", "version"] },
);
export type SkillsRestoreInput = Static<typeof SkillsRestoreInput>;

const IdOnlyInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
  },
  { required: ["id"] },
);

export const SkillsDeleteInput = IdOnlyInput;
export type SkillsDeleteInput = Static<typeof SkillsDeleteInput>;

export const SkillsActivateInput = IdOnlyInput;
export type SkillsActivateInput = Static<typeof SkillsActivateInput>;

export const SkillsDeactivateInput = IdOnlyInput;
export type SkillsDeactivateInput = Static<typeof SkillsDeactivateInput>;

// Static schema by design: a per-request name enum would vary the tools block
// with workspace state and bust the cached prefix. Validation against the
// activatable set happens in the handler, which can also return a helpful
// valid-name list on a miss.
export const UseSkillInput = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      description:
        "Skill name exactly as listed in the Skill Catalog section of your instructions.",
    }),
  },
  { required: ["name"] },
);
export type UseSkillInput = Static<typeof UseSkillInput>;

// ── Tool output types ────────────────────────────────────────────────────
//
// Same convention as `automations.ts` §2.1 in `tools/platform/AGENTS.md`:
// type-only exports, the handler's return type IS the contract, web and
// server both import from here. Skills is a cleaner case than
// automations — the read-side shapes lived nowhere canonical before
// (both server's `tools/platform/skills.ts` AND web's
// `pages/settings/SkillsTab.tsx` / `components/InContextPopover.tsx`
// hand-rolled identical interfaces). This file becomes the source of
// truth; both sides import it, drift becomes structurally impossible.

/** Tier a skill lives in. */
export type SkillScope = "org" | "workspace" | "user" | "bundle";

/** Skill layer per the loading-strategy spec. */
export type SkillLayer = 1 | 3;

/** Per-skill enablement state. */
export type SkillStatus = "active" | "disabled";

/**
 * Source provenance for a skill — where it came from on disk or via
 * a bundle. Optional fields; at least one is populated.
 */
export interface SkillSource {
  bundle?: string;
  bundleVersion?: string;
  path?: string;
  uri?: string;
}

/**
 * Row returned per skill by `skills__list`. The summary surface for the
 * settings UI and the agent's `skills__list` enumeration.
 */
export interface SkillSummary {
  id: string;
  name: string;
  layer: SkillLayer;
  scope: SkillScope;
  status: SkillStatus;
  tokens: number;
  source: SkillSource;
  description?: string;
  modifiedAt?: string;
  loadingStrategy?: string;
  toolAffinity?: string[];
  triggers?: string[];
  priority?: number;
  /**
   * Computed loading visibility: whether any loader path reaches this skill
   * (`wouldLoad`) and the mechanism by which it loads. `mechanism: "none"`
   * (`wouldLoad: false`) flags a dead skill — no strategy, no triggers, no
   * tool affinity — that would otherwise be silently inert. Derived, not
   * stored on disk.
   */
  loading?: { wouldLoad: boolean; mechanism: "always" | "tool_affinity" | "trigger" | "none" };
}

export interface SkillsListOutput {
  skills: SkillSummary[];
}

/**
 * Full skill detail returned by `skills__read` — includes the markdown
 * body and the full manifest metadata block.
 */
export interface SkillDetail {
  id: string;
  content: string;
  layer: SkillLayer;
  scope: SkillScope;
  source: SkillSource;
  metadata: {
    name: string;
    description?: string;
    priority?: number;
    loadingStrategy?: string;
    toolAffinity?: string[];
    triggers?: string[];
    status?: string;
  };
  modifiedAt?: string;
}

/** `SkillsReadOutput` is the detail itself — no wrapper envelope. */
export type SkillsReadOutput = SkillDetail;

/**
 * `nb__use_skill` result. `loaded` delivers the skill (body rides the result's
 * `content`, not this typed envelope); `already_loaded` is the dedupe note —
 * the body is already in the conversation's context, so none is re-delivered.
 */
export type SkillsUseOutput =
  | { status: "loaded"; name: string; scope: string; tokens: number }
  | { status: "already_loaded"; name: string };
