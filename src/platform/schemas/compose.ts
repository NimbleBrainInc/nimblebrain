import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

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
  connector: Type.Optional(
    Type.String({
      description:
        "Filter the response to that connector's contributions (in live " +
        "mode, its app entry; in historical mode, the skills it published " +
        "that loaded in the run).",
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

// ── Output schemas (mirrored to web via codegen) ───────────────────────────

/**
 * One row of a run's assembled context, as recorded in the
 * `context.assembled` event. `kind` is a free-form source discriminator
 * (`system_prompt`, `tool_descriptions`, `skills`, `history`); the other
 * fields are populated per kind (`count` for tools/skills, `messages` /
 * `compacted` for history).
 *
 * The rows are NOT four disjoint regions of the context window: `skills`
 * annotates how much of `system_prompt` the composed skill bodies account
 * for. The window is `system_prompt + tool_descriptions + history`, which is
 * why `ComposeAssembledContextOutput.totalTokens` (the recorded sum of all
 * four) is larger than what a reader would call the context size. Read
 * `windowTokens` instead of re-deriving it.
 *
 * "Inside `system_prompt`" is true of the prompt as measured, which is what
 * these rows describe: telemetry is built from the assembled prompt, before
 * `resolveEngineSystem` evicts the volatile head onto the last user message.
 * So a trigger-matched skill counts here but ships to the model on the message
 * stream. The arithmetic is unaffected (history tokens are counted pre-evict,
 * so nothing is billed twice); only the row it is attributed to is coarser
 * than the wire.
 */
export const AssembledContextSource = Type.Object({
  kind: Type.String(),
  tokens: Type.Number(),
  count: Type.Optional(Type.Number()),
  /** `history`: how many messages the windowed history holds. */
  messages: Type.Optional(Type.Number()),
  compacted: Type.Optional(Type.Boolean()),
  /**
   * True when this row measures part of another row rather than adding a
   * region of its own — `skills` inside `system_prompt` today.
   *
   * Stamped here so a renderer can lay the rows out without carrying its own
   * copy of which kinds are annotations. Without it, a kind added on one tier
   * only would draw a region row whose tokens are absent from the
   * `windowTokens` printed beneath it.
   */
  annotation: Type.Optional(Type.Boolean()),
});
export type AssembledContextSource = Static<typeof AssembledContextSource>;

/**
 * One skill that loaded for the run, projected from the `skills.loaded` event
 * with provenance for why it loaded.
 *
 * `scope` is the storage tier as recorded, and a recorded event keeps the
 * vocabulary it was written in: today's runs record `org`, `workspace`, `user`,
 * or `provided`, and an older run can hold a tier name this build no longer
 * uses. So it is an open string, and a renderer falls back to the stored value
 * for a tier it does not know.
 */
export const AssembledContextSkill = Type.Object({
  id: Type.String(),
  /** The skill's own name — resolved server-side, safe to render directly. */
  name: Type.String(),
  /** The MCP server that published it; absent for filesystem skills. */
  connector: Type.Optional(Type.String()),
  scope: Type.String(),
  tokens: Type.Number(),
  /** The loading mechanism: always-on context, tool-affinity, trigger match, or named by the task. */
  loadedBy: StringEnum(["always", "tool_affinity", "trigger", "task"] as const),
  reason: Type.String(),
});
export type AssembledContextSkill = Static<typeof AssembledContextSkill>;

/**
 * `compose__assembled_context` response — the recorded context digest for
 * a conversation's run (the most recent by default). A pure read of the
 * run's already-emitted `context.assembled` + `skills.loaded` events; no
 * recomposition. `runId` / `ts` are `null` when the conversation exists but
 * no run has recorded assembled-context telemetry yet.
 */
export const ComposeAssembledContextOutput = Type.Object({
  conversationId: Type.String(),
  runId: Type.Union([Type.String(), Type.Null()]),
  ts: Type.Union([Type.String(), Type.Null()]),
  sources: Type.Array(AssembledContextSource),
  excluded: Type.Array(AssembledContextSource),
  /**
   * The recorded sum of every row in `sources`, preserved as recorded. It
   * counts the composed skill bodies twice — once inside `system_prompt`, once
   * in the `skills` annotation — so it is NOT the size of the context window.
   * Read `windowTokens` for that.
   */
  totalTokens: Type.Number(),
  /**
   * How much of the context window the turn occupied: the sum of the rows that
   * name a region, with the annotation rows left out. The number a reader means
   * by "how big was this turn". Computed here rather than by each caller, so
   * one answer reaches every consumer of this tool.
   */
  windowTokens: Type.Number(),
  skills: Type.Array(AssembledContextSkill),
  /** Present only when the run recorded them (not emitted on current runs). */
  modelMaxContext: Type.Optional(Type.Number()),
  headroomTokens: Type.Optional(Type.Number()),
});
export type ComposeAssembledContextOutput = Static<typeof ComposeAssembledContextOutput>;

/**
 * One entry of a section that aggregates several items (`apps`, the skills
 * layer): the runtime `TracedSubItem`. `metadata` is free-form per kind (a
 * skill's scope and hash status, an app's UI descriptor). The `connector`
 * filter matches on `connector`.
 */
export const TracedSubItemView = Type.Object({
  kind: Type.String(),
  id: Type.String(),
  source: Type.String(),
  connector: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type TracedSubItemView = Static<typeof TracedSubItemView>;

/**
 * One section of the composed system prompt with provenance and body — the
 * projection of the runtime `TracedLayer`. Carries `text` (the exact composed
 * body of the layer) so the context inspector can show what actually entered
 * the window. Lighter consumers may ignore `text`; it is the largest field and
 * only the inspector renders it. `subItems` is the per-app / per-skill
 * breakdown the server-side `connector` filter runs on; the inspector renders
 * each layer's composed `text` instead.
 */
export const TracedLayerView = Type.Object({
  kind: Type.String(),
  segment: StringEnum(["stable", "volatile"] as const),
  id: Type.String(),
  source: Type.String(),
  tokens: Type.Number(),
  text: Type.String(),
  connector: Type.Optional(Type.String()),
  subItems: Type.Optional(Type.Array(TracedSubItemView)),
});
export type TracedLayerView = Static<typeof TracedLayerView>;

/**
 * `compose__effective_context` response. `text` is the whole composed prompt
 * in live mode, and in historical mode the reconstructed skills layer under a
 * banner saying it is a partial; the inspector reads each layer's `text`
 * instead. `runId` is present in historical mode.
 *
 * `totalTokens` is not the size of the context window, which also holds tool
 * descriptions and history: `compose__assembled_context` answers that, as
 * `windowTokens`.
 */
export const ComposeEffectiveContextOutput = Type.Object({
  mode: StringEnum(["live", "historical"] as const),
  conversationId: Type.String(),
  runId: Type.Optional(Type.String()),
  /**
   * Size of the composed system prompt, the same quantity in both modes so the
   * two are comparable: live sums the composed layers, historical reads the
   * run's recorded `system_prompt` row.
   */
  totalTokens: Type.Number(),
  text: Type.String(),
  layers: Type.Array(TracedLayerView),
  warnings: Type.Array(Type.String()),
});
export type ComposeEffectiveContextOutput = Static<typeof ComposeEffectiveContextOutput>;
