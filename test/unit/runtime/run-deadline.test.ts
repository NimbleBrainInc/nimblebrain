import { describe, expect, test } from "bun:test";
import { RunDeadlineExceededError } from "../../../src/runtime/errors.ts";
import { runDeadline } from "../../../src/runtime/run-deadline.ts";

// A run that carries a per-run model credential is bounded by the credential's
// lifetime: the door holds a run with no limit of its own (a chat turn) to the
// installation's longest run, and leaves every other run as its caller set it.

const aborted = (signal: AbortSignal) =>
  new Promise<unknown>((resolve) => signal.addEventListener("abort", () => resolve(signal.reason)));

describe("the door's run deadline", () => {
  test("leaves a run without a model credential as its caller set it", () => {
    const caller = new AbortController();
    const d = runDeadline({
      signal: caller.signal,
      ownLimitMs: undefined,
      credentialed: false,
      ceilingMs: 5,
      runtimeId: "native",
    });
    expect(d.signal).toBe(caller.signal);
    expect(d.limitMs).toBeUndefined();
  });

  test("takes a credentialed run's own limit, which its caller enforces", () => {
    const caller = new AbortController();
    const d = runDeadline({
      signal: caller.signal,
      ownLimitMs: 45_000,
      credentialed: true,
      ceilingMs: 600_000,
      runtimeId: "agent",
    });
    expect(d.signal).toBe(caller.signal);
    expect(d.limitMs).toBe(45_000);
  });

  test("ends a credentialed run with no limit of its own at the ceiling", async () => {
    const d = runDeadline({
      signal: undefined,
      ownLimitMs: undefined,
      credentialed: true,
      ceilingMs: 20,
      runtimeId: "agent",
    });
    expect(d.limitMs).toBe(20);
    const reason = await aborted(d.signal as AbortSignal);
    expect(reason).toBeInstanceOf(RunDeadlineExceededError);
    expect((reason as RunDeadlineExceededError).message).toContain("agent runtime agent");
  });

  test("still ends when its caller cancels first, with the caller's reason", async () => {
    const caller = new AbortController();
    const d = runDeadline({
      signal: caller.signal,
      ownLimitMs: undefined,
      credentialed: true,
      ceilingMs: 60_000,
      runtimeId: "agent",
    });
    caller.abort(new Error("cancelled by the person"));
    const signal = d.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("cancelled by the person");
    d.clear();
  });

  test("never fires once cleared", async () => {
    const d = runDeadline({
      signal: undefined,
      ownLimitMs: undefined,
      credentialed: true,
      ceilingMs: 10,
      runtimeId: "agent",
    });
    d.clear();
    await Bun.sleep(30);
    expect(d.signal?.aborted).toBe(false);
  });
});
