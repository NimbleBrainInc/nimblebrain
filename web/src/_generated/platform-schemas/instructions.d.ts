import { type Static } from "@sinclair/typebox";
export declare const InstructionsWriteInput: import("@sinclair/typebox").TObject<{
    scope: import("@sinclair/typebox").TUnsafe<"org" | "workspace">;
    body: import("@sinclair/typebox").TString;
}>;
export type InstructionsWriteInput = Static<typeof InstructionsWriteInput>;
