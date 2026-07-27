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
export interface AssembledContextSource {
  kind: string;
  tokens: number;
  count?: number;
  /** `history`: how many messages the windowed history holds. */
  messages?: number;
  compacted?: boolean;
  /**
   * True when this row measures part of another row rather than adding a
   * region of its own — `skills` inside `system_prompt` today.
   *
   * Stamped here so a renderer can lay the rows out without carrying its own
   * copy of which kinds are annotations. Without it, a kind added on one tier
   * only would draw a region row whose tokens are absent from the
   * `windowTokens` printed beneath it.
   */
  annotation?: boolean;
}

/**
 * One layer-3 skill that loaded for the run, projected from the
 * `skills.loaded` event with provenance for why it loaded.
 */
export interface AssembledContextSkill {
  id: string;
  /** The skill's own name — resolved server-side, safe to render directly. */
  name: string;
  /** The MCP server that published it; absent for filesystem skills. */
  connector?: string;
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
  /**
   * The recorded sum of every row in `sources`, preserved as recorded. It
   * counts the composed skill bodies twice — once inside `system_prompt`, once
   * in the `skills` annotation — so it is NOT the size of the context window.
   * Read `windowTokens` for that.
   */
  totalTokens: number;
  /**
   * How much of the context window the turn occupied: the sum of the rows that
   * name a region, with the annotation rows left out. The number a reader means
   * by "how big was this turn". Computed here rather than by each caller, so
   * one answer reaches every consumer of this tool.
   */
  windowTokens: number;
  skills: AssembledContextSkill[];
  /** Present only when the run recorded them (not emitted on current runs). */
  modelMaxContext?: number;
  headroomTokens?: number;
}

/**
 * One section of the composed system prompt with provenance and body — the
 * web-facing projection of the runtime `TracedLayer`. Carries `text` (the
 * exact composed body of the layer) so the context inspector can show what
 * actually entered the window. Lighter consumers may ignore `text`; it is the
 * largest field and only the inspector renders it. The runtime `subItems`
 * (per-app / per-skill breakdown) are omitted: they exist for the server-side
 * `bundle` filter, which runs on the runtime `TracedLayer`, and the inspector
 * renders each layer's composed `text`, not its sub-items.
 */
export interface TracedLayerView {
  kind: string;
  segment: "stable" | "volatile";
  id: string;
  source: string;
  tokens: number;
  text: string;
  bundle?: string;
}

/**
 * `compose__effective_context` response as consumed by the context inspector.
 * The runtime tool also returns the full composed `text` at the top level;
 * that field is intentionally absent here — the inspector reads each layer's
 * `text` and never the whole-prompt blob.
 */
export interface ComposeEffectiveContextOutput {
  mode: "live" | "historical";
  conversationId: string;
  totalTokens: number;
  layers: TracedLayerView[];
  warnings: string[];
}
