/**
 * Tool-display — public API.
 *
 * Everything the UI needs to describe tool calls for display. Apps that want
 * custom per-tool rendering register at `registerToolRenderer` and otherwise
 * let the generic (Tier 0) describer do its job.
 */

export { describeBatch, describeCall } from "./describe.ts";
export type { ToolRenderer } from "./registry.ts";
export { registerToolRenderer } from "./registry.ts";
export { describeTurn, groupTurn } from "./turn.ts";
export type {
  BatchDescription,
  BatchTone,
  DisplayDetail,
  InputField,
  TimelineEntry,
  Tone,
  ToolDescription,
  TurnSummary,
} from "./types.ts";
