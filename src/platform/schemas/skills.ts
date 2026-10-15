import { type Static, Type } from "@sinclair/typebox";
import { clearable, NumberEnum, ObjectUnion, StringEnum } from "./_shared.ts";

// ── Shared building blocks ───────────────────────────────────────────────

const ScopeAll = StringEnum(["org", "workspace", "user", "provided"] as const, {
  description: "Filter to a single tier of the skill catalog.",
});

const ScopeWritable = StringEnum(["org", "workspace", "user"] as const, {
  description: "Tier to write the skill into. Connector (Layer 1) is not writable.",
});

const SkillStatus = StringEnum(["active", "disabled"] as const, {
  description: "`active` to load, `disabled` to suppress. Default `active`.",
});

const LoadingStrategy = StringEnum(["always", "dynamic"] as const, {
  description:
    "`always` = always-on context (Layer 0/1); `dynamic` = on-demand (loads via tool-affinity, triggers, or the catalog). Default `dynamic`.",
});

// How a `---` block at the head of `body` is treated. The canonical skill
// artifact is a whole file, so a caller handing one over is the normal case,
// not the exception — `apply` is the default and `ignore` is the escape hatch
// for a body whose leading `---` is genuinely prose.
const FrontmatterMode = StringEnum(["apply", "ignore"] as const, {
  description:
    "`apply` (default): a leading `---` block in `body` is read as SKILL.md frontmatter — " +
    "its fields override `manifest` and it is stripped from the stored body; invalid " +
    "frontmatter is an error, never stored as prose. `ignore`: keep the block as body text. " +
    'Ignored under `body_mode: "append"` — an appended fragment is not a document ' +
    "declaring itself, so a leading `---` there stays prose either way.",
});

/**
 * The priority band a TOOL caller may write — narrower than the on-disk schema,
 * which allows 0–100 because the platform's own vendored core skills live in
 * 0–10. That band is not decoration: `partitionContextSkills` renders a
 * non-connector skill at or below `CORE_PRIORITY_THRESHOLD` raw in Layer 0
 * rather than inside `<context-skill>` containment, so it is the boundary
 * separating first-party identity from tenant-authored prose.
 *
 * Exported so the one place that admits manifest fields from outside this
 * schema — a pasted SKILL.md, validated against the on-disk contract — can
 * check against this band rather than restate it.
 */
export const SkillPriority = Type.Number({
  minimum: 11,
  maximum: 99,
  description: "Selection priority. 11–99 for non-core (0–10 reserved for core). Default 50.",
});

// LLM-facing manifest fields shared by create + update — a flat `Pick` of the
// canonical schema (`schemas/skill-manifest.ts`). Operator/stamped fields
// (`scope`, `provenance`) are excluded per `platform/AGENTS.md §1.4`; the
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
  priority: Type.Optional(SkillPriority),
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
    StringEnum(
      ["always", "tool_affinity", "trigger", "before_call", "tool_use", "activation"] as const,
      {
        description:
          "Filter to one loading channel. `always`/`tool_affinity`/`trigger` composed into " +
          "the system prompt; `before_call` is a skill bound to a tool, delivered while the " +
          "first call to that tool was held; `tool_use` is one delivered after a call that ran " +
          "or on a promotion; `activation` is the model loading a Skill Catalog entry by name.",
      },
    ),
  ),
  since: Type.Optional(Type.String({ description: "ISO 8601 lower bound (inclusive)." })),
  until: Type.Optional(Type.String({ description: "ISO 8601 upper bound (inclusive)." })),
});
export type SkillsLoadingLogInput = Static<typeof SkillsLoadingLogInput>;

// Create: ManifestFields minus `status`, for the reason `UpdateManifestFields`
// gives below. A skill born disabled is worse than a disabled edit, not better:
// the tier merge dedups by NAME before the active-status filter runs, so a
// lower-tier skill created disabled takes the name and is then dropped — and
// the same-named org skill it shadowed composes nowhere at all.
const { status: _statusNotCreatable, ...CreateManifestFields } = ManifestFields;

export const SkillsCreateInput = Type.Object(
  {
    scope: ScopeWritable,
    manifest: Type.Object(CreateManifestFields, {
      required: ["name", "description"],
      description: "YAML frontmatter for the skill file. Identity + selection metadata.",
    }),
    body: Type.String({
      description:
        "Markdown body — the prose below the frontmatter. May be a whole SKILL.md: " +
        "a leading `---` block is parsed and applied to the manifest (see `frontmatter`).",
    }),
    frontmatter: Type.Optional(FrontmatterMode),
  },
  { required: ["scope", "manifest", "body"] },
);
export type SkillsCreateInput = Static<typeof SkillsCreateInput>;

// Update: a patch of ManifestFields minus `name` and `status`.
//
// `name` is not patchable because it IS the filename — the path-derived id
// would drift out from under the caller.
//
// `status` is not patchable because it is the DURABLE off switch, shared by
// every conversation that loads the skill and every workspace the user
// touches. `set_status` is its one door, and that door is internal so only the
// settings UI reaches it; leaving a second, model-visible way in through a
// `manifest` patch would hand the agent back exactly the capability the mute
// exists to take away from it.
//
// An omitted field keeps its value; `null` clears one (platform/AGENTS.md
// §1.3). `description` is required on every skill, so it takes no `null`.
const UpdateManifestFields = {
  description: Type.Optional(ManifestFields.description),
  loadingStrategy: clearable(
    LoadingStrategy,
    "`always` or `dynamic`, or null for the default (`dynamic`).",
  ),
  priority: clearable(SkillPriority, "11–99, or null for the default (50)."),
  toolAffinity: clearable(
    Type.Array(Type.String()),
    "Tool-name globs (e.g. `gmail__*`); a dynamic skill auto-loads when one is active. " +
      "null removes them.",
  ),
  triggers: clearable(
    Type.Array(Type.String()),
    "Exact phrases that deterministically activate a dynamic skill. null removes them.",
  ),
  allowedTools: clearable(
    Type.Array(Type.String()),
    "Tools the skill is permitted to call. null removes the list.",
  ),
};

export const SkillsUpdateInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
    manifest: Type.Optional(
      Type.Object(UpdateManifestFields, {
        description:
          "Partial manifest patch. An omitted field keeps its value; `null` clears it to the default.",
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
    frontmatter: Type.Optional(FrontmatterMode),
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

export const SkillsSetStatusInput = Type.Object(
  {
    id: Type.String({ description: "Filesystem path returned by `skills__list`." }),
    status: Type.Union([Type.Literal("active"), Type.Literal("disabled")], {
      description: "Durable status written to the skill's frontmatter.",
    }),
  },
  { required: ["id", "status"] },
);
export type SkillsSetStatusInput = Static<typeof SkillsSetStatusInput>;

/**
 * The mute pair takes a skill NAME, not a path. `IdOnlyInput`'s description
 * says "filesystem path", which sends the model down the `update`/`delete`
 * shape — and a connector-published skill has no path at all, so a basename
 * fallback cannot rescue it.
 */
const SkillNameInput = Type.Object(
  {
    id: Type.String({
      description:
        "Skill name, exactly as `skills__list` or the Skill Catalog reports it " +
        "(e.g. `house-voice`, `connector:<server>:<skill>`). Not a filesystem path.",
    }),
  },
  { required: ["id"] },
);

export const SkillsActivateInput = SkillNameInput;
export type SkillsActivateInput = Static<typeof SkillsActivateInput>;

export const SkillsDeactivateInput = SkillNameInput;
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

// ── Tool output schemas ──────────────────────────────────────────────────
//
// Each tool registers its output schema with `typedTool`, which holds every
// success result to the schema's static type and publishes the schema on
// `tools/list` (`src/platform/AGENTS.md` §2.1). The web shell imports the same
// types through codegen.
//
// Output schemas stay open — no `additionalProperties: false` — because the SDK
// client validates every success result against them and fails a call whose
// result it rejects.

const ScopeValue = StringEnum(["org", "workspace", "user", "provided"] as const);
const StatusValue = StringEnum(["active", "disabled"] as const);
const LayerValue = NumberEnum([1, 3] as const);

/** Tier a skill lives in. */
export type SkillScope = Static<typeof ScopeValue>;

/** Skill layer per the loading-strategy spec. */
export type SkillLayer = Static<typeof LayerValue>;

/** Per-skill enablement state. */
export type SkillStatus = Static<typeof StatusValue>;

/**
 * Source provenance for a skill — where it came from on disk or via
 * a connector. Optional fields; at least one is populated.
 */
export const SkillSource = Type.Object({
  connector: Type.Optional(Type.String()),
  connectorVersion: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  uri: Type.Optional(Type.String()),
});
export type SkillSource = Static<typeof SkillSource>;

/**
 * Computed loading visibility: whether any loader path reaches a skill
 * (`wouldLoad`) and the mechanism by which it loads. `mechanism: "none"`
 * (`wouldLoad: false`) flags a dead skill — no strategy, no triggers, no tool
 * affinity — that would otherwise be silently inert. Derived by
 * `resolveLoadingMechanism`, not stored on disk.
 */
export const SkillLoading = Type.Object({
  wouldLoad: Type.Boolean(),
  mechanism: StringEnum(["always", "tool_affinity", "trigger", "none"] as const),
});
export type SkillLoading = Static<typeof SkillLoading>;

/**
 * Row returned per skill by `skills__list`. The summary surface for the
 * settings UI and the agent's `skills__list` enumeration.
 */
export const SkillSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  layer: LayerValue,
  scope: ScopeValue,
  status: StatusValue,
  tokens: Type.Number(),
  source: SkillSource,
  description: Type.Optional(Type.String()),
  modifiedAt: Type.Optional(Type.String()),
  loadingStrategy: Type.Optional(Type.String()),
  toolAffinity: Type.Optional(Type.Array(Type.String())),
  triggers: Type.Optional(Type.Array(Type.String())),
  priority: Type.Optional(Type.Number()),
  loading: Type.Optional(SkillLoading),
});
export type SkillSummary = Static<typeof SkillSummary>;

export const SkillsListOutput = Type.Object({ skills: Type.Array(SkillSummary) });
export type SkillsListOutput = Static<typeof SkillsListOutput>;

/**
 * Full skill detail returned by `skills__read` — includes the markdown
 * body and the full manifest metadata block.
 */
export const SkillDetail = Type.Object({
  id: Type.String(),
  content: Type.String(),
  layer: LayerValue,
  scope: ScopeValue,
  source: SkillSource,
  metadata: Type.Object({
    name: Type.String(),
    description: Type.Optional(Type.String()),
    priority: Type.Optional(Type.Number()),
    loadingStrategy: Type.Optional(Type.String()),
    toolAffinity: Type.Optional(Type.Array(Type.String())),
    triggers: Type.Optional(Type.Array(Type.String())),
    status: Type.Optional(Type.String()),
  }),
  modifiedAt: Type.Optional(Type.String()),
  /**
   * Present when the body is longer than the platform delivers: how many
   * characters past the limit it runs. Those trailing sections are cut when the
   * skill loads, so a reader editing it knows what never reaches the model.
   */
  overLimitBy: Type.Optional(Type.Number()),
});
export type SkillDetail = Static<typeof SkillDetail>;

/**
 * One saved version, read with `skills__read { id, version }`. `manifest` is
 * the snapshot's frontmatter as parsed, whatever version of the manifest
 * schema it was written under.
 */
export const SkillVersionDetail = Type.Object({
  id: Type.String(),
  version: Type.String(),
  body: Type.String(),
  manifest: Type.Unknown(),
});
export type SkillVersionDetail = Static<typeof SkillVersionDetail>;

/** The live skill's detail, or one saved version when `version` is given. */
export const SkillsReadOutput = ObjectUnion([SkillDetail, SkillVersionDetail]);
export type SkillsReadOutput = Static<typeof SkillsReadOutput>;

/**
 * One skill reaching the model once (`skills__loading_log`). Rows are projected
 * from stored conversation logs, which keep the shape they were written in, so
 * this accepts every entry the log can hold: `skill` and `tokens` are absent on
 * an entry that recorded neither, and `loaded_by` is open beyond the current
 * vocabulary (`always`, `tool_affinity`, `trigger`, `before_call`, `tool_use`,
 * `activation`). A row with `status` is a bound skill that did NOT reach the
 * model on that call, and says why.
 */
export const SkillLoadRow = Type.Object({
  ts: Type.String(),
  conv_id: Type.String(),
  run_id: Type.Optional(Type.String()),
  skill: Type.Optional(Type.String()),
  skill_id: Type.Optional(Type.String()),
  loaded_by: Type.String(),
  tokens: Type.Optional(Type.Number()),
  scope: Type.Optional(Type.String()),
  connector: Type.Optional(Type.String()),
  tool_name: Type.Optional(Type.String()),
  status: Type.Optional(
    StringEnum(["fetch_failed", "capped", "renamed_unheld"] as const, {
      description:
        "The skill did not reach the model: its body could not be fetched, a held call's " +
        "size cap left it out, or a policy hook renamed the call past the hold.",
    }),
  ),
});

export const SkillsLoadingLogOutput = Type.Object({ loads: Type.Array(SkillLoadRow) });
export type SkillsLoadingLogOutput = Static<typeof SkillsLoadingLogOutput>;

/**
 * Result of a write — `skills__create`, `skills__update`, and
 * `skills__set_status` share it.
 *
 * `loading` answers the question a skill exists to answer, at the moment it is
 * written: a skill that reaches no loader path is reported here rather than
 * discovered later as silence. `frontmatterApplied` names the on-disk fields
 * taken from a pasted SKILL.md, so a caller whose manifest was overridden by
 * the document it handed over is told which fields moved and why.
 */
export const SkillsWriteOutput = Type.Object({
  id: Type.String(),
  name: Type.String(),
  scope: Type.String(),
  loadingStrategy: Type.Optional(Type.String()),
  loading: Type.Optional(SkillLoading),
  /** Absent when the body carried no frontmatter, or when `frontmatter: "ignore"`. */
  frontmatterApplied: Type.Optional(Type.Array(Type.String())),
});
export type SkillsWriteOutput = Static<typeof SkillsWriteOutput>;

export const SkillsHistoryOutput = Type.Object({
  id: Type.String(),
  versions: Type.Array(
    Type.Object({ version: Type.String(), savedAt: Type.String(), bytes: Type.Number() }),
  ),
});
export type SkillsHistoryOutput = Static<typeof SkillsHistoryOutput>;

export const SkillsRestoreOutput = Type.Object({
  id: Type.String(),
  name: Type.String(),
  scope: Type.String(),
  version: Type.String(),
});
export type SkillsRestoreOutput = Static<typeof SkillsRestoreOutput>;

export const SkillsDeleteOutput = Type.Object({
  id: Type.String(),
  name: Type.String(),
  scope: Type.String(),
});
export type SkillsDeleteOutput = Static<typeof SkillsDeleteOutput>;

/** `skills__activate` / `skills__deactivate`: a mute that holds for this conversation only. */
export const SkillsActivationOutput = Type.Object({
  name: Type.String(),
  suppressed: Type.Boolean(),
  scope: StringEnum(["conversation"] as const),
});
export type SkillsActivationOutput = Static<typeof SkillsActivationOutput>;

/**
 * `nb__use_skill` result. `loaded` delivers the skill (body rides the result's
 * `content`, not this typed envelope); `already_loaded` is the dedupe note —
 * the body is already in the conversation's context, so none is re-delivered.
 */
export const SkillsUseOutput = ObjectUnion([
  Type.Object({
    status: StringEnum(["loaded"] as const),
    name: Type.String(),
    scope: Type.String(),
    tokens: Type.Number(),
  }),
  Type.Object({ status: StringEnum(["already_loaded"] as const), name: Type.String() }),
]);
export type SkillsUseOutput = Static<typeof SkillsUseOutput>;
