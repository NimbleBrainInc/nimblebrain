import { useEffect, useRef, useState } from "react";
import type { ToolCallDisplay } from "./useChat";

const MIN_DISPLAY_MS = 600;

export interface VisualStatus {
  status: "running" | "done" | "error";
  ms?: number;
}

/**
 * Holds a tool call in the "running" visual state for at least `MIN_DISPLAY_MS`
 * before snapping to its terminal state — so very fast tools don't flash
 * running→done too briefly to register. Only applies to calls observed
 * running; calls that arrive already complete (e.g. loaded from history) pass
 * through unchanged.
 */
export function useMinDisplayTime(toolCalls: ToolCallDisplay[]): VisualStatus[] {
  const startTimesRef = useRef<Map<string, number>>(new Map());
  const [, setTick] = useState(0);

  // Record a start time only for calls we actually saw as "running". Tools
  // loaded from history are already terminal — they get no grace period.
  for (const tc of toolCalls) {
    if (tc.status === "running" && !startTimesRef.current.has(tc.id)) {
      startTimesRef.current.set(tc.id, Date.now());
    }
  }

  const now = Date.now();

  const result = toolCalls.map((tc): VisualStatus => {
    if (tc.status === "running") {
      return { status: "running", ms: tc.ms };
    }
    const startTime = startTimesRef.current.get(tc.id);
    if (startTime === undefined) {
      return { status: tc.status, ms: tc.ms };
    }
    const elapsed = now - startTime;
    if (elapsed < MIN_DISPLAY_MS) {
      return { status: "running", ms: undefined };
    }
    return { status: tc.status, ms: tc.ms };
  });

  // Re-render once when the earliest grace period expires.
  useEffect(() => {
    let earliest = Infinity;
    const effectNow = Date.now();

    for (const tc of toolCalls) {
      if (tc.status === "running") continue;
      const startTime = startTimesRef.current.get(tc.id);
      if (startTime === undefined) continue;
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
