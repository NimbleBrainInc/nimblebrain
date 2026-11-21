/**
 * The bench's cases: real requests, each graded on what the workspace stored
 * and which tools the agent called, never on what the agent said it did.
 *
 * A case is one conversation of one or more turns. `check` reads the run's
 * state after the last turn and returns the failed checks (empty means the goal
 * was met). `tools` names what the trace should and should not hold, scored
 * separately from the goal so a run can reach the goal the long way round.
 */

import type { Task, TaskRun } from "../../../src/platform/tasks/types.ts";
import type { ChatResult } from "../../../src/runtime/types.ts";

/** What a case's check can read after the conversation ends. */
export interface RunState {
  /** Every turn's result, in order. */
  turns: ChatResult[];
  /** The live files: name and text. */
  files: Array<{ filename: string; text: string }>;
  /** The workspace's tasks, with each one's runs. */
  tasks: Array<{ task: Task; runs: TaskRun[] }>;
}

export interface ToolExpectations {
  /** Each must be called at least once across the conversation. */
  required?: string[];
  /** None may be called. */
  forbidden?: string[];
  /** Each may be called at most this many times (a second `tasks__create` is a duplicate). */
  maxCalls?: Record<string, number>;
}

export interface BenchCase {
  id: string;
  /** What the case measures, for the report. */
  summary: string;
  /** The user's messages, one per turn, sent in one conversation. */
  turns: string[];
  check: (state: RunState) => string[];
  tools: ToolExpectations;
}

const WEEKDAYS = /^\s*0\s+(\d{1,2})\s+\*\s+\*\s+(1-5|MON-FRI)\s*$/i;

function weekdayHour(task: Task): number | null {
  const s = task.schedule;
  if (s?.type !== "cron" || !s.expression) return null;
  const m = s.expression.match(WEEKDAYS);
  return m ? Number(m[1]) : null;
}

function lastResponse(state: RunState): string {
  return state.turns[state.turns.length - 1]?.response ?? "";
}

export const CASES: BenchCase[] = [
  {
    id: "file-create",
    summary: "Create a file with given contents",
    turns: ["Create a file called groceries.md with this list: eggs, milk, bread."],
    check: ({ files }) => {
      const f = files.find((x) => x.filename.toLowerCase() === "groceries.md");
      if (!f)
        return [`no groceries.md (files: ${files.map((x) => x.filename).join(", ") || "none"})`];
      const missing = ["eggs", "milk", "bread"].filter((w) => !f.text.toLowerCase().includes(w));
      return missing.length ? [`groceries.md lacks: ${missing.join(", ")}`] : [];
    },
    tools: { required: ["files__create"], maxCalls: { files__create: 1 } },
  },
  {
    id: "file-roundtrip",
    summary: "Write a file, then answer from it in a later turn",
    turns: [
      "Save a note called launch.txt that says: The launch code is 4417 and the venue is Pier 9.",
      "What venue did my launch note mention? Check the file rather than going from memory.",
    ],
    check: (state) => {
      const errs: string[] = [];
      const f = state.files.find((x) => x.filename.toLowerCase() === "launch.txt");
      if (!f?.text.includes("4417")) errs.push("launch.txt missing or lacks the code");
      if (!/pier\s*9/i.test(lastResponse(state))) errs.push("answer does not name Pier 9");
      return errs;
    },
    tools: { required: ["files__create", "files__read"], maxCalls: { files__create: 1 } },
  },
  {
    id: "task-lifecycle",
    summary: "Create a weekday schedule, move it in a later turn, then run it once",
    turns: [
      "Set up a scheduled task that runs every weekday at 8am and writes a one-line summary of my files. Don't run it yet.",
      "Actually, move it to 9am.",
      "Run it once now.",
    ],
    check: ({ tasks }) => {
      if (tasks.length === 0) return ["no task created"];
      const errs: string[] = [];
      if (tasks.length > 1) errs.push(`${tasks.length} tasks exist; the move made a duplicate`);
      // Grade the moved task when there is one, so a duplicate left at 8am
      // is reported as the duplicate, not as a failed move.
      const t =
        tasks.find((x) => weekdayHour(x.task) === 9) ??
        tasks.find((x) => weekdayHour(x.task) !== null) ??
        tasks[0];
      if (!t) return ["no task created"];
      const hour = weekdayHour(t.task);
      if (hour !== 9)
        errs.push(`schedule is ${t.task.schedule?.expression ?? "none"}, not weekdays at 9`);
      if (t.runs.length < 1) errs.push("never ran");
      return errs;
    },
    tools: {
      required: ["tasks__create", "tasks__update", "tasks__run"],
      maxCalls: { tasks__create: 1 },
    },
  },
  {
    id: "open-app",
    summary: "Show the app, not a chat answer, when asked to see something",
    turns: ["Open my scheduled tasks so I can see them."],
    check: openedTasksApp,
    tools: { required: ["nb__open_app"], forbidden: ["tasks__create"] },
  },
  {
    id: "open-app-explicit",
    summary: "Open an app named outright",
    turns: ["Open the Scheduled app."],
    check: openedTasksApp,
    tools: { required: ["nb__open_app"], forbidden: ["tasks__create"] },
  },
];

function openedTasksApp({ turns }: RunState): string[] {
  const opened = turns
    .flatMap((t) => t.toolCalls)
    .some(
      (c) =>
        c.name === "nb__open_app" &&
        c.ok &&
        /task|schedul/i.test(String(c.input.app ?? c.input.uri ?? "")),
    );
  return opened ? [] : ["did not open the tasks app"];
}
