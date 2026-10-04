/**
 * Task run assessment through the real runtime: a judge server the workspace
 * connected (an in-process stub of the judge tool contract) is found among
 * its sources, called through the unattended dispatch door as the task's
 * owner, and its answers decided and recorded on the run. A poor result lands
 * in the workspace inbox; `tasks__assess` is refused inside a run and records
 * where a person's verdict came from.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type {
  TasksAssessOutput,
  TasksCreateOutput,
  TasksRunOutput,
  TasksRunResultOutput,
  TasksUpdateOutput,
} from "../../src/platform/schemas/tasks.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { answerAll, createStubJudge, type StubJudge } from "../helpers/stub-judge.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let workDir: string;
let runtime: Runtime;
let tasks: ToolSource;
let stub: StubJudge;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "task-assessment-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    telemetry: { enabled: false },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  stub = await createStubJudge("grader");
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(stub.source);
  const source = runtime.getIdentitySource("tasks");
  if (!source) throw new Error("tasks source missing");
  tasks = source;
});

afterAll(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  stub.calls.length = 0;
  stub.answer = (call) => answerAll(call, true);
});

/** Call a tasks tool as the dev user in the test workspace, from a context like `extra`. */
async function call<T>(
  tool: string,
  args: Record<string, unknown>,
  extra: { unattended?: boolean; shellCall?: boolean; workspaceId?: string } = {},
): Promise<{ data: T; isError: boolean; text: string }> {
  const result: ToolResult = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID, ...extra },
    () => tasks.execute(tool, args),
  );
  const block = result.content?.[0];
  const text = block && block.type === "text" ? block.text : "";
  return { data: JSON.parse(text) as T, isError: result.isError === true, text };
}

async function runInline(name: string, criteria: unknown[]): Promise<string> {
  const out = await call<TasksRunOutput>("run", {
    prompt: `Write the ${name} report.`,
    idempotencyKey: name,
    criteria,
    onPoorResult: "notify",
  });
  if (out.isError) throw new Error(out.text);
  if (!("run" in out.data)) throw new Error(`expected a finished run, got ${out.text}`);
  return out.data.run.id;
}

const SOURCED = [{ id: "sourced", rule: "Every claim cites a source.", type: "boolean" }];

describe("assessment through the runtime", () => {
  it("finds the connected judge, calls it as the owner, and records a pass", async () => {
    const runId = await runInline("passing", SOURCED);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.criteria[0]?.id).toBe("sourced");
    const result = await call<TasksRunResultOutput>("run_result", { runId });
    expect(result.data.assessment).toMatchObject({
      verdict: "pass",
      judge: { server: "grader", id: "stub", calibrated: true },
    });
    expect(result.data.label).toBe("Succeeded");
  });

  it("a fail is a poor result, and the workspace inbox hears of it", async () => {
    stub.answer = (c) => answerAll(c, false);
    const runId = await runInline("failing", SOURCED);
    const result = await call<TasksRunResultOutput>("run_result", { runId });
    expect(result.data.label).toBe("Poor result");
    expect(result.data.execution).toBe("completed");
    const inbox = runtime.getNotificationStore(TEST_WORKSPACE_ID).list({ source: "tasks" });
    const item = inbox.find((n) => n.envelope.eventId === `poor-result:${runId}`);
    expect(item?.envelope.name).toBe("task.run.poor_result");
    // Every member reads the inbox, and the task is the owner's: the item
    // names the run and nothing of the task, its rules, or its deliverable.
    const visible = JSON.stringify(item);
    expect(visible).toContain(runId);
    for (const secret of [
      "failing",
      "oneoff-",
      "sourced",
      "Every claim cites a source",
      "report",
    ]) {
      expect(visible).not.toContain(secret);
    }
  });

  it("refuses tasks__assess inside an unattended run", async () => {
    const runId = await runInline("guarded", SOURCED);
    const out = await call<{ error: string }>(
      "assess",
      { runId, verdict: "pass" },
      { unattended: true },
    );
    expect(out.isError).toBe(true);
    expect(out.data.error).toContain("not available inside an unattended");
  });

  it("records a verdict from the shell as ui and any other as remote", async () => {
    stub.answer = (c) => answerAll(c, false);
    const runId = await runInline("reviewed", SOURCED);
    const fromShell = await call<TasksAssessOutput>(
      "assess",
      { runId, verdict: "pass" },
      { shellCall: true },
    );
    expect(fromShell.data.run.assessment?.human?.via).toBe("ui");
    expect(fromShell.data.run.label).toBe("Succeeded");
    const remote = await call<TasksAssessOutput>("assess", { runId, verdict: "fail" });
    expect(remote.data.run.assessment?.human?.via).toBe("remote");
    expect(remote.data.run.label).toBe("Poor result");
  });

  it("reassess judges again with the task's current criteria", async () => {
    stub.answer = (c) => answerAll(c, false);
    const runId = await runInline("rejudged", SOURCED);
    stub.answer = (c) => answerAll(c, true);
    const out = await call<TasksAssessOutput>("assess", { runId, reassess: true });
    expect(out.isError).toBe(false);
    expect(out.data.run.assessment?.verdict).toBe("pass");
    expect(out.data.run.label).toBe("Succeeded");
  });
});

describe("a write warns when its task's runs would not be judged", () => {
  const BARE_WS = "ws_00aa11bb22cc33dd";
  const create = (name: string, manifest: Record<string, unknown>, workspaceId?: string) =>
    call<TasksCreateOutput>(
      "create",
      { manifest: { name, criteria: SOURCED, ...manifest }, body: "Write it." },
      workspaceId ? { workspaceId } : {},
    );

  beforeAll(async () => {
    await provisionTestWorkspace(runtime, BARE_WS, "No judge");
  });

  it("no warning with one judge connected, or without criteria", async () => {
    const judged = await create("warn-none", {});
    expect(judged.data.warnings).toBeUndefined();
    const plain = await call<TasksCreateOutput>(
      "create",
      { manifest: { name: "warn-plain" }, body: "x" },
      { workspaceId: BARE_WS },
    );
    expect(plain.data.warnings).toBeUndefined();
  });

  it("no_judge: saved, with the warning in the text and as a field", async () => {
    const out = await create("warn-no-judge", {}, BARE_WS);
    expect(out.isError).toBe(false);
    expect(out.data.created).toBe(true);
    expect(out.data.warnings?.map((w) => w.code)).toEqual(["no_judge"]);
    expect(out.data.message).toContain("Needs review");
  });

  it("judge_not_found on update naming a source that is not a connected judge", async () => {
    await create("warn-named", {});
    const out = await call<TasksUpdateOutput>("update", {
      name: "warn-named",
      manifest: { judge: { server: "missing" } },
    });
    expect(out.data.updated).toBe(true);
    expect(out.data.warnings?.map((w) => w.code)).toEqual(["judge_not_found"]);
  });

  it("judge_ambiguous with two judges and none named; an inline run warns too", async () => {
    const second = await createStubJudge("grader2");
    runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(second.source);
    try {
      const out = await create("warn-two", {});
      expect(out.data.warnings?.map((w) => w.code)).toEqual(["judge_ambiguous"]);
      const run = await call<TasksRunOutput>("run", {
        prompt: "Inline with criteria.",
        idempotencyKey: "warn-inline",
        criteria: SOURCED,
      });
      expect(run.data.warnings?.map((w) => w.code)).toEqual(["judge_ambiguous"]);
      expect(run.data.warnings?.[0]?.message).toStartWith("This run's criteria cannot be judged");
      expect(out.data.warnings?.[0]?.message).toStartWith("Saved, but");
    } finally {
      await runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).removeSource("grader2");
    }
  });
});
