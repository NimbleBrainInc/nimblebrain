/**
 * The trail the panel sends the host for its breadcrumb: root first, the
 * current screen last. Each entry carries the screen stack it leads back to,
 * so following one is a lookup, not a second copy of the navigation rules.
 */

import { runName } from "../lib/plain.ts";
import type { TaskBatch, TaskRun } from "../types.ts";
import type { Template } from "./templates.ts";

/** A page over the home list. The stack is the trail: one page, one crumb. */
export type Screen =
  | { kind: "task"; taskName: string }
  | { kind: "upcoming" }
  | { kind: "activity"; taskId?: string; taskName?: string }
  | { kind: "result"; runId: string; taskId?: string; run?: TaskRun }
  | { kind: "batch"; batchId: string; batch?: TaskBatch }
  | { kind: "editor"; taskName?: string; copyOf?: string; template?: Template | null };

export interface TrailStep {
  id: string;
  label: string;
  /** The stack this entry leads to. */
  stack: Screen[];
}

/** The trail's root: the panel's own placement, as the host knows it. */
export const TRAIL_ROOT_ID = "ui://tasks/panel";

function runLabel(s: Extract<Screen, { kind: "result" }>): string {
  return runName(s.run?.startedAt);
}

/** The crumb one page adds. */
function stepFor(screen: Screen, stack: Screen[]): TrailStep {
  switch (screen.kind) {
    case "task":
      return { id: `task/${screen.taskName}`, label: screen.taskName, stack };
    case "upcoming":
      return { id: "upcoming", label: "Coming up", stack };
    case "activity":
      return screen.taskName
        ? { id: `runs/${screen.taskName}`, label: "All runs", stack }
        : { id: "activity", label: "Every run", stack };
    case "result":
      return { id: `run/${screen.runId}`, label: runLabel(screen), stack };
    case "batch":
      return {
        id: `batch/${screen.batchId}`,
        label: `Batch ${screen.batchId.slice(6, 10)}`,
        stack,
      };
    case "editor":
      return screen.taskName
        ? { id: `edit/${screen.taskName}`, label: "Edit", stack }
        : { id: "new", label: "New task", stack };
  }
}

/**
 * The stack after opening a run: a run already on top gives way to it (a
 * re-run, or a run it links to), and a run of a known task sits under that
 * task's page (added when the stack holds none), so a crumb leads to the task
 * wherever the run was opened.
 */
export function withRun(
  stack: Screen[],
  run: Extract<Screen, { kind: "result" }>,
  taskName: string | undefined,
): Screen[] {
  const base = stack[stack.length - 1]?.kind === "result" ? stack.slice(0, -1) : stack;
  const hasTask = base.some((s) => s.kind === "task" && s.taskName === taskName);
  const parent = taskName && !hasTask ? [{ kind: "task" as const, taskName }] : [];
  return [...base, ...parent, run];
}

/** The whole trail for the screens open over the home list. */
export function trailFor(stack: Screen[]): TrailStep[] {
  const root: TrailStep = { id: TRAIL_ROOT_ID, label: "Tasks", stack: [] };
  // Ids are made unique by position, so the same page twice is two crumbs.
  return [
    root,
    ...stack.map((screen, i) => {
      const step = stepFor(screen, stack.slice(0, i + 1));
      return { ...step, id: `${i}:${step.id}` };
    }),
  ];
}
