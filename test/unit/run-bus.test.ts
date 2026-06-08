import { describe, expect, it } from "bun:test";
import { RunInProgressError } from "../../src/runtime/errors.ts";
import { RunBus } from "../../src/runtime/run-bus.ts";

describe("RunBus", () => {
  it("assigns monotonic 1-based sequence numbers", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "a" });
    bus.publish("c1", "text.delta", { text: "b" });
    expect(bus.currentSeq("c1")).toBe(2);
  });

  it("throws RunInProgressError when a turn is already active", () => {
    const bus = new RunBus();
    bus.begin("c1");
    expect(() => bus.begin("c1")).toThrow(RunInProgressError);
  });

  it("tracks active runs and clears on end", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.begin("c2");
    expect(bus.isActive("c1")).toBe(true);
    expect(bus.isActive("c2")).toBe(true);
    bus.end("c1", "done");
    expect(bus.isActive("c1")).toBe(false);
    expect(bus.isActive("c2")).toBe(true);
  });

  it("buffers events and returns each one for live delivery", () => {
    const bus = new RunBus();
    bus.begin("c1");
    // publish returns the buffered event — the runtime fans THIS out to live
    // viewers (there is no second subscriber path on the bus).
    const e1 = bus.publish("c1", "text.delta", { text: "one" });
    const e2 = bus.publish("c1", "text.delta", { text: "two" });
    expect([e1?.seq, e2?.seq]).toEqual([1, 2]);
    // A late viewer (page refresh) replays the whole buffer from seq 0.
    expect(bus.bufferedSince("c1", 0).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("bufferedSince resumes from a given seq without gaps or duplicates", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "1" });
    bus.publish("c1", "text.delta", { text: "2" });
    bus.publish("c1", "text.delta", { text: "3" });
    // Client already rendered through seq 2 — replay the remainder only.
    expect(bus.bufferedSince("c1", 2).map((e) => e.seq)).toEqual([3]);
  });

  it("keeps a terminal run replayable within the grace window", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "hi" });
    bus.end("c1", "done");
    // getStatus reports the terminal status; the buffer stays replayable so a
    // late viewer reconstructs the finished turn from the grace buffer.
    expect(bus.getStatus("c1")).toBe("done");
    expect(bus.bufferedSince("c1", 0).map((e) => e.seq)).toEqual([1]);
  });

  it("cancel aborts the turn signal and marks it cancelled", () => {
    const bus = new RunBus();
    const signal = bus.begin("c1");
    expect(signal.aborted).toBe(false);
    const ok = bus.cancel("c1");
    expect(ok).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(bus.getStatus("c1")).toBe("cancelled");
    expect(bus.isActive("c1")).toBe(false);
  });

  it("ignores publish after a run is terminal", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.end("c1", "done");
    bus.publish("c1", "text.delta", { text: "late" });
    expect(bus.currentSeq("c1")).toBe(0);
  });

  it("GCs a terminal run after the grace window", async () => {
    const bus = new RunBus(10);
    bus.begin("c1");
    bus.publish("c1", "x", {});
    bus.end("c1", "done");
    expect(bus.getStatus("c1")).toBe("done");
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.getStatus("c1")).toBeUndefined();
  });

  it("a new turn replaces a lingering terminal log", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "x", {});
    bus.end("c1", "done");
    // New turn — seq restarts, status running.
    bus.begin("c1");
    expect(bus.isActive("c1")).toBe(true);
    expect(bus.currentSeq("c1")).toBe(0);
  });

  it("bufferedSince on an unknown conversation returns an empty replay", () => {
    const bus = new RunBus();
    expect(bus.bufferedSince("nope", 0)).toEqual([]);
  });

  it("caps per-run event buffer and ends the run with a terminal error", () => {
    // Tiny cap for testability. Production uses 500k.
    const bus = new RunBus(30_000, 10);
    const signal = bus.begin("c1");

    // Fill exactly to the cap — these should all succeed.
    for (let i = 0; i < 10; i++) {
      bus.publish("c1", "text.delta", { text: String(i) });
    }
    expect(bus.isActive("c1")).toBe(true);

    // 11th publish trips the cap — turn aborts, terminal error appended + returned.
    const overflow = bus.publish("c1", "text.delta", { text: "boom" });
    expect(overflow).not.toBeNull();
    expect(overflow?.type).toBe("error");
    expect((overflow?.data as { error: string }).error).toBe("buffer_overflow");
    expect(signal.aborted).toBe(true);
    expect(bus.getStatus("c1")).toBe("error");
    expect(bus.isActive("c1")).toBe(false);

    // The buffer holds 10 deltas + 1 terminal error, replayable to a late viewer.
    const buffered = bus.bufferedSince("c1", 0);
    expect(buffered.length).toBe(11);
    expect(buffered[buffered.length - 1]?.type).toBe("error");

    // Further publishes are dropped by the standard not-running guard.
    expect(bus.publish("c1", "text.delta", { text: "late" })).toBeNull();
  });

  it("overflow error event is included in a late replay", () => {
    const bus = new RunBus(30_000, 3);
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "1" });
    bus.publish("c1", "text.delta", { text: "2" });
    bus.publish("c1", "text.delta", { text: "3" });
    bus.publish("c1", "text.delta", { text: "4" }); // trips cap

    expect(bus.getStatus("c1")).toBe("error");
    const buffered = bus.bufferedSince("c1", 0);
    expect(buffered[buffered.length - 1]?.type).toBe("error");
    expect((buffered[buffered.length - 1]?.data as { error: string }).error).toBe("buffer_overflow");
  });

  it("evict(id, signal) drops only the run that owns that signal", () => {
    const bus = new RunBus();
    // Reservation A — capture its signal, then end + replace it with a fresh
    // run B at the same id (legal: a terminal log is replaced on begin).
    const signalA = bus.begin("c1");
    bus.cancel("c1"); // A is now terminal, lingering in its grace window
    const signalB = bus.begin("c1"); // B replaces A
    expect(signalB).not.toBe(signalA);
    expect(bus.isActive("c1")).toBe(true);

    // A's late failure-path evict, scoped to A's signal, must NOT drop B.
    bus.evict("c1", signalA);
    expect(bus.isActive("c1")).toBe(true);
    expect(bus.getStatus("c1")).toBe("running");

    // Evict scoped to the live run's own signal drops it.
    bus.evict("c1", signalB);
    expect(bus.getStatus("c1")).toBeUndefined();
  });
});
