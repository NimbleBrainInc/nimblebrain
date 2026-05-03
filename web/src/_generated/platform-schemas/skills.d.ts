import { type Static } from "@sinclair/typebox";
export declare const SkillsListInput: import("@sinclair/typebox").TObject<{
    scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"user" | "bundle" | "org" | "workspace">>;
    layer: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<3 | 1>>;
    type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    tool_affinity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"active" | "draft" | "disabled" | "archived">>;
    modified_since: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type SkillsListInput = Static<typeof SkillsListInput>;
export declare const SkillsReadInput: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>;
export type SkillsReadInput = Static<typeof SkillsReadInput>;
export declare const SkillsActiveForInput: import("@sinclair/typebox").TObject<{
    conversation_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type SkillsActiveForInput = Static<typeof SkillsActiveForInput>;
export declare const SkillsLoadingLogInput: import("@sinclair/typebox").TObject<{
    conversation_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    skill_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    since: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    until: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type SkillsLoadingLogInput = Static<typeof SkillsLoadingLogInput>;
export declare const SkillsCreateInput: import("@sinclair/typebox").TObject<{
    scope: import("@sinclair/typebox").TUnsafe<"user" | "org" | "workspace">;
    manifest: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        description: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TUnsafe<"skill" | "context">;
        priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"active" | "draft" | "disabled" | "archived">>;
        version: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        metadata: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            keywords: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            triggers: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        }>>;
    }>;
    body: import("@sinclair/typebox").TString;
}>;
export type SkillsCreateInput = Static<typeof SkillsCreateInput>;
export declare const SkillsUpdateInput: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    manifest: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"skill" | "context">>;
        priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"active" | "draft" | "disabled" | "archived">>;
        version: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        metadata: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            keywords: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            triggers: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        }>>;
    }>>;
    body: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type SkillsUpdateInput = Static<typeof SkillsUpdateInput>;
export declare const SkillsDeleteInput: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>;
export type SkillsDeleteInput = Static<typeof SkillsDeleteInput>;
export declare const SkillsActivateInput: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>;
export type SkillsActivateInput = Static<typeof SkillsActivateInput>;
export declare const SkillsDeactivateInput: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
}>;
export type SkillsDeactivateInput = Static<typeof SkillsDeactivateInput>;
export declare const SkillsMoveScopeInput: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    target_scope: import("@sinclair/typebox").TUnsafe<"user" | "org" | "workspace">;
}>;
export type SkillsMoveScopeInput = Static<typeof SkillsMoveScopeInput>;
