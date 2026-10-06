/** Reading one run through `tasks__run_result`, for every screen that shows one. */

import type { TaskRun, TaskRunResult } from "../types.ts";
import { asDict, toolErrorText } from "../utils.ts";

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/** What `run_result` answers: the run in any state, and its deliverable once it has ended. */
interface RunResultAnswer {
  status: "queued" | "running" | "ended";
  run: TaskRun;
  result?: Omit<TaskRunResult, "runId" | "taskId" | "execution" | "label" | "assessment">;
}

/** A run's record and result, or that it is still open, or why it could not be read. */
export async function readResult(
  call: ToolCall,
  runId: string,
  taskId: string | undefined,
): Promise<{ run?: TaskRun; result: TaskRunResult | null; open: boolean; error?: string }> {
  try {
    const res = await call({ runId, ...(taskId ? { taskId } : {}) });
    const answer = asDict(res.data) as unknown as RunResultAnswer;
    const { run } = answer;
    if (answer.status !== "ended") return { run, result: null, open: true };
    const result: TaskRunResult | null = answer.result
      ? {
          ...answer.result,
          runId: run.id,
          taskId: run.taskId,
          execution: run.execution,
          label: run.label,
          ...(run.assessment ? { assessment: run.assessment } : {}),
        }
      : null;
    return { run, result, open: false };
  } catch (err) {
    return { result: null, open: false, error: toolErrorText(err) };
  }
}
