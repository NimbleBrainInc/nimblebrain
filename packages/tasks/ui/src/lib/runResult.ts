/** Reading one run through `run_result`, for every screen that shows one. */

import { isOpenExecution, type RunResultData, type TaskRun, type TaskRunResult } from "../types.ts";
import { asDict, toolErrorText } from "../utils.ts";

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/**
 * A run's record and result, or that it is still open, or why it could not be
 * read. A run whose execution this screen does not know reads as ended
 * (CONTRACT.md §4), so it is never polled forever.
 */
export async function readResult(
  call: ToolCall,
  runId: string,
): Promise<{ run?: TaskRun; result: TaskRunResult | null; open: boolean; error?: string }> {
  try {
    const res = await call({ runId });
    // `run_result` answers JSON read as `RunResultData`, this package's
    // hand-kept mirror of the contract's `run_result_output`; nothing checks it at runtime.
    // biome-ignore lint/plugin/double-cast: tool JSON read as the hand-kept `RunResultData` mirror
    const answer = asDict(res.data) as unknown as RunResultData;
    const { run } = answer;
    if (isOpenExecution(run.execution)) return { run, result: null, open: true };
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
