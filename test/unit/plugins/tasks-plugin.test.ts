/**
 * The tasks plugin (`packages/tasks/`) on what the black-box runner cannot drive: the
 * store's commit point and crash recovery, the failure policy (streak, backoff, grant
 * refusals), once schedules, budget windows, a batch's budget stops, retention's guards,
 * and internal failures carrying no detail of the medium. Calls go through the server's
 * own dispatch (`callTool`), in process, with a host clock the test sets.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError } from "@modelcontextprotocol/server";
import {
  matchesNameGlob,
  scheduleProblem,
  windowEnd,
  windowOf,
} from "../../../packages/tasks/src/schedule.ts";
import { callTool, DEFAULT_RETENTION_MS } from "../../../packages/tasks/src/server.ts";
import { Store } from "../../../packages/tasks/src/store.ts";

const WS = "ws_t1t1t1t1t1t1t1t1";
const OWNER = "usr_tasks";
const GRANT = "grant-opaque-1";
const T0 = Date.parse("2031-03-01T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let store: Store;
let token = 1;

/** A tool's answer, read loosely: each was checked against its contract schema. */
// biome-ignore lint/suspicious/noExplicitAny: answers are read field by field in assertions
type Answer = Record<string, any>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-plugin-"));
  store = new Store(dir);
  token = 1;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ text: string }>;
};

async function call(
  tool: string,
  args: Record<string, unknown>,
  principal: "host" | "person" = "person",
) {
  const ctx =
    principal === "host"
      ? { principal, workspaceId: WS }
      : { principal, workspaceId: WS, ownerId: OWNER, grant: GRANT };
  return (await callTool({ store }, tool, args, ctx)) as Result;
}

async function ok(
  tool: string,
  args: Record<string, unknown>,
  principal: "host" | "person" = "person",
) {
  const r = await call(tool, args, principal);
  if (r.isError) throw new Error(`${tool}: ${r.content[0]?.text}`);
  return r.structuredContent as Answer;
}

const due = (now: number, until = now) =>
  ok("due", { version: "1.0", now: iso(now), until: iso(until) }, "host");

async function begin(ref: string, now: number) {
  return ok(
    "begin_run",
    { version: "1.0", ref, attempt: 1, token: token++, now: iso(now) },
    "host",
  );
}

function outcome(start: number, extra: Record<string, unknown> = {}) {
  return {
    startedAt: iso(start),
    endedAt: iso(start + MIN),
    output: "done",
    stopReason: "complete",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0.01,
    toolCalls: [],
    filesWritten: [],
    ...extra,
  };
}

async function end(begun: Answer, out: Record<string, unknown>) {
  const t = Number(begun.__token ?? token - 1);
  return ok("end_run", { version: "1.0", runId: begun.runId, token: t, outcome: out }, "host");
}

/** Run a requested run of `taskId` through due, begin and end; the end's answer. */
async function runOnce(taskId: string, now: number, out: Record<string, unknown>) {
  const { runId } = await ok("run", { taskId });
  const listed = (await due(now)).occurrences.find((o: { ref: string }) => o.ref === `r:${runId}`);
  const begun = await begin(listed.ref, now);
  return end(begun, out);
}

const failed = (start: number, transient = false) =>
  outcome(start, { output: "", stopReason: "error", error: { code: "model_error", transient } });

describe("the store", () => {
  test("a call that fails keeps nothing it changed", async () => {
    await ok("create", { manifest: { name: "Keep" }, body: "p" });
    const again = await call("create", { manifest: { name: "Keep" }, body: "p" });
    expect(JSON.parse(again.content[0]!.text).code).toBe("task_exists");
    const listed = await ok("list", {});
    expect(listed.tasks.map((t: { id: string }) => t.id)).toEqual(["keep"]);
  });

  const wsDir = () => join(dir, "workspaces", WS);
  const logOf = () => {
    const files = readdirSync(wsDir()).filter((f) => /^runs(-\d+)?\.jsonl$/.test(f));
    expect(files).toHaveLength(1);
    return join(wsDir(), files[0] as string);
  };

  test("a torn tail, a restart, another run, a restart: both committed runs are there", async () => {
    await ok("create", { manifest: { name: "Torn" }, body: "p" });
    await runOnce("torn", T0, outcome(T0));
    appendFileSync(logOf(), '{"id":"run_half');
    store = new Store(dir);
    await runOnce("torn", T0 + HOUR, outcome(T0 + HOUR));
    store = new Store(dir);
    expect((await ok("runs", { taskId: "torn" })).runs).toHaveLength(2);
  });

  test("an append whose commit never landed is gone after a restart, and the retry records one", async () => {
    await ok("create", { manifest: { name: "Late", schedule: { at: iso(T0) } }, body: "p" });
    await ok("list", {});
    const committed = readFileSync(join(wsDir(), "state.json"), "utf-8");
    // The due that finds the once missed appends its skipped run; the crash comes before
    // state.json is replaced, so the previous state is what the disk holds.
    await due(T0 + 2 * HOUR);
    writeFileSync(join(wsDir(), "state.json"), committed);
    store = new Store(dir);
    expect((await ok("status", { taskId: "late" })).recentRuns).toEqual([]);
    await due(T0 + 2 * HOUR);
    store = new Store(dir);
    const { recentRuns } = await ok("status", { taskId: "late", limit: 50 });
    expect(recentRuns.map((r: Answer) => r.execution)).toEqual(["skipped"]);
  });

  test("a compaction is committed by the state that names its log", async () => {
    await ok("create", { manifest: { name: "Old" }, body: "p" });
    await runOnce("old", T0, outcome(T0));
    const before = logOf();
    await due(T0 + 100 * 365 * 24 * HOUR);
    expect(logOf()).not.toBe(before);
    store = new Store(dir);
    expect((await ok("runs", { taskId: "old" })).runs).toEqual([]);
  });

  test("a blob no record names is removed on load", async () => {
    await ok("create", { manifest: { name: "Orphan" }, body: "p" });
    const blob = join(dir, "workspaces", WS, "blobs", "input-run_000000000000.json");
    mkdirSync(join(dir, "workspaces", WS, "blobs"), { recursive: true });
    writeFileSync(blob, "{}");
    store = new Store(dir);
    await ok("list", {});
    expect(existsSync(blob)).toBe(false);
  });
});

describe("allowedTools that name only tools a run can never call", () => {
  const refusal = async (tool: string, args: Record<string, unknown>) => {
    const r = await call(tool, args);
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0]?.text ?? "{}") as { code: string; error: string };
  };

  test("create refuses them with invalid_input, naming each and why", async () => {
    const body = await refusal("create", {
      manifest: { name: "Loop", allowedTools: ["gmail__*", "tasks__create", "tasks__cancel"] },
      body: "p",
    });
    expect(body.code).toBe("invalid_input");
    expect(body.error).toContain('"tasks__create", "tasks__cancel"');
    expect(body.error).toContain("runs cannot create, edit, delete, run or cancel scheduled tasks");
    expect(body.error).not.toContain("gmail__*");
    expect((await ok("list", { kind: "all" })).tasks).toEqual([]);
  });

  test("a glob that reaches only refused tools is refused; one that reaches a read is kept", async () => {
    expect(
      (
        await refusal("create", {
          manifest: { name: "B", allowedTools: ["tasks__batch_*"] },
          body: "p",
        })
      ).code,
    ).toBe("invalid_input");
    const kept = ["tasks__*", "tasks__run*", "other__create", "create", "tasks__nothing"];
    const saved = await ok("create", {
      manifest: { name: "Reads", allowedTools: kept },
      body: "p",
    });
    expect(saved.task.allowedTools).toEqual(kept);
  });

  test("update checks the list it is given, so a task saved earlier still changes", async () => {
    await ok("create", { manifest: { name: "Digest", allowedTools: ["tasks__list"] }, body: "p" });
    const body = await refusal("update", {
      taskId: "digest",
      manifest: { allowedTools: ["tasks__update"] },
    });
    expect(body.code).toBe("invalid_input");
    expect((await ok("status", { taskId: "digest" })).task.allowedTools).toEqual(["tasks__list"]);
    await ok("update", { taskId: "digest", manifest: { enabled: false } });
  });

  test("an inline one-off is refused the same way", async () => {
    const body = await refusal("run", {
      definition: { manifest: { name: "Once", allowedTools: ["tasks__run"] }, body: "p" },
    });
    expect(body.code).toBe("invalid_input");
  });
});

describe("a run's tool failures", () => {
  test("keep each tool's last failure reason on the run and in stats", async () => {
    await ok("create", { manifest: { name: "Author" }, body: "p" });
    await runOnce(
      "author",
      T0,
      outcome(T0, {
        toolCalls: [
          { name: "tasks__create", ok: false, errorReason: "denied", ms: 1 },
          { name: "gmail__send", ok: false, errorReason: "timeout", ms: 1 },
          { name: "gmail__send", ok: false, errorReason: "tool_error", ms: 1 },
          { name: "files__read", ok: false, errorReason: "tool_error", ms: 1 },
          { name: "files__read", ok: true, ms: 1 },
        ],
      }),
    );
    const [run] = (await ok("runs", { taskId: "author" })).runs;
    expect(run.label).toBe("Needs review");
    expect(run.toolFailures).toEqual([
      { name: "tasks__create", errorReason: "denied" },
      { name: "gmail__send", errorReason: "tool_error" },
    ]);
    const stats = (await ok("stats", {})).tasks[0];
    expect(stats.recent[0].toolFailures).toEqual(run.toolFailures);
  });
});

describe("the failure policy", () => {
  test("the first failure of a stretch notifies once; a success ends the stretch", async () => {
    await ok("create", { manifest: { name: "Flaky" }, body: "p" });
    expect(
      (await runOnce("flaky", T0, failed(T0))).notices.map((n: { id: string }) => n.id)[0],
    ).toMatch(/^run-failed:/);
    expect((await runOnce("flaky", T0 + HOUR, failed(T0 + HOUR))).notices).toEqual([]);
    await runOnce("flaky", T0 + 2 * HOUR, outcome(T0 + 2 * HOUR));
    expect((await runOnce("flaky", T0 + 3 * HOUR, failed(T0 + 3 * HOUR))).notices).toHaveLength(1);
  });

  test("ten non-transient failures in a streak disable the task, with a notice", async () => {
    await ok("create", { manifest: { name: "Broken" }, body: "p" });
    let last: Answer = {};
    for (let i = 0; i < 10; i++)
      last = await runOnce("broken", T0 + i * HOUR, failed(T0 + i * HOUR));
    expect(last.notices.map((n: { id: string }) => n.id)[0]).toMatch(/^task-disabled:/);
    const { task } = await ok("status", { taskId: "broken" });
    expect(task.enabled).toBe(false);
  });

  test("transient failures back off but do not disable at ten", async () => {
    await ok("create", { manifest: { name: "Outage" }, body: "p" });
    for (let i = 0; i < 12; i++)
      await runOnce("outage", T0 + i * HOUR, failed(T0 + i * HOUR, true));
    expect((await ok("status", { taskId: "outage" })).task.enabled).toBe(true);
  });

  test("grant_invalid disables the definition at once; a grant-marked update re-enables it", async () => {
    await ok("create", { manifest: { name: "Signed" }, body: "p" });
    const answer = await runOnce(
      "signed",
      T0,
      outcome(T0, {
        output: "",
        stopReason: "not_started",
        error: { code: "grant_invalid", transient: false },
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
      }),
    );
    expect(answer.notices[0].id).toMatch(/^task-disabled:/);
    expect(JSON.stringify(answer.notices)).not.toContain("Signed");
    expect((await ok("status", { taskId: "signed" })).task.enabled).toBe(false);
    expect(
      (await ok("update", { taskId: "signed", manifest: { enabled: true } })).task.enabled,
    ).toBe(true);
  });

  test("exclusive_busy never counts toward the streak", async () => {
    await ok("create", { manifest: { name: "Busy" }, body: "p" });
    for (let i = 0; i < 12; i++) {
      await runOnce(
        "busy",
        T0 + i * HOUR,
        outcome(T0 + i * HOUR, {
          output: "",
          stopReason: "not_started",
          error: { code: "exclusive_busy", transient: true },
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
        }),
      );
    }
    const { task } = await ok("status", { taskId: "busy" });
    expect([task.enabled, task.consecutiveErrors]).toEqual([true, 0]);
  });
});

describe("schedules", () => {
  test("an interval fires at due's now, then the interval after its run's start; a failure backs off", async () => {
    await ok("create", { manifest: { name: "Tick", schedule: { intervalMs: HOUR } }, body: "p" });
    const first = (await due(T0)).occurrences[0];
    expect(first.notBefore).toBe(iso(T0));
    const begun = await begin(first.ref, T0);
    await end(begun, outcome(T0));
    const next = (await due(T0 + 2 * HOUR)).occurrences[0];
    expect(next.notBefore).toBe(iso(T0 + HOUR));
    await end(await begin(next.ref, T0 + 2 * HOUR), failed(T0 + 2 * HOUR));
    const backedOff = (await due(T0 + 10 * HOUR, T0 + 10 * HOUR)).occurrences[0];
    // The streak's backoff (30 s) is shorter than the interval, so the interval wins.
    expect(Date.parse(backedOff.notBefore)).toBe(T0 + 3 * HOUR);
  });

  test("a once that ran is retired; one past its grace at due's now is missed and recorded skipped", async () => {
    await ok("create", { manifest: { name: "Once", schedule: { at: iso(T0 + HOUR) } }, body: "p" });
    const occ = (await due(T0, T0 + HOUR)).occurrences[0];
    await end(await begin(occ.ref, T0 + HOUR), outcome(T0 + HOUR));
    const ran = (await ok("status", { taskId: "once" })).task;
    expect([ran.enabled, ran.onceDone.outcome]).toEqual([false, "ran"]);

    await ok("create", { manifest: { name: "Late", schedule: { at: iso(T0) } }, body: "p" });
    expect((await due(T0 + 2 * HOUR)).occurrences.map((o: { ref: string }) => o.ref)).toEqual([]);
    const late = await ok("status", { taskId: "late" });
    expect(late.task.onceDone.outcome).toBe("missed");
    expect(late.recentRuns[0].execution).toBe("skipped");
  });

  test("schedule checks need no clock", () => {
    expect(scheduleProblem({ cron: "0 9 31 2 *", timezone: "UTC" })).toMatch(/matches no date/);
    expect(scheduleProblem({ cron: "0 9 * * *", timezone: "Mars/Olympus" })).toMatch(/timezone/);
    expect(scheduleProblem({ cron: "0 9 * * *", timezone: "Pacific/Honolulu" })).toBeNull();
  });

  test("event names match by dotted glob", () => {
    expect(matchesNameGlob("domain.active", "domain.*")).toBe(true);
    expect(matchesNameGlob("domain.dns.ready", "domain.*")).toBe(false);
    expect(matchesNameGlob("domain.dns.ready", "domain.**")).toBe(true);
    expect(matchesNameGlob("x".repeat(200), "*a*a*a*a*a")).toBe(false);
  });
});

describe("token budgets", () => {
  test("windows are UTC calendar days and months", () => {
    const at = Date.parse("2031-03-31T23:30:00-10:00"); // 2031-04-01 09:30 UTC
    expect(windowOf({ period: "daily" }, at)).toBe("2031-04-01");
    expect(windowOf({ period: "monthly" }, at)).toBe("2031-04");
    expect(windowOf(undefined, at)).toBe("lifetime");
    expect(windowEnd("2031-04")).toBe("2031-05-01T00:00:00.000Z");
  });

  test("a spent window disables the task, refuses its runs, and opens again the next UTC day", async () => {
    await ok("create", {
      manifest: { name: "Thrifty", tokenBudget: { maxOutputTokens: 5, period: "daily" } },
      body: "p",
    });
    const answer = await runOnce("thrifty", T0, outcome(T0));
    expect(answer.notices[0].id).toMatch(/^task-disabled:/);
    const { runId } = await ok("run", { taskId: "thrifty" });
    const refused = await begin(`r:${runId}`, T0 + HOUR);
    expect(refused.decision).toBe("skip");
    const next = await ok("run", { taskId: "thrifty" });
    const begun = await begin(`r:${next.runId}`, T0 + 25 * HOUR);
    expect(begun.decision).toBe("run");
    expect(begun.work.spendAccounts[0].remaining).toBe(5);
  });
});

describe("a batch's budget stops", () => {
  const spend = (
    start: number,
    accountId: string,
    stop: "exhausted" | "reserved",
    cost: number,
    tokens = 10,
  ) =>
    outcome(start, {
      output: "",
      stopReason: "spend_limit",
      spendAccountId: accountId,
      spendStop: stop,
      costUsd: cost,
      usage: { inputTokens: tokens, outputTokens: 0 },
      error: { code: "spend_limit", transient: false },
    });

  async function startBatch(items: number, concurrency: number, budgetUsd: number) {
    await ok("create", { manifest: { name: "Bulk" }, body: "p" });
    const { batch } = await ok("run_batch", {
      taskId: "bulk",
      items: Array.from({ length: items }, (_, i) => ({ i })),
      concurrency,
      budgetUsd,
    });
    return batch.id as string;
  }

  async function beginAll(now: number) {
    const begun = [];
    for (const occ of (await due(now)).occurrences)
      begun.push({ ...(await begin(occ.ref, now)), __token: token - 1 });
    return begun;
  }

  test("a run sharing the budget that is stopped after a call halves the sharing and goes back to pending", async () => {
    const batchId = await startBatch(4, 4, 1);
    const [first] = await beginAll(T0);
    await end(first, spend(T0, `task-batch:${batchId}`, "exhausted", 0.1));
    const { batch } = await ok("batch", { batchId });
    expect(batch.sharing).toBe(2);
    expect(batch.counts.pending).toBe(1);
  });

  test("a run holding the whole of what was left, stopped exhausted after a call, settles exceeds_share", async () => {
    const batchId = await startBatch(3, 1, 1);
    const [first] = await beginAll(T0);
    await end(first, outcome(T0, { costUsd: 0.1 }));
    const [second] = await beginAll(T0 + HOUR);
    await end(second, spend(T0 + HOUR, `task-batch:${batchId}`, "exhausted", 0.5));
    const page = await ok("batch", { batchId, results: true });
    expect(page.results[1].errorCode).toBe("exceeds_share");
    expect(page.batch.state).toBe("running");
  });

  test("a stop with nothing left pauses the batch with a notice naming no task content", async () => {
    const batchId = await startBatch(3, 1, 1);
    const [first] = await beginAll(T0);
    const answer = await end(first, spend(T0, `task-batch:${batchId}`, "exhausted", 1, 0));
    expect(answer.notices[0].id).toMatch(/^batch-paused:/);
    expect(JSON.stringify(answer.notices)).not.toContain("Bulk");
    const { batch } = await ok("batch", { batchId });
    expect([batch.state, batch.pause.reason, batch.counts.pending]).toEqual([
      "paused",
      "budget",
      3,
    ]);
  });

  test("a reserved stop puts the item back and waits for another run of the batch to end", async () => {
    const batchId = await startBatch(3, 2, 1);
    const [a, b] = await beginAll(T0);
    await end(a, spend(T0, `task-batch:${batchId}`, "reserved", 0, 0));
    expect((await due(T0)).occurrences).toEqual([]);
    await end(b, outcome(T0, { costUsd: 0.1 }));
    expect((await due(T0)).occurrences.length).toBeGreaterThan(0);
  });
});

describe("retention", () => {
  test("never removes a run of a batch that is not settled", async () => {
    await ok("create", { manifest: { name: "Held" }, body: "p" });
    const { batch } = await ok("run_batch", { taskId: "held", items: [1, 2], concurrency: 1 });
    const [occ] = (await due(T0)).occurrences;
    const begun = await begin(occ.ref, T0);
    await end(begun, outcome(T0));
    await ok("batch_control", { batchId: batch.id, action: "pause" });
    await due(T0 + 100 * 365 * 24 * HOUR);
    expect((await ok("run_result", { runId: begun.runId })).run.id).toBe(begun.runId);
    expect(DEFAULT_RETENTION_MS).toBe(180 * 24 * HOUR);
  });
});

describe("an internal failure", () => {
  let logged: string[] = [];
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  test("answers without the medium's detail; the log has it", async () => {
    // The workspace directory is a file, so nothing can be stored under it.
    mkdirSync(join(dir, "workspaces"), { recursive: true });
    writeFileSync(join(dir, "workspaces", WS), "not a directory");
    logged = [];
    spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    const priv = await call("due", { version: "1.0", now: iso(T0), until: iso(T0) }, "host");
    expect(JSON.parse(priv.content[0]!.text).code).toBe("internal_error");
    expect(priv.content[0]!.text).not.toContain(dir);
    let thrown: unknown;
    try {
      await call("create", { manifest: { name: "X" }, body: "p" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as Error).message).not.toContain(dir);
    expect(logged.join("")).toContain(dir);
  });
});
