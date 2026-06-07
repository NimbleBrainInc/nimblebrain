import { describe, expect, it } from "bun:test";
import { RunInProgressError } from "../../src/runtime/errors.ts";
import { type BufferedRunEvent, RunBus } from "../../src/runtime/run-bus.ts";

function collect(): { events: BufferedRunEvent[]; onEvent: (e: BufferedRunEvent) => void } {
  const events: BufferedRunEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

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

  it("tracks active conversations and clears on end", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.begin("c2");
    expect(bus.activeConversationIds().sort()).toEqual(["c1", "c2"]);
    expect(bus.isActive("c1")).toBe(true);
    bus.end("c1", "done");
    expect(bus.isActive("c1")).toBe(false);
    expect(bus.activeConversationIds()).toEqual(["c2"]);
  });

  it("replays buffered events on attach, then tails live ones", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "one" });
    bus.publish("c1", "text.delta", { text: "two" });

    // Late subscriber (e.g. a page refresh) — full replay from 0.
    const { events, onEvent } = collect();
    bus.attach("c1", 0, onEvent);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);

    // Live tail.
    bus.publish("c1", "text.delta", { text: "three" });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("resumes from a given seq without gaps or duplicates", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "1" });
    bus.publish("c1", "text.delta", { text: "2" });
    bus.publish("c1", "text.delta", { text: "3" });

    // Client already rendered through seq 2 — attach for the remainder only.
    const { events, onEvent } = collect();
    bus.attach("c1", 2, onEvent);
    expect(events.map((e) => e.seq)).toEqual([3]);
  });

  it("delivers terminal status to attachers, including late ones", () => {
    const bus = new RunBus();
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "hi" });

    let liveStatus: string | undefined;
    bus.attach("c1", 0, () => {}, (s) => {
      liveStatus = s;
    });
    bus.end("c1", "done");
    expect(liveStatus).toBe("done");

    // Attaching after the run ended (still within grace) replays + reports end.
    const { events, onEvent } = collect();
    let lateStatus: string | undefined;
    bus.attach("c1", 0, onEvent, (s) => {
      lateStatus = s;
    });
    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(lateStatus).toBe("done");
  });

  it("detach stops further delivery", () => {
    const bus = new RunBus();
    bus.begin("c1");
    const { events, onEvent } = collect();
    const detach = bus.attach("c1", 0, onEvent);
    bus.publish("c1", "text.delta", { text: "a" });
    detach();
    bus.publish("c1", "text.delta", { text: "b" });
    expect(events.map((e) => (e.data as { text: string }).text)).toEqual(["a"]);
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

  it("does not abort generation on detach (disconnect ≠ cancel)", () => {
    const bus = new RunBus();
    const signal = bus.begin("c1");
    const detach = bus.attach("c1", 0, () => {});
    detach();
    // The viewer left, but the turn keeps running.
    expect(signal.aborted).toBe(false);
    expect(bus.isActive("c1")).toBe(true);
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

  it("attach to an unknown conversation is a safe no-op", () => {
    const bus = new RunBus();
    const detach = bus.attach("nope", 0, () => {});
    expect(typeof detach).toBe("function");
    detach();
  });

  it("caps per-run event buffer and ends the run with a terminal error", () => {
    // Tiny cap for testability. Production uses 500k.
    const bus = new RunBus(30_000, 10);
    const signal = bus.begin("c1");

    const { events, onEvent } = collect();
    const endStatuses: string[] = [];
    bus.attach("c1", 0, onEvent, (s) => endStatuses.push(s));

    // Fill exactly to the cap — these should all succeed.
    for (let i = 0; i < 10; i++) {
      bus.publish("c1", "text.delta", { text: String(i) });
    }
    expect(bus.isActive("c1")).toBe(true);

    // 11th publish trips the cap — turn aborts, terminal error appended.
    const overflow = bus.publish("c1", "text.delta", { text: "boom" });

    expect(overflow).not.toBeNull();
    expect(overflow?.type).toBe("error");
    expect((overflow?.data as { error: string }).error).toBe("buffer_overflow");
    expect(signal.aborted).toBe(true);
    expect(bus.getStatus("c1")).toBe("error");
    expect(bus.isActive("c1")).toBe(false);
    expect(endStatuses).toEqual(["error"]);

    // The viewer saw 10 deltas + 1 terminal error.
    expect(events.length).toBe(11);
    expect(events[events.length - 1]?.type).toBe("error");

    // Further publishes are dropped by the standard not-running guard.
    const after = bus.publish("c1", "text.delta", { text: "late" });
    expect(after).toBeNull();
  });

  it("overflow error event is included in a late attacher's replay", () => {
    const bus = new RunBus(30_000, 3);
    bus.begin("c1");
    bus.publish("c1", "text.delta", { text: "1" });
    bus.publish("c1", "text.delta", { text: "2" });
    bus.publish("c1", "text.delta", { text: "3" });
    bus.publish("c1", "text.delta", { text: "4" }); // trips cap

    const { events, onEvent } = collect();
    let lateStatus: string | undefined;
    bus.attach("c1", 0, onEvent, (s) => {
      lateStatus = s;
    });
    expect(lateStatus).toBe("error");
    expect(events[events.length - 1]?.type).toBe("error");
    expect((events[events.length - 1]?.data as { error: string }).error).toBe("buffer_overflow");
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
