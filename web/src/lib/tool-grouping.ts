import type { ToolCallDisplay } from "../hooks/useChat";
import { stripServerPrefix } from "./format";

export const GROUP_THRESHOLD = 3;

export interface RenderUnit {
  kind: "single" | "group";
  calls: ToolCallDisplay[];
  /** Indexes into the original toolCalls array (for visual-status lookup). */
  indexes: number[];
  /** Tool name for homogeneous groups, "__mixed__" for mixed groups. Unset for singles. */
  groupName?: string;
  /** Distinct tool names present in the group. Unset for singles. */
  uniqueNames?: string[];
}

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

  // Pass 1: detect homogeneous runs.
  const units: RenderUnit[] = [];
  const n = toolCalls.length;
  let i = 0;

  while (i < n) {
    const currentName = stripServerPrefix(toolCalls[i].name);
    let runEnd = i + 1;
    while (
      runEnd < n &&
      stripServerPrefix(toolCalls[runEnd].name) === currentName
    ) {
      runEnd++;
    }
    const runLength = runEnd - i;

    if (runLength >= GROUP_THRESHOLD) {
      units.push({
        kind: "group",
        calls: toolCalls.slice(i, runEnd),
        indexes: Array.from({ length: runLength }, (_, k) => i + k),
        groupName: currentName,
        uniqueNames: [currentName],
      });
    } else {
      for (let k = i; k < runEnd; k++) {
        units.push({ kind: "single", calls: [toolCalls[k]], indexes: [k] });
      }
    }
    i = runEnd;
  }

  // Pass 2: coalesce runs of singles into mixed groups.
  const coalesced: RenderUnit[] = [];
  let j = 0;
  while (j < units.length) {
    if (units[j].kind === "single") {
      let k = j;
      while (k < units.length && units[k].kind === "single") k++;
      const singleCount = k - j;
      if (singleCount >= GROUP_THRESHOLD) {
        const groupCalls = units.slice(j, k).flatMap((u) => u.calls);
        const groupIdx = units.slice(j, k).flatMap((u) => u.indexes);
        const names = [
          ...new Set(groupCalls.map((c) => stripServerPrefix(c.name))),
        ];
        coalesced.push({
          kind: "group",
          calls: groupCalls,
          indexes: groupIdx,
          groupName: "__mixed__",
          uniqueNames: names,
        });
      } else {
        for (let m = j; m < k; m++) coalesced.push(units[m]);
      }
      j = k;
    } else {
      coalesced.push(units[j]);
      j++;
    }
  }

  return coalesced;
}
