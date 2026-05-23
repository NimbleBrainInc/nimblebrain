import { type Static, Type } from "@sinclair/typebox";
import { NumberEnum, StringEnum } from "./_shared.ts";

// ── Shared building blocks ───────────────────────────────────────────────

const ScopeAll = StringEnum(["org", "workspace", "user", "bundle"] as const, {
  description: "Filter to a single tier of the skill catalog.",
});

const ScopeWritable = StringEnum(["org", "workspace", "user"] as const, {
  description: "Tier to write the skill into. Bundle (Layer 1) is not writable.",
});

const SkillType = StringEnum(["skill", "context"] as const, {
  description: "`skill` for procedural how-to content; `context` for declarative facts.",
});

const SkillStatus = StringEnum(["active", "draft", "disabled", "archived"] as const, {
  description: "`active` to load. `draft` while authoring. Default `active`.",
});

const SkillManifestMetadata = Type.Object({
  keywords: Type.Optional(Type.Array(Type.String())),
  triggers: Type.Optional(Type.Array(Type.String())),
  category: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});

// Manifest fields shared by create + update. `name` is required for create
// (rebuilt below with explicit `required`); update is a partial of these
// minus name (renames are not patchable — see skills.ts comment at the
// SKILL_UPDATE_MANIFEST_PROPERTIES site).
const ManifestFields = {
  name: Type.String({
    pattern: "^[a-zA-Z0-9_-]+$",
    description: "Becomes the filename. Alphanumeric, dash, underscore.",
  }),
  description: Type.String({
    description: "What the skill does. Surfaced to the agent during Layer 3 selection.",
  }),
  type: SkillType,
  priority: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: "Selection priority. 11–99 for non-core. Default 50.",
    }),
  ),
  status: Type.Optional(SkillStatus),
  version: Type.Optional(Type.String({ description: "Semver. Default 1.0.0." })),
  metadata: Type.Optional(SkillManifestMetadata),
};

// ── Tool input schemas ───────────────────────────────────────────────────

export const SkillsListInput = Type.Object({
  scope: Type.Optional(ScopeAll),
  layer: Type.Optional(
    NumberEnum([1, 3] as const, {
      description: "Filter to Layer 1 (vendored) or Layer 3 (orchestration) skills.",
    }),
  ),
  type: Type.Optional(
    Type.String({ description: "Filter by manifest `type` (e.g. `context`, `skill`)." }),
  ),
  tool_affinity: Type.Optional(
    Type.String({
      description: "A tool name; returns only skills whose `applies_to_tools` glob matches it.",
    }),
  ),
  status: Type.Optional(
    StringEnum(["active", "draft", "disabled", "archived"] as const, {
      description: "Filter by lifecycle status. Defaults to all statuses when omitted.",
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
      required: ["name", "description", "type"],
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
// create where description+type are required.
const UpdateManifestFields = {
  description: Type.Optional(ManifestFields.description),
  type: Type.Optional(ManifestFields.type),
  priority: ManifestFields.priority,
  status: ManifestFields.status,
  version: ManifestFields.version,
  metadata: ManifestFields.metadata,
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

export const SkillsMoveScopeInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
    target_scope: StringEnum(["org", "workspace", "user"] as const, {
      description: "Tier to relocate the skill into.",
    }),
  },
  { required: ["id", "target_scope"] },
);
export type SkillsMoveScopeInput = Static<typeof SkillsMoveScopeInput>;

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

/** Per-skill lifecycle status. */
export type SkillStatus = "active" | "draft" | "disabled" | "archived";

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
  type?: string;
  tokens: number;
  source: SkillSource;
  description?: string;
  modifiedAt?: string;
  loadingStrategy?: string;
  appliesToTools?: string[];
  priority?: number;
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
    type?: string;
    priority?: number;
    loadingStrategy?: string;
    appliesToTools?: string[];
    status?: string;
    overrides?: Array<{ bundle?: string; skill?: string; reason: string }>;
    derivedFrom?: string;
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
  loadedBy: "always" | "tool_affinity";
  reason: string;
}

export interface SkillsActiveForOutput {
  active: ActiveSkillEntry[];
  conversationId: string;
}
