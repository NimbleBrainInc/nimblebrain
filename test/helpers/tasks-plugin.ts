/**
 * Calling the bound tasks plugin's public tools the way a person's tools
 * reach it (the identity source, under a request context), and following a
 * run until it ends.
 */

import type { ToolResult } from "../../src/engine/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { type RequestContext, runWithRequestContext } from "../../src/runtime/request-context.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";

/** One `tasks__<tool>` call as `identity` in `workspaceId`; extra context fields ride along. */
export function callTasks(
  runtime: Runtime,
  identity: Pick<UserIdentity, "id">,
  workspaceId: string,
  tool: string,
  input: Record<string, unknown>,
  context: Partial<RequestContext> = {},
): Promise<ToolResult> {
  const source = runtime.getIdentitySource("tasks");
  if (!source) throw new Error("no tasks source is bound");
  return runWithRequestContext(
    { identity: identity as UserIdentity, workspaceId, ...context },
    () => source.execute(tool, input),
  );
}

/** The structured answer of a successful call; throws with the text of a failed one. */
export function answer<T = Record<string, unknown>>(result: ToolResult): T {
  if (result.isError) {
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    throw new Error(`tool error: ${text}`);
  }
  return result.structuredContent as T;
}

export interface RunView {
  id: string;
  taskId: string;
  execution: string;
  label: string;
  trigger?: string;
  error?: string;
}

/** Poll `run_result` until the run leaves `queued` and `running`; its run and result. */
export async function waitForRun(
  runtime: Runtime,
  identity: Pick<UserIdentity, "id">,
  workspaceId: string,
  runId: string,
  timeoutMs = 20_000,
): Promise<{ run: RunView; result?: { output: string; outputFiles?: unknown[] } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const read = answer<{ run: RunView; result?: { output: string } }>(
      await callTasks(runtime, identity, workspaceId, "run_result", { runId }),
    );
    if (read.run.execution !== "queued" && read.run.execution !== "running") return read;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${read.run.execution}`);
    await Bun.sleep(100);
  }
}

/** Wait until `check` holds, polling. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  what = "the condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
