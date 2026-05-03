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
import { type Static } from "@sinclair/typebox";
export declare const AutomationsCreateInput: import("@sinclair/typebox").TObject<{
    manifest: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        schedule: import("@sinclair/typebox").TObject<{
            type: import("@sinclair/typebox").TUnsafe<"cron" | "interval">;
            expression: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            timezone: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            intervalMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        }>;
        enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        skill: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        maxIterations: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        maxInputTokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        maxRunDurationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        tokenBudget: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            maxInputTokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            maxOutputTokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            period: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"daily" | "monthly">>;
        }>>;
    }>;
    body: import("@sinclair/typebox").TString;
}>;
export type AutomationsCreateInput = Static<typeof AutomationsCreateInput>;
export declare const AutomationsUpdateInput: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
    manifest: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        schedule: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            type: import("@sinclair/typebox").TUnsafe<"cron" | "interval">;
            expression: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            timezone: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            intervalMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        }>>;
        enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        skill: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        maxIterations: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        maxInputTokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        maxRunDurationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        tokenBudget: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            maxInputTokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            maxOutputTokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            period: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"daily" | "monthly">>;
        }>>;
    }>>;
    body: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type AutomationsUpdateInput = Static<typeof AutomationsUpdateInput>;
export declare const AutomationsDeleteInput: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
}>;
export type AutomationsDeleteInput = Static<typeof AutomationsDeleteInput>;
export declare const AutomationsListInput: import("@sinclair/typebox").TObject<{
    enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    source: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"user" | "agent" | "bundle">>;
}>;
export type AutomationsListInput = Static<typeof AutomationsListInput>;
export declare const AutomationsStatusInput: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type AutomationsStatusInput = Static<typeof AutomationsStatusInput>;
export declare const AutomationsRunsInput: import("@sinclair/typebox").TObject<{
    automationId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"running" | "success" | "failure" | "timeout" | "cancelled" | "skipped">>;
    since: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type AutomationsRunsInput = Static<typeof AutomationsRunsInput>;
export declare const AutomationsRunInput: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
}>;
export type AutomationsRunInput = Static<typeof AutomationsRunInput>;
export declare const AutomationsCancelInput: import("@sinclair/typebox").TObject<{
    name: import("@sinclair/typebox").TString;
}>;
export type AutomationsCancelInput = Static<typeof AutomationsCancelInput>;
