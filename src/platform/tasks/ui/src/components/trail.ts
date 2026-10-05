/**
 * The trail the panel sends the host for its breadcrumb: root first, the
 * current screen last. Each entry carries the screen stack it leads back to,
 * so following one is a lookup, not a second copy of the navigation rules.
 */
import type { TaskBatch, TaskRun } from "../types.ts";
import { formatWhen } from "../utils.ts";
import type { Template } from "./templates.ts";

/** A screen over the home list. A task opens as a sheet over the screen under it. */
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
  return s.run
    ? `Run ${formatWhen(s.run.startedAt)}`
    : `Run ${s.runId.replace(/^run_/, "").slice(0, 6)}`;
}

function taskStep(name: string): TrailStep {
  return { id: `task/${name}`, label: name, stack: [{ kind: "task", taskName: name }] };
}

/** The steps one screen adds, given the screens under it. */
function stepsFor(
  screen: Screen,
  below: Screen[],
  nameOf: (taskId: string) => string | undefined,
): TrailStep[] {
  const stack = [...below, screen];
  const prev = below[below.length - 1];
  const parent = (name: string | undefined) =>
    name && !(prev?.kind === "task" && prev.taskName === name) ? [taskStep(name)] : [];
  switch (screen.kind) {
    case "task":
      return [{ ...taskStep(screen.taskName), stack }];
    case "upcoming":
      return [{ id: "upcoming", label: "Coming up", stack }];
    case "activity":
      return screen.taskName
        ? [...parent(screen.taskName), { id: `runs/${screen.taskName}`, label: "Runs", stack }]
        : [{ id: "activity", label: "Every run", stack }];
    case "result":
      return [
        ...parent(screen.taskId ? nameOf(screen.taskId) : undefined),
        { id: `run/${screen.runId}`, label: runLabel(screen), stack },
      ];
    case "batch":
      return [
        ...parent(screen.batch ? nameOf(screen.batch.taskId) : undefined),
        { id: `batch/${screen.batchId}`, label: `Batch ${screen.batchId.slice(6, 10)}`, stack },
      ];
    case "editor":
      return screen.taskName
        ? [...parent(screen.taskName), { id: `edit/${screen.taskName}`, label: "Edit", stack }]
        : [{ id: "new", label: "New task", stack }];
  }
}

/** The whole trail for the screens open over the home list. */
export function trailFor(
  stack: Screen[],
  nameOf: (taskId: string) => string | undefined,
): TrailStep[] {
  const root: TrailStep = { id: TRAIL_ROOT_ID, label: "Tasks", stack: [] };
  const steps: TrailStep[] = [root];
  stack.forEach((screen, i) => {
    steps.push(...stepsFor(screen, stack.slice(0, i), nameOf));
  });
  // A step repeated (a task reached twice) keeps its latest place.
  return steps.filter(
    (s, i) => steps.findIndex((t) => t.id === s.id) === i || i === steps.length - 1,
  );
}
