/**
 * Run now tests the scheduled run, so it runs with the scheduled run's
 * authority: an org admin who clicks Run now gets the tools the schedule will
 * get, not their own. A task run acts as `{ id: ownerId }` with no org
 * role, so admin-only tools are closed to both.
 *
 * Admin-only tools are app-only: they are never in a run's offered tool list,
 * whoever runs it, and the engine refuses a model's call that names one. An
 * org role therefore opens no tool to any run, so each run calls one and the
 * test compares the offered tool list and the call's outcome. The control run
 * pins the refusal to visibility rather than role: the same admin identity
 * handed to `executeTask` directly is refused too.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { createDirectExecutor } from "../../../src/platform/tasks/executor.ts";
import { resolveExecutorContext } from "../../../src/platform/tasks/source.ts";
import type { Task } from "../../../src/platform/tasks/types.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { TaskRequest } from "../../../src/runtime/types.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const WS = "ws_0069b0bea4fbff54";
const ADMIN_ONLY_TOOL = "nb__manage_users";
const RUNS = 3;

const workDir = mkdtempSync(join(tmpdir(), "nb-run-now-tools-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * An echo model that records the tool names each run is offered. Every run it
 * serves calls the admin-only tool, then finishes.
 */
function recordingModel(): { model: LanguageModelV4; offered: string[][] } {
  const offered: string[][] = [];
  const inner = createEchoModel({
    responses: Array.from({ length: RUNS }, (_, i) => [
      {
        toolCalls: [
          {
            toolCallId: `tc_admin_${i}`,
            toolName: ADMIN_ONLY_TOOL,
            input: JSON.stringify({ action: "list" }),
          },
        ],
      },
      { text: "done" },
    ]).flat(),
  });
  // Only a run's opening model call is recorded: the one no tool result has
  // reached yet, which carries the list the run opens with.
  const record = (options: LanguageModelV4CallOptions) => {
    if (options.prompt.some((m) => m.role === "tool")) return;
    offered.push((options.tools ?? []).map((t) => t.name).sort());
  };
  const model: LanguageModelV4 = {
    ...inner,
    async doGenerate(options) {
      record(options);
      return inner.doGenerate(options);
    },
    async doStream(options) {
      record(options);
      return inner.doStream(options);
    },
  };
  return { model, offered };
}

describe("Run now gets the scheduled run's tools", () => {
  it("an org admin's manual run gets the scheduled run's tools, admin-only tools closed to both", async () => {
    const { model, offered } = recordingModel();
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: model },
      logging: { disabled: true },
      workDir,
    });
    try {
      await provisionTestWorkspace(runtime, WS, "Run now");

      const admin = { ...DEV_IDENTITY, orgRole: "admin" } as UserIdentity;
      const task = {
        id: "weekly-report",
        name: "Weekly report",
        prompt: "Write the weekly report",
        ownerId: admin.id,
        workspaceId: WS,
      } as Task;
      const executor = createDirectExecutor(
        (req) => runtime.executeTask(req as TaskRequest),
        resolveExecutorContext,
      );

      // Control: the admin's own identity is refused as well, because the tool
      // is app-only and the engine refuses a model's call to it.
      const control = await runtime.executeTask({
        prompt: "control",
        workspaceId: WS,
        identity: admin,
      });
      expect(control.toolCalls[0]?.name).toBe(ADMIN_ONLY_TOOL);
      expect(control.toolCalls[0]?.ok).toBe(false);
      expect(control.toolCalls[0]?.output).toContain("is not available to the agent");

      // Run now, clicked by the admin inside their own request context.
      const manual = await runWithRequestContext({ identity: admin, workspaceId: WS }, () =>
        executor(task, undefined, "manual"),
      );
      const scheduled = await executor(task, undefined, "scheduled");

      expect(offered).toHaveLength(RUNS);
      const [, manualTools, scheduledTools] = offered;
      expect(manualTools).toEqual(scheduledTools);
      expect(manualTools).not.toContain(ADMIN_ONLY_TOOL);

      const manualCall = manual.result?.activityLog[0];
      const scheduledCall = scheduled.result?.activityLog[0];
      expect(manualCall?.name).toBe(ADMIN_ONLY_TOOL);
      expect(manualCall?.ok).toBe(false);
      expect(scheduledCall?.ok).toBe(false);
      expect(manualCall?.output).toBe(scheduledCall?.output);
    } finally {
      await runtime.shutdown();
    }
  });
});
