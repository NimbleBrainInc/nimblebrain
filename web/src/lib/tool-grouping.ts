import type { ToolCallDisplay } from "../hooks/useChat";
import { stripServerPrefix } from "./format";

export const GROUP_THRESHOLD = 3;

/** A contiguous slice of tool calls that renders as one unit in the chat. */
export type RenderUnit =
  | { kind: "single"; call: ToolCallDisplay; index: number }
  | {
      kind: "homogeneous";
      calls: ToolCallDisplay[];
      indexes: number[];
      /** Stripped tool name, shared by every call in the group. */
      name: string;
    }
  | {
      kind: "mixed";
      calls: ToolCallDisplay[];
      indexes: number[];
      /** Distinct stripped tool names present in the group, in first-seen order. */
      uniqueNames: string[];
    };

/**
 * Partition a batch of tool calls into render units.
 *
 * Rules:
 * 1. Scan left-to-right for runs of consecutive same-name calls.
 *    A run of length >= GROUP_THRESHOLD becomes a homogeneous group.
 * 2. After that pass, any remaining contiguous stretch of singles of length
 *    >= GROUP_THRESHOLD is coalesced into a single mixed group (so e.g. six
 *    alternating tool names collapse into one "6 tool calls" card instead of
 *    leaking six individual cards into the message stream).
 * 3. Everything else stays as individual singles.
 *
 * Order is preserved. Each original tool call appears exactly once across the
 * returned units.
 */
export function partitionToolCalls(toolCalls: ToolCallDisplay[]): RenderUnit[] {
  if (toolCalls.length === 0) return [];

  // Pass 1: detect homogeneous runs, emit singles for anything below threshold.
  const pass1: RenderUnit[] = [];
  const n = toolCalls.length;
  let i = 0;

  while (i < n) {
    const currentName = stripServerPrefix(toolCalls[i].name);
    let runEnd = i + 1;
    while (runEnd < n && stripServerPrefix(toolCalls[runEnd].name) === currentName) {
      runEnd++;
    }
    const runLength = runEnd - i;

    if (runLength >= GROUP_THRESHOLD) {
      pass1.push({
        kind: "homogeneous",
        calls: toolCalls.slice(i, runEnd),
        indexes: Array.from({ length: runLength }, (_, k) => i + k),
        name: currentName,
      });
    } else {
      for (let k = i; k < runEnd; k++) {
        pass1.push({ kind: "single", call: toolCalls[k], index: k });
      }
    }
    i = runEnd;
  }

  // Pass 2: coalesce runs of singles into mixed groups.
  const out: RenderUnit[] = [];
  let j = 0;
  while (j < pass1.length) {
    if (pass1[j].kind !== "single") {
      out.push(pass1[j]);
      j++;
      continue;
    }

    let k = j;
    while (k < pass1.length && pass1[k].kind === "single") k++;
    const runSingles = pass1.slice(j, k) as Extract<RenderUnit, { kind: "single" }>[];

    if (runSingles.length >= GROUP_THRESHOLD) {
      const calls = runSingles.map((u) => u.call);
      const indexes = runSingles.map((u) => u.index);
      const uniqueNames = [...new Set(calls.map((c) => stripServerPrefix(c.name)))];
      out.push({ kind: "mixed", calls, indexes, uniqueNames });
    } else {
      out.push(...runSingles);
    }
    j = k;
  }

  return out;
}
