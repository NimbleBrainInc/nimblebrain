import { type Static, Type } from "@sinclair/typebox";

export const InstructionsWriteInput = Type.Object(
  {
    body: Type.String({
      description: "Markdown body. Empty string clears the overlay.",
    }),
  },
  { required: ["body"] },
);
export type InstructionsWriteInput = Static<typeof InstructionsWriteInput>;
