import { type Static, Type } from "@sinclair/typebox";

export const ComposeEffectiveContextInput = Type.Object({
  conversation_id: Type.Optional(
    Type.String({
      description:
        "Conversation id whose prompt is being inspected. Optional inside " +
        "a chat — defaults to the current conversation.",
    }),
  ),
  run_id: Type.Optional(
    Type.String({
      description:
        "Specific past run within the conversation. Triggers historical " +
        "mode (reads `context.assembled` + `skills.loaded` events; verifies " +
        "layer-3 skill content hashes). Default: live mode (current state).",
    }),
  ),
  bundle: Type.Optional(
    Type.String({
      description:
        "Filter the response to one bundle's contributions (apps section " +
        "row + layer-3 skills under the bundle's affined directory).",
    }),
  ),
});
export type ComposeEffectiveContextInput = Static<typeof ComposeEffectiveContextInput>;
