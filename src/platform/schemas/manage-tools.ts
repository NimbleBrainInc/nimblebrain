import { type Static, Type } from "@sinclair/typebox";

const ToolNameField = Type.String({
  description:
    "Fully qualified tool name in source__tool format (e.g., synapse-crm__create_contact).",
});

export const ManageToolsInput = Type.Object({
  add: Type.Optional(
    Type.Array(ToolNameField, {
      description:
        "Tool names to promote into the active tool list. Each becomes callable on the next turn. List only tools you intend to call — a promoted tool you never use costs its schema on the turns that follow.",
    }),
  ),
  remove: Type.Optional(
    Type.Array(ToolNameField, {
      description:
        "Tool names to release from the active tool list. System tools (nb__*) cannot be released.",
    }),
  ),
  request_plugin: Type.Optional(
    Type.String({
      description:
        "Ask the person to turn on one of their own plugins in this workspace: the name nb__search lists under their plugins not turned on here. Send it alone, without `add` or `remove`. It turns nothing on: the person answers in the chat, and their answer arrives as their next message.",
    }),
  ),
});
export type ManageToolsInput = Static<typeof ManageToolsInput>;
