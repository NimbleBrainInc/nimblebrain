import { useEffect, useRef, useState } from "react";
import type { ToolCallDisplay } from "./useChat";

const MIN_DISPLAY_MS = 600;

export interface VisualStatus {
  status: "running" | "done" | "error";
  ms?: number;
}

/**
 * Ensures each tool call shows the "running" animation for at least MIN_DISPLAY_MS
 * before transitioning to its final status.
 *
 * Approach: record when each tool first appeared, then on every render compute
 * whether enough time has elapsed. If any tool is waiting, schedule a single
 * timer for the earliest expiry to trigger a re-render.
 */
export function useMinDisplayTime(toolCalls: ToolCallDisplay[]): VisualStatus[] {
  const startTimesRef = useRef<Map<string, number>>(new Map());
  const [, setTick] = useState(0);

  // Record start time for new tools (idempotent — only set once per ID)
  for (const tc of toolCalls) {
    if (!startTimesRef.current.has(tc.id)) {
      startTimesRef.current.set(tc.id, Date.now());
    }
  }

  const now = Date.now();

  // Compute visual statuses from current time
  const result = toolCalls.map((tc): VisualStatus => {
    if (tc.status === "running") {
      return { status: "running", ms: tc.ms };
    }
    const startTime = startTimesRef.current.get(tc.id) ?? now;
    const elapsed = now - startTime;
    if (elapsed < MIN_DISPLAY_MS) {
      return { status: "running", ms: undefined };
    }
    return { status: tc.status, ms: tc.ms };
  });

  // If any completed tool is still waiting, schedule one re-render at the earliest expiry
  useEffect(() => {
    let earliest = Infinity;
    const effectNow = Date.now();

    for (const tc of toolCalls) {
      if (tc.status === "running") continue;
      const startTime = startTimesRef.current.get(tc.id);
      if (!startTime) continue;
      const remaining = MIN_DISPLAY_MS - (effectNow - startTime);
      if (remaining > 0 && remaining < earliest) {
        earliest = remaining;
      }
    }

    if (earliest === Infinity) return;

    const timer = setTimeout(() => setTick((n) => n + 1), earliest);
    return () => clearTimeout(timer);
  });

  return result;
}
