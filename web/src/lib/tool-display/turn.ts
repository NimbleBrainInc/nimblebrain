/**
 * Turn selector — collapses one assistant turn's `blocks[]` into a single
 * activity timeline for the TurnActivityPill.
 *
 * Two invariants:
 *
 * 1. **Cross-block tool grouping.** Every call of the same (stripped) tool
 *    name within the turn merges into one `tool` entry, regardless of how
 *    reasoning interleaves between calls. The block model only coalesces
 *    *consecutive* tool calls; this selector does the rest. Without it,
 *    extended-thinking turns produce a stack of single-call entries (see
 *    Mercury repro in the redesign notes).
 *
 * 2. **First-occurrence ordering.** A tool group sits at the index of its
 *    first call; later calls of the same tool fold in without moving the
 *    group. Reasoning entries are appended at their own position, so the
 *    timeline still reads "reasoning then activity then more reasoning"
 *    truthfully.
 */

import type { ContentBlock, ToolCallDisplay } from "../../hooks/useChat.ts";
import { stripServerPrefix } from "../format.ts";
import { describeCall } from "./describe.ts";
import type { TimelineEntry, TurnSummary } from "./types.ts";
import { dominantVerb, PRESENT_TENSE } from "./verbs.ts";

/**
 * Walk `blocks[]` and produce the turn's timeline. Text blocks render in the
 * message body (not here); only `reasoning` and `tool` blocks contribute.
 */
export function groupTurn(blocks: ReadonlyArray<ContentBlock>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  // (mutable) tool-group buckets keyed by stripped name. We push placeholder
  // entries into `entries` and accumulate calls into these arrays by reference.
  const buckets = new Map<string, ToolCallDisplay[]>();

  for (const block of blocks) {
    if (block.type === "reasoning") {
      if (block.text.length === 0) continue;
      entries.push({ kind: "reasoning", text: block.text });
    } else if (block.type === "tool") {
      for (const call of block.toolCalls) {
        const key = stripServerPrefix(call.name);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.push(call);
        } else {
          const fresh: ToolCallDisplay[] = [call];
          buckets.set(key, fresh);
          entries.push({ kind: "tool", name: key, calls: fresh });
        }
      }
    }
    // type === "text" — message body, not timeline.
  }

  return entries;
}

/**
 * Summarize the turn for the pill's L1 head. Pure derivation from the
 * timeline; the pill component combines this with `streamingState` to pick
 * the running-vs-done label.
 */
export function describeTurn(entries: ReadonlyArray<TimelineEntry>): TurnSummary {
  const allCalls = entries.flatMap((e) => (e.kind === "tool" ? [...e.calls] : []));
  const descriptions = allCalls.map(describeCall);

  const verbPast = descriptions.length > 0 ? dominantVerb(descriptions.map((d) => d.verb)) : "Ran";
  const verbPresent = PRESENT_TENSE[verbPast] ?? verbPast;

  // Top subject: first non-null headSubject from a call whose verb matches the
  // dominant verb. Falls back to any non-null headSubject. Null when calls
  // span multiple subjects or have none — better to omit than mislead.
  let topSubject: string | null = null;
  for (const d of descriptions) {
    if (d.verb === verbPast && d.headSubject) {
      topSubject = d.headSubject;
      break;
    }
  }
  if (!topSubject) {
    for (const d of descriptions) {
      if (d.headSubject) {
        topSubject = d.headSubject;
        break;
      }
    }
  }

  let totalMs: number | null = null;
  for (const d of descriptions) {
    if (typeof d.durationMs === "number") {
      totalMs = (totalMs ?? 0) + d.durationMs;
    }
  }

  const running = descriptions.some((d) => d.tone === "running");

  return {
    dominantVerb: verbPast,
    dominantVerbPresent: verbPresent,
    topSubject,
    totalCalls: descriptions.length,
    totalMs,
    running,
  };
}
