import { type Static } from "@sinclair/typebox";
export declare const UsageReportInput: import("@sinclair/typebox").TObject<{
    period: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"day" | "week" | "month" | "all">>;
    from: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    groupBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<"model" | "day" | "conversation">>;
}>;
export type UsageReportInput = Static<typeof UsageReportInput>;
