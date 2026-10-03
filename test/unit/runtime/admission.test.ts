import { describe, expect, it } from "bun:test";
import {
  type AdmissionLease,
  type AdmissionWaiter,
  type AdmissionWithdrawal,
  createRunAdmission,
  RunAdmissionRefusedError,
} from "../../../src/runtime/admission.ts";
import type { RunSpec } from "../../../src/runtime/run-spec.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { TaskRequest } from "../../../src/runtime/types.ts";

/** A waiter that records how its run left the queue. */
function recorder(log: string[], name: string) {
  const out: { lease?: AdmissionLease; withdrawn?: AdmissionWithdrawal } = {};
  const waiter: AdmissionWaiter = {
    admitted: (lease) => {
      out.lease = lease;
      log.push(name);
    },
    withdrawn: (reason) => {
      out.withdrawn = reason;
    },
  };
  return { waiter, out };
}

function admitted(ticket: ReturnType<ReturnType<typeof createRunAdmission>["request"]>) {
  if (ticket.state !== "admitted") throw new Error(`expected admitted, got ${ticket.state}`);
  return ticket.lease;
}

describe("run admission — slots and queue", () => {
  it("admits up to the slot limit, then queues in arrival order", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 2, maxQueuedRuns: 5 });
    const started: string[] = [];
    const a = admitted(pool.request({ workspaceId: "ws-a" }));
    admitted(pool.request({ workspaceId: "ws-a" }));
    expect(pool.inFlight()).toBe(2);

    const c = recorder(started, "c");
    const d = recorder(started, "d");
    expect(pool.request({ workspaceId: "ws-a" }, c.waiter)).toEqual({
      state: "queued",
      position: 1,
    });
    expect(pool.request({ workspaceId: "ws-a" }, d.waiter)).toEqual({
      state: "queued",
      position: 2,
    });

    a.release();
    expect(started).toEqual(["c"]);
    c.out.lease!.release();
    expect(started).toEqual(["c", "d"]);
    expect(pool.queued()).toEqual([]);
  });

  it("release is idempotent", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a" }));
    lease.release();
    lease.release();
    expect(pool.inFlight()).toBe(0);
    admitted(pool.request({ workspaceId: "ws-a" }));
    expect(pool.inFlight()).toBe(1);
  });

  it("refuses beyond the queue bound, and at 0 refuses at the limit", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 1 });
    admitted(pool.request({ workspaceId: "ws-a" }));
    expect(pool.request({ workspaceId: "ws-a" }, recorder([], "b").waiter).state).toBe("queued");
    expect(pool.request({ workspaceId: "ws-a" }, recorder([], "c").waiter)).toEqual({
      state: "refused",
      reason: "queue_full",
    });

    const none = createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 0 });
    admitted(none.request({ workspaceId: "ws-a" }));
    expect(none.request({ workspaceId: "ws-a" }, recorder([], "b").waiter)).toEqual({
      state: "refused",
      reason: "queue_full",
    });
  });

  it("without a waiter, never queues: busy at the limit, and busy while runs wait", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a" }));
    expect(pool.request({ workspaceId: "ws-a" })).toEqual({ state: "refused", reason: "busy" });
    expect(pool.hasFreeSlot()).toBe(false);
    expect(pool.queued()).toEqual([]);

    // A queued run is owed the next free slot ahead of a caller that did not queue.
    const waiting = recorder([], "w");
    pool.request({ workspaceId: "ws-a" }, waiting.waiter);
    lease.release();
    expect(waiting.out.lease).toBeDefined();
    expect(pool.request({ workspaceId: "ws-b" }).state).toBe("refused");
  });

  it("refuses a duplicate key while it runs or waits, and admits it again after", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a", key: "k1" }));
    expect(pool.isRunning("k1")).toBe(true);
    expect(pool.request({ workspaceId: "ws-a", key: "k1" }, recorder([], "x").waiter)).toEqual({
      state: "refused",
      reason: "running",
    });

    const k2 = recorder([], "k2");
    pool.request({ workspaceId: "ws-a", key: "k2" }, k2.waiter);
    expect(pool.isQueued("k2")).toBe(true);
    expect(pool.request({ workspaceId: "ws-b", key: "k2" }, recorder([], "y").waiter)).toEqual({
      state: "refused",
      reason: "queued",
    });

    lease.release();
    expect(pool.isRunning("k1")).toBe(false);
    expect(pool.isRunning("k2")).toBe(true);
    k2.out.lease!.release();
    expect(admitted(pool.request({ workspaceId: "ws-a", key: "k1" })).key).toBe("k1");
  });

  it("cancel takes a queued run out and tells its waiter, synchronously", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a" }));
    const started: string[] = [];
    const b = recorder(started, "b");
    pool.request({ workspaceId: "ws-a", key: "b" }, b.waiter);

    expect(pool.cancel("b")).toBe(true);
    expect(b.out.withdrawn).toBe("cancelled");
    expect(pool.cancel("b")).toBe(false);
    lease.release();
    expect(started).toEqual([]);
  });

  it("withdraw takes out only the runs it matches, with the given reason", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    admitted(pool.request({ workspaceId: "ws-a" }));
    const a = recorder([], "a");
    const b = recorder([], "b");
    pool.request({ workspaceId: "ws-a", key: "a" }, a.waiter);
    pool.request({ workspaceId: "ws-b", key: "b" }, b.waiter);

    expect(pool.withdraw((e) => e.workspaceId === "ws-a", "workspace_deleted")).toBe(1);
    expect(a.out.withdrawn).toBe("workspace_deleted");
    expect(b.out.withdrawn).toBeUndefined();
    expect(pool.queued().map((e) => e.key)).toEqual(["b"]);
  });

  it("stop withdraws every queued run and refuses later requests", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a" }));
    const b = recorder([], "b");
    pool.request({ workspaceId: "ws-a" }, b.waiter);

    pool.stop();
    expect(b.out.withdrawn).toBe("stopped");
    expect(pool.request({ workspaceId: "ws-a" })).toEqual({ state: "refused", reason: "stopped" });
    // A run that already held a slot still gives it back.
    lease.release();
    expect(pool.inFlight()).toBe(0);
  });

  it("a waiter that throws on admission does not leak its slot", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a" }));
    const started: string[] = [];
    pool.request(
      { workspaceId: "ws-a" },
      {
        admitted: () => {
          throw new Error("boom");
        },
        withdrawn: () => {},
      },
    );
    const next = recorder(started, "next");
    pool.request({ workspaceId: "ws-a" }, next.waiter);

    lease.release();
    expect(started).toEqual(["next"]);
    expect(pool.inFlight()).toBe(1);
  });

  it("a waiter that gives its slot straight back passes it to the next run", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const lease = admitted(pool.request({ workspaceId: "ws-a" }));
    const started: string[] = [];
    pool.request({ workspaceId: "ws-a" }, { admitted: (l) => l.release(), withdrawn: () => {} });
    pool.request({ workspaceId: "ws-a" }, recorder(started, "next").waiter);

    lease.release();
    expect(started).toEqual(["next"]);
    expect(pool.queued()).toEqual([]);
  });
});

describe("run admission — fair share between workspaces", () => {
  it("gives a freed slot to the waiting workspace holding the fewest slots", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 3, maxQueuedRuns: 10 });
    const started: string[] = [];
    // ws-a holds two slots, ws-b one.
    const a1 = admitted(pool.request({ workspaceId: "ws-a" }));
    admitted(pool.request({ workspaceId: "ws-a" }));
    admitted(pool.request({ workspaceId: "ws-b" }));
    // ws-a's run arrives first, then ws-c's, then ws-b's.
    pool.request({ workspaceId: "ws-a" }, recorder(started, "a3").waiter);
    pool.request({ workspaceId: "ws-c" }, recorder(started, "c1").waiter);
    pool.request({ workspaceId: "ws-b" }, recorder(started, "b2").waiter);

    // ws-a frees one: ws-c holds none, so it goes first despite arriving later.
    a1.release();
    expect(started).toEqual(["c1"]);
  });

  it("breaks a tie on slots held by the oldest waiting run", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 3, maxQueuedRuns: 10 });
    const started: string[] = [];
    admitted(pool.request({ workspaceId: "ws-a" }));
    admitted(pool.request({ workspaceId: "ws-b" }));
    const c = admitted(pool.request({ workspaceId: "ws-c" }));
    pool.request({ workspaceId: "ws-b" }, recorder(started, "b2").waiter);
    pool.request({ workspaceId: "ws-a" }, recorder(started, "a2").waiter);

    // ws-a and ws-b each hold one slot: the older waiting run, ws-b's, goes.
    c.release();
    expect(started).toEqual(["b2"]);
  });

  it("orders equal workspaces by age", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 10 });
    const started: string[] = [];
    const first = admitted(pool.request({ workspaceId: "ws-x" }));
    const b = recorder(started, "b");
    const a = recorder(started, "a");
    pool.request({ workspaceId: "ws-b" }, b.waiter);
    pool.request({ workspaceId: "ws-a" }, a.waiter);

    first.release();
    expect(started).toEqual(["b"]);
    b.out.lease!.release();
    expect(started).toEqual(["b", "a"]);
  });

  it("lets a workspace alone use every slot", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 3, maxQueuedRuns: 10 });
    const started: string[] = [];
    const leases = [0, 1, 2].map(() => admitted(pool.request({ workspaceId: "ws-a" })));
    for (const n of [4, 5, 6])
      pool.request({ workspaceId: "ws-a" }, recorder(started, `a${n}`).waiter);

    for (const lease of leases) lease.release();
    expect(started).toEqual(["a4", "a5", "a6"]);
    expect(pool.inFlight()).toBe(3);
  });

  it("interleaves a burst from one workspace with another's waiting runs", () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 2, maxQueuedRuns: 10 });
    const started: string[] = [];
    const held = [
      admitted(pool.request({ workspaceId: "ws-a" })),
      admitted(pool.request({ workspaceId: "ws-a" })),
    ];
    const leases = new Map<string, AdmissionLease>();
    const queue = (ws: string, name: string) =>
      pool.request(
        { workspaceId: ws },
        {
          admitted: (l) => {
            leases.set(name, l);
            started.push(name);
          },
          withdrawn: () => {},
        },
      );
    for (const n of [1, 2, 3]) queue("ws-a", `a${n}`);
    queue("ws-b", "b1");
    queue("ws-b", "b2");

    held[0]!.release(); // ws-a 1, ws-b 0 -> b1
    expect(started).toEqual(["b1"]);
    held[1]!.release(); // ws-a 0, ws-b 1 -> a1
    expect(started).toEqual(["b1", "a1"]);
    leases.get("b1")!.release(); // ws-a 1, ws-b 0 -> b2
    expect(started).toEqual(["b1", "a1", "b2"]);
  });
});

describe("run admission — acquire", () => {
  it("resolves at once with a free slot, and waits for one otherwise", async () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    const first = await pool.acquire({ workspaceId: "ws-a" });
    let second: AdmissionLease | undefined;
    const pending = pool.acquire({ workspaceId: "ws-a" }).then((l) => {
      second = l;
    });
    await Bun.sleep(1);
    expect(second).toBeUndefined();
    first.release();
    await pending;
    expect(pool.owns(second!)).toBe(true);
  });

  it("rejects a refused request with a typed error", async () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 0 });
    await pool.acquire({ workspaceId: "ws-a" });
    const err = await pool.acquire({ workspaceId: "ws-a" }).catch((e) => e);
    expect(err).toBeInstanceOf(RunAdmissionRefusedError);
    expect((err as RunAdmissionRefusedError).reason).toBe("queue_full");
    expect((err as RunAdmissionRefusedError).code).toBe("run_admission_refused");
  });

  it("leaves the queue with an AbortError when its signal fires", async () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    await pool.acquire({ workspaceId: "ws-a" });
    const controller = new AbortController();
    const waiting = pool.acquire({ workspaceId: "ws-a" }, controller.signal);
    expect(pool.queued()).toHaveLength(1);
    controller.abort();
    const err = await waiting.catch((e) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect(pool.queued()).toEqual([]);
  });

  it("rejects a queued acquire when admission stops", async () => {
    const pool = createRunAdmission({ maxConcurrentRuns: 1 });
    await pool.acquire({ workspaceId: "ws-a" });
    const waiting = pool.acquire({ workspaceId: "ws-a" });
    pool.stop();
    const err = await waiting.catch((e) => e);
    expect((err as RunAdmissionRefusedError).reason).toBe("stopped");
  });
});

/**
 * The door admits every unattended run, not only the scheduler's: a caller
 * driving `executeTask` directly (embedded, CLI, evals, a future source) holds
 * a slot for as long as its run executes, and waits for one at the limit.
 */
describe("Runtime.executeTask — admission at the door", () => {
  function doorRuntime(maxConcurrentRuns: number) {
    const rt = Object.create(Runtime.prototype) as Runtime;
    const gates: Array<PromiseWithResolvers<void>> = [];
    const specs: RunSpec[] = [];
    const fields = rt as unknown as {
      config: { automations: { maxConcurrentRuns: number } };
      resolveRequestModelString: (m?: string) => string;
      startRun: (spec: RunSpec) => Promise<unknown>;
    };
    fields.config = { automations: { maxConcurrentRuns } };
    fields.resolveRequestModelString = () => "test:model";
    fields.startRun = async (spec) => {
      specs.push(spec);
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
      return {
        runId: `run_${specs.length}`,
        conversationId: null,
        output: "done",
        skillName: null,
        toolCalls: [],
        stopReason: "complete",
        usage: { inputTokens: 0, outputTokens: 0, iterations: 1 },
      };
    };
    return { runtime: rt, gates, specs };
  }

  const task = (prompt: string): TaskRequest => ({
    prompt,
    identity: { id: "user-a" } as TaskRequest["identity"],
    workspaceId: "ws-a",
  });

  it("holds a slot per run and starts a waiting run when one ends", async () => {
    const { runtime, gates, specs } = doorRuntime(1);
    const first = runtime.executeTask(task("one"));
    const second = runtime.executeTask(task("two"));
    await Bun.sleep(1);

    expect(specs.map((s) => s.trigger)).toEqual(["api"]);
    expect(runtime.getRunAdmission().inFlight()).toBe(1);
    expect(runtime.getRunAdmission().queued()).toHaveLength(1);

    gates[0]!.resolve();
    expect((await first).output).toBe("done");
    await Bun.sleep(1);
    expect(specs).toHaveLength(2);

    gates[1]!.resolve();
    await second;
    expect(runtime.getRunAdmission().inFlight()).toBe(0);
  });

  it("releases its slot when the run throws", async () => {
    const { runtime } = doorRuntime(1);
    (runtime as unknown as { startRun: () => Promise<never> }).startRun = async () => {
      throw new Error("engine failed");
    };
    await expect(runtime.executeTask(task("x"))).rejects.toThrow("engine failed");
    expect(runtime.getRunAdmission().inFlight()).toBe(0);
  });

  it("runs under a lease the caller holds, and releases it", async () => {
    const { runtime, gates, specs } = doorRuntime(1);
    const ticket = runtime.getRunAdmission().request({ workspaceId: "ws-a", key: "k" });
    if (ticket.state !== "admitted") throw new Error("expected admitted");

    const run = runtime.executeTask({ ...task("held"), admission: ticket.lease });
    await Bun.sleep(1);
    expect(specs).toHaveLength(1);
    expect(runtime.getRunAdmission().inFlight()).toBe(1);
    gates[0]!.resolve();
    await run;
    expect(runtime.getRunAdmission().inFlight()).toBe(0);
  });

  it("releases a held lease when the request is refused before it runs", async () => {
    const { runtime } = doorRuntime(1);
    const ticket = runtime.getRunAdmission().request({ workspaceId: "ws-a" });
    if (ticket.state !== "admitted") throw new Error("expected admitted");
    await expect(
      runtime.executeTask({
        prompt: "x",
        identity: { id: "u" } as TaskRequest["identity"],
        admission: ticket.lease,
      }),
    ).rejects.toThrow("names no workspace");
    expect(runtime.getRunAdmission().inFlight()).toBe(0);
  });
});
