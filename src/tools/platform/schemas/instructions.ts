import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

export const InstructionsWriteInput = Type.Object(
  {
    scope: StringEnum(["org", "workspace"] as const, {
      description:
        "Which overlay to write. `org` applies platform-wide; `workspace` applies to the active workspace only.",
    }),
    body: Type.String({
      description: "Markdown body. Empty string clears the overlay.",
    }),
  },
  { required: ["scope", "body"] },
);
export type InstructionsWriteInput = Static<typeof InstructionsWriteInput>;
