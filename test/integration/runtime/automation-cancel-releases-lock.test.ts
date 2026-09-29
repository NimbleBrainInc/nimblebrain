/**
 * Cancelling a run releases the automation's per-run lock promptly, even when
 * the tool the run is waiting on ignores its abort signal. The abort reaches
 * the MCP client, which rejects the pending call itself rather than waiting
 * for the handler, so the run ends as cancelled and the next Run now starts.
 *
 * Real runtime, real scheduler and executor, and an in-process tool whose
 * handler never returns and never reads its signal.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textContent } from "../../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { createDirectExecutor } from "../../../src/platform/automations/executor.ts";
import { Scheduler } from "../../../src/platform/automations/scheduler.ts";
import { resolveExecutorContext } from "../../../src/platform/automations/source.ts";
import { saveAutomation } from "../../../src/platform/automations/store.ts";
import type { Automation } from "../../../src/platform/automations/types.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { TaskRequest } from "../../../src/runtime/types.ts";
import { defineInProcessApp } from "../../../src/tools/in-process-app.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const WS = "ws_cancel_lock";
const workDir = mkdtempSync(join(tmpdir(), "nb-cancel-lock-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("cancelling an automation run", () => {
  it("releases the lock when the tool in flight ignores its abort signal", async () => {
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    const source = defineInProcessApp(
      {
        name: "probe",
        version: "1.0.0",
        tools: [
          {
            name: "hang",
            description: "Never returns and ignores its abort signal.",
            inputSchema: { type: "object", properties: {} },
            handler: async () => {
              entered();
              await new Promise(() => {});
              return { content: textContent("never"), isError: false };
            },
          },
        ],
      },
      { emit() {} },
    );
    await source.start();

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: {
        provider: "custom",
        adapter: createEchoModel({
          responses: [
            { toolCalls: [{ toolCallId: "tc1", toolName: "probe__hang", input: "{}" }] },
            { text: "done" },
            { text: "done" },
          ],
        }),
      },
      logging: { disabled: true },
      workDir,
    });
    try {
      await provisionTestWorkspace(runtime, WS, "Cancel lock");
      const reg = await runtime.ensureWorkspaceRegistry(WS);
      reg.addSource(source);
      const auto = {
        id: "hangs",
        name: "Hangs",
        prompt: "call the hang tool",
        ownerId: DEV_IDENTITY.id,
        workspaceId: WS,
        enabled: true,
        schedule: { type: "interval", intervalMs: 3_600_000 },
        consecutiveErrors: 0,
        runCount: 0,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
      } as unknown as Automation;
      saveAutomation(workDir, WS, DEV_IDENTITY.id, auto);
      const executor = createDirectExecutor(
        (req) => runtime.executeTask(req as TaskRequest),
        resolveExecutorContext,
      );
      const scheduler = new Scheduler(executor, { workDir });
      scheduler.reload();

      const firstRun = scheduler.runNow(WS, DEV_IDENTITY.id, "hangs");
      await enteredP;
      expect(scheduler.cancelRun(WS, DEV_IDENTITY.id, "hangs")).toBe(true);
      const TIMED_OUT = Symbol("timed out");
      const first = await Promise.race([
        firstRun,
        new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), 3000)),
      ]);
      if (first === TIMED_OUT) throw new Error("the cancelled run still holds the lock after 3s");
      expect(first?.status).toBe("cancelled");
      expect(scheduler.getActiveRunIds()).toEqual([]);

      const second = await scheduler.runNow(WS, DEV_IDENTITY.id, "hangs");
      expect(second?.status).toBe("success");
    } finally {
      await runtime.shutdown();
    }
  }, 20_000);
});
