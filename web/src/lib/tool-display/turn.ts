/**
 * Turn selectors — derive display structure from one assistant turn's
 * `blocks[]`.
 *
 * Two levels:
 *
 * - `segmentTurn` partitions the turn into chronological slices for the
 *   message body. Text blocks become their own slices; consecutive runs of
 *   reasoning/tool blocks between text slices become `activity` slices. The
 *   body renders each slice in order so pills appear next to the work they
 *   represent instead of hoisting to the top.
 *
 * - `groupTurn` collapses one slice's reasoning + tool blocks into a single
 *   activity timeline for the TurnActivityPill. Two invariants:
 *
 *   1. **Cross-block tool grouping (within a slice).** Every call of the
 *      same tool name in the slice merges into one `tool` entry, regardless
 *      of how reasoning interleaves between calls. Without it, extended-
 *      thinking phases produce a stack of single-call entries (see Mercury
 *      repro in the redesign notes). Grouping does not cross text
 *      boundaries — that's the segmenter's job.
 *
 *   2. **First-occurrence ordering.** A tool group sits at the index of its
 *      first call; later calls of the same tool fold in without moving the
 *      group. Reasoning entries are appended at their own position, so the
 *      timeline still reads "reasoning then activity then more reasoning"
 *      truthfully.
 */

import type { ContentBlock, ToolCallDisplay } from "../../hooks/useChat.ts";
import { stripServerPrefix } from "../format.ts";
import { describeCall } from "./describe.ts";
import type { TimelineEntry, TurnSegment, TurnSummary } from "./types.ts";
import { dominantVerb, PRESENT_TENSE } from "./verbs.ts";

/**
 * Partition a turn into chronological slices for message-body rendering.
 * Text blocks become their own slices; consecutive non-text blocks
 * (`reasoning` + `tool`) coalesce into one `activity` slice.
 *
 * Empty text blocks (zero-length `text`) are dropped — they're streaming
 * artifacts and would render as empty paragraphs. Activity slices are kept
 * even when they contain only zero-length reasoning blocks; downstream
 * (`groupTurn` + visibility gate) decides whether to render them.
 */
export function segmentTurn(blocks: ReadonlyArray<ContentBlock>): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let buffer: ContentBlock[] = [];

  const flushActivity = () => {
    if (buffer.length === 0) return;
    segments.push({ kind: "activity", blocks: buffer });
    buffer = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      flushActivity();
      if (block.text.length > 0) {
        segments.push({ kind: "text", text: block.text });
      }
    } else {
      buffer.push(block);
    }
  }
  flushActivity();

  return segments;
}

/**
 * Walk `blocks[]` and produce the turn's timeline. Text blocks render in the
 * message body (not here); only `reasoning` and `tool` blocks contribute.
 *
 * Buckets by full (prefixed) tool name, not the stripped form — two servers
 * that each expose a `search` tool produce two distinct rows. The display
 * uses the stripped form, so the user still sees "Searched ×N" per server
 * group without the wire-name clutter.
 */
export function groupTurn(blocks: ReadonlyArray<ContentBlock>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  // (mutable) tool-group buckets keyed by *full* tool name. We push placeholder
  // entries into `entries` and accumulate calls into these arrays by reference.
  const buckets = new Map<string, ToolCallDisplay[]>();

  for (const block of blocks) {
    if (block.type === "reasoning") {
      if (block.text.length === 0) continue;
      entries.push({ kind: "reasoning", text: block.text });
    } else if (block.type === "tool") {
      for (const call of block.toolCalls) {
        const bucketKey = call.name;
        const bucket = buckets.get(bucketKey);
        if (bucket) {
          bucket.push(call);
        } else {
          const fresh: ToolCallDisplay[] = [call];
          buckets.set(bucketKey, fresh);
          entries.push({ kind: "tool", name: stripServerPrefix(call.name), calls: fresh });
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
