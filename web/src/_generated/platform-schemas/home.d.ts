import { type Static } from "@sinclair/typebox";
export declare const HomeActivityInput: import("@sinclair/typebox").TObject<{
    since: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    until: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"conversations" | "bundles" | "tools" | "errors">>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
}>;
export type HomeActivityInput = Static<typeof HomeActivityInput>;
