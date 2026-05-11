import { type Static, Type } from "@sinclair/typebox";

const ToolNameField = Type.String({
  description:
    "Fully qualified tool name to add to or remove from the current run's direct tool list.",
  pattern: "^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$",
});

export const UseToolInput = Type.Object(
  {
    tool_name: ToolNameField,
  },
  { required: ["tool_name"] },
);
export type UseToolInput = Static<typeof UseToolInput>;

export const ReleaseToolInput = Type.Object(
  {
    tool_name: ToolNameField,
  },
  { required: ["tool_name"] },
);
export type ReleaseToolInput = Static<typeof ReleaseToolInput>;
