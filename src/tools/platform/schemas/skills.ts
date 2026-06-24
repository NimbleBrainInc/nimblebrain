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
  },
  { required: ["id"] },
);
export type SkillsReadInput = Static<typeof SkillsReadInput>;

export const SkillsActiveForInput = Type.Object({
  conversation_id: Type.Optional(
    Type.String({
      description:
        "Conversation id whose loaded-skill state is being inspected. " +
        "Optional inside a chat — defaults to the current conversation.",
    }),
  ),
});
export type SkillsActiveForInput = Static<typeof SkillsActiveForInput>;

export const SkillsLoadingLogInput = Type.Object({
  conversation_id: Type.Optional(
    Type.String({ description: "Filter to a single conversation id." }),
  ),
  skill_id: Type.Optional(
    Type.String({ description: "Filter to runs that loaded this specific skill id." }),
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
      Type.String({ description: "New markdown body. Omit to keep the current body." }),
    ),
  },
  { required: ["id"] },
);
export type SkillsUpdateInput = Static<typeof SkillsUpdateInput>;

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

// ── Tool output types ────────────────────────────────────────────────────
//
// Same convention as `automations.ts` §2.1 in `tools/platform/AGENTS.md`:
// type-only exports, the handler's return type IS the contract, web and
// server both import from here. Skills is a cleaner case than
// automations — the read-side shapes lived nowhere canonical before
// (both server's `tools/platform/skills.ts` AND web's
// `pages/settings/SkillsTab.tsx` / `components/SkillsPopover.tsx`
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
 * Single entry in the `skills__active_for` response — one currently-
 * active layer-3 skill for the named conversation, with provenance for
 * why it loaded.
 */
export interface ActiveSkillEntry {
  id: string;
  layer: 3;
  scope: SkillScope;
  tokens: number;
  // Historical `skills.loaded` events may carry `always` (pre-cutover runs);
  // new selections only ever emit `tool_affinity`.
  loadedBy: "always" | "tool_affinity";
  reason: string;
}

export interface SkillsActiveForOutput {
  active: ActiveSkillEntry[];
  conversationId: string;
}
