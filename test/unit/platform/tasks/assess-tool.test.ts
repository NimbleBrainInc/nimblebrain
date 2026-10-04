/**
 * `tasks__assess`: a person's verdict on a run, recorded beside the judge's
 * and replacing it in the derived label; re-assessment with the task's
 * current criteria; and the run surfaces carrying execution, assessment, and
 * label. Plus the definition fields at create, update, and an inline run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAssess,
  handleCreate,
  handleRunResult,
  handleRuns,
  handleStatus,
  handleUpdate,
  type ToolContext,
} from "../../../../src/platform/tasks/server.ts";
import {
  appendRun,
  deleteTaskDefinition,
  findRun,
  loadOwnerTasks,
  readAllRuns,
  readRunResult,
  readRuns,
  readRunsPage,
  saveRunResult,
  saveTask,
  updateRun,
} from "../../../../src/platform/tasks/store.ts";
import type { RunAssessment, TaskRun } from "../../../../src/platform/tasks/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "assess-tool-"));
  seedWorkspaceRoot(workDir, WS);
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const loadDefs = () => loadOwnerTasks(workDir, WS, OWNER);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    definitions: loadDefs,
    save: (defs) => {
      const onDisk = loadDefs();
      for (const t of defs.values()) {
        t.workspaceId ??= WS;
        t.ownerId ??= OWNER;
        saveTask(workDir, WS, OWNER, t);
      }
      for (const id of onDisk.keys())
        if (!defs.has(id)) deleteTaskDefinition(workDir, WS, OWNER, id);
    },
    reloadScheduler: () => {},
    runNow: () => null,
    cancelRun: () => false,
    readRuns: (id, opts) => readRuns(workDir, WS, OWNER, id, opts),
    readRunsPage: (id, opts) => readRunsPage(workDir, WS, OWNER, id, opts),
    readAllRuns: (opts) => readAllRuns(workDir, WS, OWNER, opts),
    readRunResult: (id, runId) => readRunResult(workDir, WS, OWNER, id, runId),
    findRun: (id, runId) => findRun(workDir, WS, OWNER, id, runId),
    updateRun: (id, runId, update) => updateRun(workDir, WS, OWNER, id, runId, update),
    defaultTimezone: "Pacific/Honolulu",
    currentUserId: OWNER,
    currentWorkspaceId: WS,
    ...overrides,
  };
}

const judged: RunAssessment = {
  verdict: "fail",
  assessedAt: "2026-10-01T00:02:00.000Z",
  criteria: [{ id: "sourced", answer: false, passed: false, confidence: 0.9 }],
  judge: { server: "judge", id: "stub", calibrated: true },
};

function seedRun(overrides: Partial<TaskRun> = {}): TaskRun {
  const run: TaskRun = {
    id: "run_aaaaaaaaaaaa",
    taskId: "report",
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:01:00.000Z",
    status: "success",
    inputTokens: 1,
    outputTokens: 1,
    toolCalls: 0,
    iterations: 1,
    stopReason: "complete",
    resultPreview: "the report",
    assessment: judged,
    ...overrides,
  };
  appendRun(workDir, WS, OWNER, "report", run);
  saveRunResult(workDir, WS, OWNER, "report", {
    runId: run.id,
    taskId: "report",
    completedAt: run.completedAt ?? "",
    output: "the report",
    activityLog: [],
    outputFiles: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1 },
  });
  return run;
}

function createReport(ctx: ToolContext): void {
  handleCreate(
    {
      manifest: {
        name: "report",
        criteria: [{ id: "sourced", rule: "Every claim cites a source.", type: "boolean" }],
        confidenceThreshold: 0.8,
        onPoorResult: "record",
      },
      body: "Write the report.",
    },
    ctx,
  );
}

describe("definition fields", () => {
  it("create keeps criteria, threshold, judge, and policy; update patches and null clears", () => {
    const ctx = makeCtx();
    createReport(ctx);
    const stored = loadDefs().get("report");
    expect(stored?.criteria?.[0]?.id).toBe("sourced");
    expect(stored?.confidenceThreshold).toBe(0.8);
    expect(stored?.onPoorResult).toBe("record");

    handleUpdate({ name: "report", manifest: { judge: { server: "judge" } } }, ctx);
    expect(loadDefs().get("report")?.judge).toEqual({ server: "judge" });

    handleUpdate(
      { name: "report", manifest: { criteria: null, confidenceThreshold: null, judge: null } },
      ctx,
    );
    const cleared = loadDefs().get("report");
    expect(cleared && "criteria" in cleared).toBe(false);
    expect(cleared && "confidenceThreshold" in cleared).toBe(false);
    expect(cleared && "judge" in cleared).toBe(false);
  });

  it("create refuses criteria the judge contract would refuse", () => {
    expect(() =>
      handleCreate(
        {
          manifest: {
            name: "bad",
            criteria: [{ id: "tone", rule: "Tone?", type: "choice", options: ["a", "b"] }],
          },
          body: "x",
        },
        makeCtx(),
      ),
    ).toThrow(/pass is required/);
    expect(loadDefs().has("bad")).toBe(false);
  });
});

describe("run surfaces carry execution, assessment, and label", () => {
  it("runs, status, and run_result", () => {
    const ctx = makeCtx();
    createReport(ctx);
    seedRun();
    const runs = handleRuns({ taskId: "report" }, ctx).runs;
    expect(runs[0]).toMatchObject({ execution: "completed", label: "Poor result" });
    expect(runs[0]?.assessment?.verdict).toBe("fail");
    expect(handleStatus({ name: "report" }, ctx).recentRuns[0]?.label).toBe("Poor result");
    const result = handleRunResult({ name: "report", runId: "run_aaaaaaaaaaaa" }, ctx);
    expect(result).toMatchObject({ execution: "completed", label: "Poor result" });
    expect(result.assessment?.verdict).toBe("fail");
  });
});

describe("tasks__assess", () => {
  it("a person's verdict replaces the judge's in the label, recording who and from where", async () => {
    const ctx = makeCtx({ callerVia: () => "ui" });
    createReport(ctx);
    seedRun();
    const out = await handleAssess(
      { runId: "run_aaaaaaaaaaaa", verdict: "pass", note: "the source is in the footnote" },
      ctx,
    );
    expect(out.run.label).toBe("Succeeded");
    expect(out.run.assessment?.verdict).toBe("fail");
    expect(out.run.assessment?.human).toMatchObject({
      verdict: "pass",
      note: "the source is in the footnote",
      by: OWNER,
      via: "ui",
    });
    expect(
      findRun(workDir, WS, OWNER, "report", "run_aaaaaaaaaaaa")?.assessment?.human?.verdict,
    ).toBe("pass");
  });

  it("records via remote for any caller the shell did not make", async () => {
    const ctx = makeCtx();
    createReport(ctx);
    seedRun();
    const out = await handleAssess({ runId: "run_aaaaaaaaaaaa", verdict: "fail" }, ctx);
    expect(out.run.assessment?.human?.via).toBe("remote");
    expect(out.run.label).toBe("Poor result");
  });

  it("reassess judges again with the current criteria and keeps a person's verdict", async () => {
    let asked: TaskRun | undefined;
    const ctx = makeCtx({
      reassessRun: async (task, run) => {
        asked = run;
        return updateRun(workDir, WS, OWNER, task.id, run.id, (r) => ({
          ...r,
          assessment: {
            verdict: "pass",
            assessedAt: "2026-10-02T00:00:00.000Z",
            ...(r.assessment?.human ? { human: r.assessment.human } : {}),
          },
        }));
      },
    });
    createReport(ctx);
    seedRun();
    await handleAssess({ runId: "run_aaaaaaaaaaaa", verdict: "fail" }, ctx);
    const out = await handleAssess({ runId: "run_aaaaaaaaaaaa", reassess: true }, ctx);
    expect(asked?.id).toBe("run_aaaaaaaaaaaa");
    expect(out.run.assessment?.verdict).toBe("pass");
    expect(out.run.assessment?.human?.verdict).toBe("fail");
    expect(out.message).toContain("re-assessed: pass");
  });

  it("needs exactly one of verdict and reassess, and a note only with a verdict", async () => {
    const ctx = makeCtx();
    createReport(ctx);
    seedRun();
    await expect(handleAssess({ runId: "run_aaaaaaaaaaaa" }, ctx)).rejects.toThrow(
      /one of the two/,
    );
    await expect(
      handleAssess({ runId: "run_aaaaaaaaaaaa", verdict: "pass", reassess: true }, ctx),
    ).rejects.toThrow(/one of the two/);
    await expect(
      handleAssess({ runId: "run_aaaaaaaaaaaa", reassess: true, note: "x" }, ctx),
    ).rejects.toThrow(/note/);
  });

  it("refuses a run that left no deliverable", async () => {
    const ctx = makeCtx();
    createReport(ctx);
    seedRun({
      status: "failure",
      stopReason: "error",
      resultPreview: undefined,
      assessment: undefined,
    });
    await expect(handleAssess({ runId: "run_aaaaaaaaaaaa", verdict: "pass" }, ctx)).rejects.toThrow(
      /no deliverable/,
    );
  });

  it("refuses a run the caller does not have", async () => {
    const ctx = makeCtx();
    createReport(ctx);
    await expect(handleAssess({ runId: "run_bbbbbbbbbbbb", verdict: "pass" }, ctx)).rejects.toThrow(
      /Run not found/,
    );
  });
});
