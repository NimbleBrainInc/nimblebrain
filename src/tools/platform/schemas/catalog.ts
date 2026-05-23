import type { Static, TSchema } from "@sinclair/typebox";
import * as Automations from "./automations.ts";
import * as Compose from "./compose.ts";
import * as Conversations from "./conversations.ts";
import * as Files from "./files.ts";
import * as Home from "./home.ts";
import * as Instructions from "./instructions.ts";
import * as ManageTools from "./manage-tools.ts";
import * as Skills from "./skills.ts";
import * as Usage from "./usage.ts";

// Registry mapping (source, tool) → input schema. The web client and any
// other typed caller reads this catalog to derive `callTool` argument
// types end-to-end. New sources / tools added here automatically gain
// compile-time enforcement at every call site.
export const PlatformToolCatalog = {
  nb: {
    manage_tools: { input: ManageTools.ManageToolsInput },
  },
  skills: {
    list: { input: Skills.SkillsListInput },
    read: { input: Skills.SkillsReadInput },
    active_for: { input: Skills.SkillsActiveForInput },
    loading_log: { input: Skills.SkillsLoadingLogInput },
    create: { input: Skills.SkillsCreateInput },
    update: { input: Skills.SkillsUpdateInput },
    delete: { input: Skills.SkillsDeleteInput },
    activate: { input: Skills.SkillsActivateInput },
    deactivate: { input: Skills.SkillsDeactivateInput },
    move_scope: { input: Skills.SkillsMoveScopeInput },
  },
  home: {
    activity: { input: Home.HomeActivityInput },
  },
  usage: {
    report: { input: Usage.UsageReportInput },
  },
  instructions: {
    write_instructions: { input: Instructions.InstructionsWriteInput },
  },
  compose: {
    effective_context: { input: Compose.ComposeEffectiveContextInput },
  },
  automations: {
    create: { input: Automations.AutomationsCreateInput },
    update: { input: Automations.AutomationsUpdateInput },
    delete: { input: Automations.AutomationsDeleteInput },
    list: { input: Automations.AutomationsListInput },
    status: { input: Automations.AutomationsStatusInput },
    runs: { input: Automations.AutomationsRunsInput },
    run: { input: Automations.AutomationsRunInput },
    cancel: { input: Automations.AutomationsCancelInput },
  },
  conversations: {
    list: { input: Conversations.ConversationsListInput },
    get: { input: Conversations.ConversationsGetInput },
    search: { input: Conversations.ConversationsSearchInput },
    update: { input: Conversations.ConversationsUpdateInput },
    fork: { input: Conversations.ConversationsForkInput },
    stats: { input: Conversations.ConversationsStatsInput },
    export: { input: Conversations.ConversationsExportInput },
  },
  files: {
    list: { input: Files.FilesListInput },
    search: { input: Files.FilesSearchInput },
    read: { input: Files.FilesReadInput },
    create: { input: Files.FilesCreateInput },
    info: { input: Files.FilesInfoInput },
    tag: { input: Files.FilesTagInput },
    delete: { input: Files.FilesDeleteInput },
  },
} as const satisfies Record<string, Record<string, { input: TSchema }>>;

export type PlatformToolCatalog = typeof PlatformToolCatalog;
export type ToolSource = keyof PlatformToolCatalog;
export type ToolName<S extends ToolSource> = keyof PlatformToolCatalog[S];

// Shape of args for a (source, tool) pair. When the pair is in the catalog,
// the args type is the schema's static type. When the pair is not yet
// migrated, falls through to `Record<string, unknown>` so existing
// untyped callers continue to compile while we migrate sources one by one.
export type ToolInput<S extends string, T extends string> = S extends ToolSource
  ? T extends ToolName<S>
    ? PlatformToolCatalog[S][T] extends { input: infer Sch }
      ? Sch extends TSchema
        ? Static<Sch>
        : Record<string, unknown>
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;
