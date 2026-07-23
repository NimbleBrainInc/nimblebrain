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

export const ComposeAssembledContextInput = Type.Object({
  conversation_id: Type.Optional(
    Type.String({
      description:
        "Conversation id whose assembled context is being inspected. " +
        "Optional inside a chat — defaults to the current conversation.",
    }),
  ),
  run_id: Type.Optional(
    Type.String({
      description:
        "Specific run within the conversation. Default: the most recent run " +
        "that recorded assembled-context telemetry.",
    }),
  ),
});
export type ComposeAssembledContextInput = Static<typeof ComposeAssembledContextInput>;

// ── Output shapes (mirrored to web via codegen) ────────────────────────────

/**
 * One row of a run's assembled context, as recorded in the
 * `context.assembled` event. `kind` is a free-form source discriminator
 * (`system_prompt`, `tool_descriptions`, `skills`, `history`); the other
 * fields are populated per kind (`count` for tools/skills, `turns` /
 * `compacted` for history).
 */
export interface AssembledContextSource {
  kind: string;
  tokens: number;
  count?: number;
  turns?: number;
  compacted?: boolean;
}

/**
 * One layer-3 skill that loaded for the run, projected from the
 * `skills.loaded` event with provenance for why it loaded.
 */
export interface AssembledContextSkill {
  id: string;
  scope: "org" | "workspace" | "user" | "bundle";
  tokens: number;
  /** The loading mechanism: always-on context, tool-affinity, or trigger match. */
  loadedBy: "always" | "tool_affinity" | "trigger";
  reason: string;
}

/**
 * `compose__assembled_context` response — the recorded context digest for
 * a conversation's run (the most recent by default). A pure read of the
 * run's already-emitted `context.assembled` + `skills.loaded` events; no
 * recomposition. `runId` / `ts` are `null` when the conversation exists but
 * no run has recorded assembled-context telemetry yet.
 */
export interface ComposeAssembledContextOutput {
  conversationId: string;
  runId: string | null;
  ts: string | null;
  sources: AssembledContextSource[];
  excluded: AssembledContextSource[];
  totalTokens: number;
  skills: AssembledContextSkill[];
  /** Present only when the run recorded them (not emitted on current runs). */
  modelMaxContext?: number;
  headroomTokens?: number;
}
