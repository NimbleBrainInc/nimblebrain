/**
 * Scheduled tasks: authoring from chat with the person's timezone, run now and
 * its result, cancel, a once schedule, a batch that pauses on its budget, and
 * what an unattended run may not do.
 */

import type { Caller, ParityClient } from "../client.ts";
import { structured, textOf } from "../client.ts";
import { directive } from "../directive-model.ts";
import {
  expect,
  expectEq,
  Mismatch,
  type Scenario,
  type ScenarioContext,
  until,
} from "../scenario.ts";

const TIMEZONE = "Pacific/Honolulu";

interface Run {
  id: string;
  taskId: string;
  execution: string;
  label: string;
  error?: string;
  trigger?: string;
}

interface RunResult {
  run: Run;
  result?: {
    output: string;
    activityLog?: Array<{ name: string; ok: boolean; errorReason?: string }>;
    outputFiles?: Array<{ id?: string; filename?: string }>;
    filesWritten?: Array<{ id?: string; filename?: string }>;
  };
}

interface Task {
  id: string;
  name: string;
  enabled: boolean;
  schedule?: { cron?: string; timezone?: string; at?: string };
  nextRunAt?: string;
  onceDone?: unknown;
  disabledReason?: string;
}

function tasksOf(client: ParityClient, caller: Caller, ws: string) {
  const call = (tool: string, args: Record<string, unknown>) =>
    client.tool(caller, ws, `tasks__${tool}`, args);
  const ended = (r: RunResult) => !["queued", "running"].includes(r.run?.execution ?? "queued");
  return {
    call,
    async runResult(runId: string): Promise<RunResult> {
      return structured<RunResult>(await call("run_result", { runId }));
    },
    // Past the run worker's 30-second due interval, so a run that waits for it
    // still ends here; the first-run delay has its own check (`tasks.new-workspace`).
    async waitRun(runId: string, timeoutMs = 45_000): Promise<RunResult> {
      return until(
        async () => structured<RunResult>(await call("run_result", { runId })),
        ended,
        `run ${runId}`,
        timeoutMs,
      );
    },
    async runNow(taskId: string): Promise<{ runId: string; raw: unknown }> {
      const r = await call("run", { taskId });
      // next/engine answers `{runId, taskId}`; main may answer a quick run's whole record.
      const out = structured<{ runId?: string; run?: { id?: string } }>(r);
      const runId = out.runId ?? out.run?.id;
      if (r.isError || !runId) throw new Mismatch("run answered no runId", textOf(r));
      return { runId, raw: out };
    },
  };
}

/** The wall-clock hour and minute of `iso` in `timeZone`. */
function clockIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/**
 * The error code of a failed tool answer: the plugin's `{code, error}`, or the
 * host's own refusal before the tool runs (`{error: "<code>", message}`).
 */
function codeOf(r: {
  content?: Array<{ text?: string }>;
  structuredContent?: Record<string, unknown>;
}): string {
  const body = structured<{ code?: string; error?: string }>(r);
  if (body.code) return body.code;
  if (body.error && /^[a-z_]+$/.test(body.error)) return body.error;
  return textOf(r).slice(0, 160);
}

export const tasksAuthoring: Scenario = {
  id: "tasks.authoring",
  title: "Create from chat with the person's timezone; cron without one; a past once",
  covers: ["TSK-01", "TSK-25", "TSK-26", "TSK-27", "TSK-29", "TSK-06", "TSK-04", "TSK-03"],
  requires: ["scripted-model"],
  async run(t) {
    // The timezone is the person's, outside any workspace: put it back however
    // the scenario ends. An unset one is written back as "", which reads as unset.
    const before = (await t.client.bootstrap(t.alice)).user.preferences?.timezone ?? "";
    await t.client.tool(t.alice, t.ws, "nb__set_preferences", { timezone: TIMEZONE });
    try {
      await authoring(t);
    } finally {
      await t.client.tool(t.alice, t.ws, "nb__set_preferences", { timezone: before });
    }
  },
};

async function authoring(t: ScenarioContext): Promise<void> {
  const tasks = tasksOf(t.client, t.alice, t.ws);
  const name = `Parity Morning ${Date.now().toString(36)}`;
  const turn = await t.client.turn(t.alice, t.ws, {
    message: `schedule it ${directive({
      steps: [
        [
          {
            tool: "tasks__create",
            args: {
              manifest: {
                name,
                schedule: { cron: "0 8 * * *", timezone: "{{timezone}}" },
                allowedTools: ["files__*"],
              },
              body: "Summarize my files in one line.",
            },
          },
        ],
      ],
      reply: "scheduled",
      echoResults: true,
    })}`,
  });
  const created = turn.done?.toolCalls.filter((c) => c.name === "tasks__create").at(-1);
  const taskId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  await t.check(
    ["TSK-01", "TSK-26"],
    "the model's create, with the timezone from its prompt, schedules the next 08:00 there",
    async () => {
      expect(created?.ok, "tasks__create succeeded in the turn", created);
      const status = structured<{ task: Task; nextRunAt?: string }>(
        await tasks.call("status", { taskId }),
      );
      expectEq(status.task?.schedule?.timezone, TIMEZONE, "the stored timezone");
      const next = status.nextRunAt ?? status.task?.nextRunAt;
      expect(next, "a nextRunAt", status);
      expectEq(clockIn(next, TIMEZONE), "08:00", "08:00 in the zone");
      const ahead = Date.parse(next) - Date.now();
      expect(ahead > 0 && ahead <= 24 * 3600_000, "within the next day", next);
      return { taskId: status.task.id, nextRunAt: next, schedule: status.task.schedule };
    },
  );

  const again = await tasks.call("create", { manifest: { name }, body: "x" });
  await t.check("TSK-01", "a second create of the same name is refused, naming the task", () => {
    expect(again.isError, "refused", textOf(again));
    expect(textOf(again).includes(taskId), "names the existing id", textOf(again));
    return textOf(again).slice(0, 200);
  });

  // Inventory TSK-25 (unknown): errors are `{code, error}` with a closed code.
  await t.check("TSK-25", "the refusal is {code, error} with code task_exists", () => {
    expectEq(codeOf(again), "task_exists", "code");
    return structured(again);
  });

  await t.check(["TSK-06", "TSK-04"], "status and list show the task", async () => {
    const list = structured<{ tasks: Task[] }>(await tasks.call("list", {}));
    expect(
      list.tasks.some((x) => x.id === taskId),
      "listed",
      list.tasks.map((x) => x.id),
    );
    const status = structured<{ task: Task; recentRuns: unknown[] }>(
      await tasks.call("status", { taskId }),
    );
    expect(Array.isArray(status.recentRuns), "recentRuns", status);
    return { listed: list.tasks.length, recentRuns: status.recentRuns.length };
  });

  // Inventory TSK-27 (unknown): the contract requires a timezone with cron.
  await t.check("TSK-27", "a cron without a timezone is refused invalid_input", async () => {
    const r = await tasks.call("create", {
      manifest: { name: `${name} no tz`, schedule: { cron: "0 8 * * *" } },
      body: "x",
    });
    expect(r.isError, "refused", textOf(r));
    expectEq(codeOf(r), "invalid_input", "code");
    return textOf(r).slice(0, 200);
  });

  await t.check("TSK-29", "a once schedule in the past is refused at create", async () => {
    const r = await tasks.call("create", {
      manifest: {
        name: `${name} past`,
        schedule: { at: new Date(Date.now() - 3600_000).toISOString() },
      },
      body: "x",
    });
    expect(r.isError, "refused", { answer: structured(r), text: textOf(r).slice(0, 300) });
    return textOf(r).slice(0, 300);
  });

  await t.check(
    "TSK-03",
    "delete removes the task; deleting a missing one answers deleted:false",
    async () => {
      const del = structured<{ deleted: boolean }>(await tasks.call("delete", { taskId }));
      expectEq(del.deleted, true, "deleted");
      const again = structured<{ deleted: boolean }>(await tasks.call("delete", { taskId }));
      expectEq(again.deleted, false, "a missing task");
      return { del, again };
    },
  );
}

export const tasksRuns: Scenario = {
  id: "tasks.runs",
  title: "Run now, run_result, a run's tools and files, cancel, run while running, once",
  covers: [
    "TSK-07",
    "TSK-11",
    "TSK-15",
    "TSK-34",
    "TSK-36",
    "TSK-37",
    "TSK-44",
    "TSK-49",
    "TSK-50",
    "FI-34",
    "MCP-34",
    "TSK-29",
  ],
  requires: ["scripted-model"],
  async run(t) {
    const tasks = tasksOf(t.client, t.alice, t.ws);
    const stamp = Date.now().toString(36);
    const create = async (name: string, body: string, manifest: Record<string, unknown> = {}) => {
      const r = await tasks.call("create", { manifest: { name, ...manifest }, body });
      const task = structured<{ task?: Task }>(r).task;
      if (r.isError || !task) throw new Mismatch(`create ${name} failed`, textOf(r));
      return task.id;
    };

    const workerId = await create(
      `Parity worker ${stamp}`,
      directive({
        steps: [
          [
            {
              tool: "files__create",
              args: {
                manifest: { filename: `run-${stamp}.md`, mimeType: "text/markdown" },
                body: "from a run",
                encoding: "text",
              },
            },
          ],
          [{ tool: "conversations__list", args: {} }],
          [{ tool: "tasks__create", args: { manifest: { name: "nested" }, body: "x" } }],
          [{ tool: "tasks__cancel", args: { runId: "run_none" } }],
        ],
        reply: "PARITY-RUN-DONE",
        echoResults: true,
      }),
      { allowedTools: ["files__*", "tasks__*"] },
    );

    const { runId, raw } = await tasks.runNow(workerId);
    await t.check("TSK-07", "run answers a run id at once", () => raw);

    const ended = await tasks.waitRun(runId);
    t.note("run", ended);
    await t.check(["TSK-11", "TSK-34"], "run_result gives the ended run with its output", () => {
      expectEq(ended.run.execution, "completed", "execution");
      expect(ended.result?.output.includes("PARITY-RUN-DONE"), "the output", ended.result);
      return { run: ended.run, output: ended.result?.output };
    });

    const log = ended.result?.activityLog ?? [];
    await t.check("TSK-49", "the activity log lists each call in order with ok", () => {
      expect(log.length >= 3, "a row per call", log);
      expectEq(log[0]?.name, "files__create", "first call");
      return log;
    });

    await t.check(["TSK-50", "FI-34"], "the result lists the file the run wrote", () => {
      const files = ended.result?.filesWritten ?? ended.result?.outputFiles ?? [];
      expect(JSON.stringify(files).includes(`run-${stamp}.md`), "the run's file", ended.result);
      return files;
    });

    await t.check("TSK-36", "a tool outside allowedTools is not reachable from the run", () => {
      const row = log.find((r) => r.name === "conversations__list");
      expect(row && row.ok === false, "conversations__list did not run", log);
      return row;
    });

    await t.check("TSK-37", "tasks__create is refused inside the run", () => {
      const nested = log.find((r) => r.name === "tasks__create");
      expect(nested && nested.ok === false, "tasks__create refused", log);
      return nested;
    });

    // Inventory MCP-34 (unknown): main let a run cancel; the contract refuses it.
    await t.check("MCP-34", "tasks__cancel is refused inside the run", () => {
      const cancel = log.find((r) => r.name === "tasks__cancel");
      expect(cancel && cancel.ok === false, "tasks__cancel refused", log);
      return cancel;
    });

    const slowId = await create(
      `Parity slow ${stamp}`,
      directive({ reply: "slow".repeat(20), delayMs: 4000, chunks: 20 }),
    );
    const slow = await tasks.runNow(slowId);
    const slowStarted = until(
      async () => (await tasks.runResult(slow.runId)).run?.execution,
      (e) => e === "running",
      "the slow run to start",
      45_000,
    );

    await t.check("TSK-44", "a run of a task already running is refused conflict", async () => {
      await slowStarted;
      const second = await tasks.call("run", { taskId: slowId });
      expect(second.isError, "refused", structured(second));
      expectEq(codeOf(second), "conflict", "code");
      return textOf(second).slice(0, 200);
    });

    await t.check(
      "TSK-15",
      "cancel ends a running run cancelled; an ended run answers cancelled:false; an unknown id run_not_found",
      async () => {
        await slowStarted;
        const c = structured<{ cancelled: boolean }>(
          await tasks.call("cancel", { runId: slow.runId }),
        );
        expectEq(c.cancelled, true, "cancelled");
        const after = await tasks.waitRun(slow.runId);
        expectEq(after.run.execution, "cancelled", "execution");
        const again = structured<{ cancelled: boolean }>(
          await tasks.call("cancel", { runId: slow.runId }),
        );
        expectEq(again.cancelled, false, "an ended run");
        const unknown = await tasks.call("cancel", { runId: "run_doesnotexist" });
        expectEq(codeOf(unknown), "run_not_found", "unknown id");
        return { cancel: c, execution: after.run.execution, again };
      },
    );

    const onceId = await create(`Parity once ${stamp}`, directive({ reply: "once" }), {
      schedule: { at: new Date(Date.now() + 2500).toISOString() },
    });
    await t.check(
      "TSK-29",
      "a once schedule fires once at its time, then the task is inert",
      async () => {
        const status = await until(
          async () =>
            structured<{ task: Task; recentRuns: Run[] }>(
              await tasks.call("status", { taskId: onceId }),
            ),
          (s) => s.recentRuns.some((r) => !["queued", "running"].includes(r.execution)),
          "the once run",
          30_000,
        );
        const runs = status.recentRuns;
        expectEq(runs.length, 1, "one run");
        expect(runs[0]?.trigger !== "manual", "a scheduled trigger", runs[0]);
        expect(!status.task.nextRunAt, "no next run", status.task);
        return { runs, onceDone: status.task.onceDone, enabled: status.task.enabled };
      },
    );
  },
};

export const tasksBatch: Scenario = {
  id: "tasks.batch",
  title: "A batch with a budget pauses when the budget runs out, with a notice",
  covers: ["TSK-18", "TSK-19", "TSK-21", "TSK-53", "TSK-57"],
  requires: ["scripted-model"],
  async run(t) {
    const tasks = tasksOf(t.client, t.alice, t.ws);
    const name = `Parity bulk ${Date.now().toString(36)}`;
    // Each run makes one model call reporting 200k input tokens: about $0.40.
    const made = await tasks.call("create", {
      manifest: {
        name,
        inputSchema: { type: "object", properties: { i: { type: "number" } }, required: ["i"] },
      },
      body: directive({ reply: "item done", usage: { input: 200_000, output: 10 } }),
    });
    const taskId = structured<{ task?: Task }>(made).task?.id;
    if (!taskId) throw new Mismatch("create failed", textOf(made));

    const started = await tasks.call("run_batch", {
      taskId,
      items: Array.from({ length: 6 }, (_, i) => ({ i })),
      concurrency: 1,
      budgetUsd: 1,
    });
    const batchId = structured<{ batch?: { id: string } }>(started).batch?.id;

    await t.check("TSK-18", "run_batch validates the items and answers the batch", () => {
      expect(!started.isError && batchId, "a batch", textOf(started));
      return structured(started);
    });
    if (!batchId) return;

    const paused = await until(
      async () =>
        structured<{
          batch: { state: string; pause?: { reason: string }; costUsd?: number; done?: number };
        }>(await tasks.call("batch", { batchId })),
      (b) => b.batch?.state === "paused" || b.batch?.state === "completed",
      "the batch to pause",
      60_000,
    );

    await t.check(
      ["TSK-53", "TSK-21"],
      "the batch pauses on its budget before every item ran",
      () => {
        expectEq(paused.batch.state, "paused", "state");
        expectEq(paused.batch.pause?.reason, "budget", "pause reason");
        expect((paused.batch.done ?? 0) < 6, "items left", paused.batch);
        return paused.batch;
      },
    );

    await t.check("TSK-19", "batch rows carry each item's state and cost", async () => {
      const rows = structured<{
        results?: Array<{ index: number; state: string; costUsd?: number; errorCode?: string }>;
      }>(await tasks.call("batch", { batchId, results: true }));
      expect((rows.results?.length ?? 0) === 6, "a row per item", rows);
      return rows.results?.map((r) => ({
        i: r.index,
        state: r.state,
        cost: r.costUsd,
        code: r.errorCode,
      }));
    });

    await t.check("TSK-57", "a batch-paused notice reaches the inbox", async () => {
      const inbox = await until(
        async () =>
          structured<{ items?: Array<{ title?: string; body?: string; id?: string }> }>(
            await t.client.tool(t.alice, t.ws, "notifications__list", {}),
          ),
        (n) => JSON.stringify(n).toLowerCase().includes("pause"),
        "the notice",
        10_000,
      );
      return inbox;
    });

    await t.check("TSK-21", "cancel stops the batch", async () => {
      const r = await tasks.call("batch_control", { batchId, action: "cancel" });
      expect(!r.isError, "cancelled", textOf(r));
      const b = structured<{ batch: { state: string } }>(await tasks.call("batch", { batchId }));
      expectEq(b.batch.state, "cancelled", "state");
      return b.batch.state;
    });
  },
};

export const tasksNewWorkspace: Scenario = {
  id: "tasks.new-workspace",
  title: "Run now in a workspace created since boot starts at once",
  covers: ["TSK-07"],
  requires: ["org-admin", "scripted-model"],
  async run(t) {
    const created = structured<{ id?: string; workspace?: { id: string } }>(
      await t.client.identityTool(t.alice, "nb__manage_workspaces", {
        action: "create",
        name: "Parity fresh",
      }),
    );
    const ws = created.workspace?.id ?? created.id;
    if (!ws) throw new Mismatch("create answered no id", created);
    t.disposable(ws);
    const tasks = tasksOf(t.client, t.alice, ws);
    const made = structured<{ task?: Task }>(
      await tasks.call("create", {
        manifest: { name: "Parity fresh run" },
        body: directive({ reply: "fresh" }),
      }),
    );
    const taskId = made.task?.id;
    if (!taskId) throw new Mismatch("create failed", made);

    await t.check(
      "TSK-07",
      "the first Run now in a new workspace ends within 5 s, as main's runs at once",
      async () => {
        const t0 = Date.now();
        const { runId } = await tasks.runNow(taskId);
        const ended = await tasks.waitRun(runId, 5000).catch(() => null);
        const ms = Date.now() - t0;
        const execution = ended?.run.execution ?? (await tasks.runResult(runId)).run?.execution;
        expect(ended, "ended within 5 s", { ms, execution });
        return { ms, execution };
      },
    );
  },
};
