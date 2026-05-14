import { type Static, Type } from "@sinclair/typebox";

const ToolNameField = Type.String({
  description:
    "Fully qualified tool name in source__tool format (e.g., synapse-crm__create_contact).",
});

export const ManageToolsInput = Type.Object({
  add: Type.Optional(
    Type.Array(ToolNameField, {
      description:
        "Tool names to promote into the active tool list. Each becomes callable on the next turn.",
    }),
  ),
  remove: Type.Optional(
    Type.Array(ToolNameField, {
      description:
        "Tool names to release from the active tool list. System tools (nb__*) cannot be released.",
    }),
  ),
});
export type ManageToolsInput = Static<typeof ManageToolsInput>;
