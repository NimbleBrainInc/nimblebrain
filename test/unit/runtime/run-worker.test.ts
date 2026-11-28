import { afterEach, describe, expect, it, jest } from "bun:test";
import type { Claim, EnqueueRequest, WorkQueue } from "../../../src/providers/queue/types.ts";
import { createRunAdmission } from "../../../src/runtime/admission.ts";
import { createRunGrants, newRunGrantKey } from "../../../src/runtime/run-grant.ts";
import {
  createRunWorker,
  RUN_ITEM_KIND,
  type RunOutcome,
  type RunWorker,
  TASKS_CONTRACT,
  type TasksServer,
} from "../../../src/runtime/run-worker.ts";
import { createSpendBalances } from "../../../src/runtime/spend.ts";
import type { TaskRequest, TaskResult } from "../../../src/runtime/types.ts";
import { emptyUsage } from "../../../src/usage/types.ts";

const WS = "ws-a";
const OWNER = "user-a";

/** An in-memory work queue: any pending item is claimable at once; settles are recorded. */
function fakeQueue() {
  interface Item {
    id: string;
    payload: unknown;
    token: number;
    attempt: number;
    state: "pending" | "claimed" | "done";
  }
  const items: Item[] = [];
  const completed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let next = 0;
  const queue: WorkQueue = {
    multiProcess: false,
    async enqueue(item: EnqueueRequest) {
      const id = `item-${++next}`;
      items.push({ id, payload: item.payload, token: 0, attempt: 0, state: "pending" });
      return { id, created: true };
    },
    async claim() {
      const item = items.find((i) => i.state === "pending");
      if (!item) return null;
      item.state = "claimed";
      item.attempt++;
      item.token++;
      return {
        id: item.id,
        kind: RUN_ITEM_KIND,
        payload: item.payload,
        attempt: item.attempt,
        token: item.token,
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async extend(claim: Claim) {
      return claim;
    },
    async complete(claim: Claim) {
      const item = items.find((i) => i.id === claim.id);
      if (item) item.state = "done";
      completed.push(claim.id);
    },
    async fail(claim: Claim, options) {
      const item = items.find((i) => i.id === claim.id);
      if (item) item.state = options.retryAt ? "pending" : "done";
      failed.push({ id: claim.id, error: options.error });
    },
    async close() {},
  };
  const add = (ref: string) =>
    queue.enqueue({
      scope: WS,
      kind: RUN_ITEM_KIND,
      payload: { workspaceId: WS, ref },
      idempotencyKey: ref,
    });
  return { queue, completed, failed, add };
}

function taskResult(runId: string): TaskResult {
  return {
    output: "done",
    runId,
    toolCalls: [],
    stopReason: "complete",
    usage: { ...emptyUsage(), model: "test", llmMs: 0, iterations: 1 },
    costUsd: 0,
    filesWritten: [],
  };
}

type Handler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A worker over a fake tasks server whose private calls the test answers. */
function harness(
  handlers: { begin_run: Handler; end_run?: Handler },
  opts: {
    isMember?: () => Promise<boolean>;
    execute?: (request: TaskRequest) => Promise<TaskResult>;
  } = {},
) {
  const grants = createRunGrants(newRunGrantKey());
  const grant = grants.sign({ contract: TASKS_CONTRACT, workspaceId: WS, ownerId: OWNER });
  const spend = createSpendBalances();
  const q = fakeQueue();
  const ends: Array<{ runId: string; outcome: RunOutcome }> = [];
  const server: TasksServer = {
    hostVersion: "1.0",
    async call(tool, args) {
      if (tool === "due") return { occurrences: [], cancel: [], nextCursor: null };
      if (tool === "begin_run") return handlers.begin_run(args);
      if (tool === "end_run") {
        ends.push({ runId: args.runId as string, outcome: args.outcome as RunOutcome });
        return handlers.end_run ? handlers.end_run(args) : { notices: [] };
      }
      throw new Error(`unexpected call ${tool}`);
    },
    async watch() {
      return null;
    },
    connection: () => null,
    onResourceUpdated: () => () => {},
  };
  const worker = createRunWorker({
    server,
    queue: q.queue,
    admission: createRunAdmission({ maxConcurrentRuns: 4, maxQueuedRuns: 0 }),
    spend,
    grants,
    execute: opts.execute ?? (async (request) => taskResult(request.runId ?? "run")),
    limitsOf: () => ({ maxIterations: 5, maxRunDurationMs: 600_000 }),
    isMember: opts.isMember ?? (async () => true),
    workspaceIds: async () => [WS],
    onWorkspaceCreated: () => () => {},
    deliver: () => {},
    ended: () => {},
    metered: () => undefined,
    workerId: "worker-test",
  });
  return { worker, grant, spend, ends, ...q };
}

/** Let every pending microtask (and the fake queue's promises) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** Advance fake time in steps, flushing between them. */
async function advance(ms: number, step = 500): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    jest.advanceTimersByTime(step);
    await flush();
  }
}

/** A transport failure, as a bound server's call rejects when its connection drops. */
const transportDown: Handler = async () => {
  throw new Error("connection closed");
};

let current: RunWorker | null = null;
let faked = false;
function useFakeTimers(): void {
  jest.useFakeTimers();
  faked = true;
}
afterEach(async () => {
  const stopping = current?.stop();
  // Under fake time the worker's retry waits and shutdown grace only pass when time does.
  if (faked) await advance(30_000);
  await stopping;
  jest.useRealTimers();
  faked = false;
  current = null;
});

describe("run worker — exclusive keys", () => {
  it("two runs of one key whose membership checks resolve together: one runs, one is refused busy", async () => {
    const members: Array<(v: boolean) => void> = [];
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const h = harness(
      {
        begin_run: async (args) => ({
          decision: "run",
          runId: `run-${args.ref as string}`,
          grant: h.grant,
          work: { kind: "agent", prompt: "go", exclusiveKey: "k" },
        }),
      },
      {
        isMember: () => new Promise<boolean>((resolve) => members.push(resolve)),
        execute: async (request) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight--;
          return taskResult(request.runId ?? "run");
        },
      },
    );
    current = h.worker;
    await h.add("r:a");
    await h.add("r:b");
    await h.worker.start();
    await flush();
    expect(members.length).toBe(2);
    for (const resolve of members) resolve(true);
    await flush();
    const peakWhileHeld = peak;
    for (const release of releases) release();
    await flush();
    expect(peakWhileHeld).toBe(1);
    expect(h.ends.filter((e) => e.outcome.error?.code === "exclusive_busy").length).toBe(1);
  });
});

describe("run worker — an end that is not acknowledged", () => {
  it("an interrupted skip whose end_run keeps failing leaves the item to be claimed again, never completed", async () => {
    useFakeTimers();
    let endDown = true;
    const h = harness({
      begin_run: async () => ({
        decision: "skip",
        reason: "an earlier claim received this run",
        interrupted: { runId: "run-old", token: 1 },
      }),
      end_run: async (args) => (endDown ? transportDown(args) : { notices: [] }),
    });
    current = h.worker;
    await h.add("r:a");
    await h.worker.start();
    await advance(25_000);
    expect(h.ends.length).toBeGreaterThanOrEqual(4);
    expect(h.completed).toEqual([]);
    expect(h.failed.length).toBeGreaterThanOrEqual(1);
    endDown = false;
    await advance(25_000);
    expect(h.completed).toEqual(["item-1"]);
    expect(h.ends.at(-1)?.outcome.error?.code).toBe("interrupted");
  });

  it("refused work whose end_run keeps failing leaves the item to be claimed again, never completed", async () => {
    useFakeTimers();
    let endDown = true;
    const h = harness({
      begin_run: async () => ({
        decision: "run",
        runId: "run-a",
        grant: h.grant,
        work: { kind: "unknown", prompt: "go" },
      }),
      end_run: async (args) => (endDown ? transportDown(args) : { notices: [] }),
    });
    current = h.worker;
    await h.add("r:a");
    await h.worker.start();
    await advance(25_000);
    expect(h.ends.length).toBeGreaterThanOrEqual(4);
    expect(h.ends[0]?.outcome.error?.code).toBe("work_invalid");
    expect(h.completed).toEqual([]);
    endDown = false;
    await advance(25_000);
    expect(h.completed).toEqual(["item-1"]);
  });

  it("a sibling run opening the same account during recovery draws on the live balance the first run spent", async () => {
    useFakeTimers();
    const account = { id: "acct", unit: "input_tokens" as const, remaining: 10 };
    let siblingSaw: number | undefined;
    let recovered = false;
    const h = harness(
      {
        begin_run: async (args) => {
          if (args.ref === "r:b") {
            return {
              decision: "run",
              runId: "run-b",
              grant: h.grant,
              work: { kind: "agent", prompt: "go", spendAccounts: [account] },
            };
          }
          // The first claim receives run-a; every later claim reports it interrupted.
          return (args.attempt as number) === 1
            ? {
                decision: "run",
                runId: "run-a",
                grant: h.grant,
                work: { kind: "agent", prompt: "go", spendAccounts: [account] },
              }
            : {
                decision: "skip",
                reason: "an earlier claim received this run",
                interrupted: { runId: "run-a", token: 1 },
              };
        },
        end_run: async (args) =>
          args.runId === "run-a" && !recovered ? transportDown(args) : { notices: [] },
      },
      {
        execute: async (request) => {
          const hold = h.spend.open(request.spendAccounts ?? [], { model: "", rates: null });
          if (request.runId === "run-b") siblingSaw = h.spend.balance("acct");
          else hold.debit({ ...emptyUsage(), inputTokens: 4 });
          hold.release();
          return taskResult(request.runId ?? "run");
        },
      },
    );
    current = h.worker;
    await h.add("r:a");
    await h.worker.start();
    // run-a ran, spent 4, and its end was never acknowledged.
    await advance(25_000);
    expect(h.completed).toEqual([]);
    expect(h.spend.balance("acct")).toBe(6);
    await h.add("r:b");
    await advance(6_000);
    expect(siblingSaw).toBe(6);
    // Recovery lands: run-a's anchor is released with its end.
    recovered = true;
    await advance(25_000);
    expect(h.completed).toContain("item-1");
    expect(h.spend.balance("acct")).toBeUndefined();
  });
});
