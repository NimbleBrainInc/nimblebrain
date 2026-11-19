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
        "The exact name of one of the person's own plugins that nb__search lists as not turned on in this workspace. Call this whenever the task needs that plugin, instead of sending the person to the Plugins page: it shows them a one-click **Use here** in the chat. Send it alone, without `add` or `remove`. It turns nothing on, so end your turn after it: their answer arrives as their next message.",
    }),
  ),
});
export type ManageToolsInput = Static<typeof ManageToolsInput>;
