/**
 * Tool input schemas for the automations source. Imported by both the
 * platform in-process source (`src/tools/platform/automations.ts`) and the
 * standalone bundle server (`src/bundles/automations/src/server.ts`) so
 * the two consumers always agree on the wire shape.
 *
 * Shape convention (per src/tools/platform/CLAUDE.md §1.3):
 *
 *   create: { manifest: { ...config }, body: <prompt> }
 *   update: { name, manifest?: Partial<config>, body?: <new prompt> }
 *
 * `manifest` is the persistent automation definition; `body` is the prompt
 * sent to POST /v1/chat on each run — the analog of a skill's markdown
 * body. Operator-only fields (`source`, `bundleName`) are intentionally
 * absent from the LLM-facing schema; they live on the stored type and are
 * set by the runtime, never by an authoring caller.
 */

import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

// ── Shared sub-schemas ───────────────────────────────────────────────────

const Schedule = Type.Object(
  {
    type: StringEnum(["cron", "interval"] as const),
    expression: Type.Optional(
      Type.String({ description: "5-field cron expression (when type=cron)." }),
    ),
    timezone: Type.Optional(
      Type.String({ description: "IANA timezone. Default: system timezone." }),
    ),
    intervalMs: Type.Optional(
      Type.Number({
        minimum: 60000,
        description: "Interval in ms (when type=interval). Min 60000.",
      }),
    ),
  },
  { required: ["type"] },
);

const TokenBudget = Type.Object({
  maxInputTokens: Type.Optional(Type.Number()),
  maxOutputTokens: Type.Optional(Type.Number()),
  period: Type.Optional(StringEnum(["daily", "monthly"] as const)),
});

// Manifest fields shared by create + update. `name` is required for create
// (rebuilt with explicit required); update uses the same fields minus name
// (renames are not patchable; the kebab-case id would drift).
const ManifestFields = {
  name: Type.String({ description: "Human-readable name. Becomes the kebab-case id." }),
  description: Type.Optional(Type.String({ description: "What this automation does." })),
  schedule: Schedule,
  enabled: Type.Optional(
    Type.Boolean({ description: "Whether the automation runs. Default true." }),
  ),
  skill: Type.Optional(
    Type.String({
      description: "Force a specific skill match for this automation's runs.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override. Omit to use the workspace default." }),
  ),
  maxIterations: Type.Optional(
    Type.Number({ description: "Max LLM iterations per run. Default 5, hard cap 15." }),
  ),
  maxInputTokens: Type.Optional(
    Type.Number({ description: "Max input tokens per run. Default 200000." }),
  ),
  maxRunDurationMs: Type.Optional(
    Type.Number({ description: "Max wall-clock per run (ms). Default 120000." }),
  ),
  tokenBudget: Type.Optional(TokenBudget),
};

// Update is a partial of the create-shape minus `name`. All fields except
// schedule become optional; schedule is partial-by-omission since it's
// already the only required field of the create-manifest beyond name.
const UpdateManifestFields = {
  description: ManifestFields.description,
  schedule: Type.Optional(Schedule),
  enabled: ManifestFields.enabled,
  skill: ManifestFields.skill,
  model: ManifestFields.model,
  maxIterations: ManifestFields.maxIterations,
  maxInputTokens: ManifestFields.maxInputTokens,
  maxRunDurationMs: ManifestFields.maxRunDurationMs,
  tokenBudget: ManifestFields.tokenBudget,
};

// ── Tool input schemas ───────────────────────────────────────────────────

export const AutomationsCreateInput = Type.Object(
  {
    manifest: Type.Object(ManifestFields, {
      required: ["name", "schedule"],
      description: "Automation definition: identity, schedule, run-time policy.",
    }),
    body: Type.String({ description: "The prompt sent on each scheduled run." }),
  },
  { required: ["manifest", "body"] },
);
export type AutomationsCreateInput = Static<typeof AutomationsCreateInput>;

export const AutomationsUpdateInput = Type.Object(
  {
    name: Type.String({ description: "Name of the automation to update." }),
    manifest: Type.Optional(
      Type.Object(UpdateManifestFields, {
        description: "Partial manifest patch. Omitted fields keep their current values.",
      }),
    ),
    body: Type.Optional(
      Type.String({ description: "New prompt. Omit to keep the current prompt." }),
    ),
  },
  { required: ["name"] },
);
export type AutomationsUpdateInput = Static<typeof AutomationsUpdateInput>;

export const AutomationsDeleteInput = Type.Object(
  { name: Type.String({ description: "Name of the automation to delete." }) },
  { required: ["name"] },
);
export type AutomationsDeleteInput = Static<typeof AutomationsDeleteInput>;

export const AutomationsListInput = Type.Object({
  enabled: Type.Optional(Type.Boolean({ description: "Filter by enabled status." })),
  source: Type.Optional(
    StringEnum(["user", "agent", "bundle"] as const, { description: "Filter by source." }),
  ),
});
export type AutomationsListInput = Static<typeof AutomationsListInput>;

export const AutomationsStatusInput = Type.Object(
  {
    name: Type.String({ description: "Name of the automation." }),
    limit: Type.Optional(Type.Number({ description: "Max recent runs to include. Default: 5." })),
  },
  { required: ["name"] },
);
export type AutomationsStatusInput = Static<typeof AutomationsStatusInput>;

export const AutomationsRunsInput = Type.Object({
  automationId: Type.Optional(Type.String({ description: "Filter by automation ID." })),
  status: Type.Optional(
    StringEnum(["running", "success", "failure", "timeout", "cancelled", "skipped"] as const, {
      description: "Filter by run status.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "ISO timestamp — only runs started on or after this time.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max runs to return. Default: 20." })),
});
export type AutomationsRunsInput = Static<typeof AutomationsRunsInput>;

export const AutomationsRunInput = Type.Object(
  { name: Type.String({ description: "Name of the automation to run." }) },
  { required: ["name"] },
);
export type AutomationsRunInput = Static<typeof AutomationsRunInput>;

export const AutomationsCancelInput = Type.Object(
  { name: Type.String({ description: "Name of the automation to cancel." }) },
  { required: ["name"] },
);
export type AutomationsCancelInput = Static<typeof AutomationsCancelInput>;
