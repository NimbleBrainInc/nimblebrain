import { describe, expect, it } from "bun:test";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { HealthMonitor } from "../../src/tools/health-monitor.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";

/** Minimal mock of McpSource exposing only what HealthMonitor needs. */
function makeMockSource(
  name: string,
): McpSource & {
  alive: boolean;
  stopped: boolean;
  restartResult: boolean;
  restartCalls: number;
  setUptime: (ms: number) => void;
} {
  let startedAt: number | null = Date.now();
  const mock = {
    name,
    alive: true,
    stopped: false,
    restartResult: true,
    restartCalls: 0,
    isAlive() {
      return mock.alive;
    },
    isStopped() {
      return mock.stopped;
    },
    uptime() {
      return startedAt !== null ? Date.now() - startedAt : null;
    },
    /** Test helper: age the source so `uptime()` reports `ms` of continuous run. */
    setUptime(ms: number) {
      startedAt = Date.now() - ms;
    },
    async restart() {
      mock.restartCalls++;
      if (mock.restartResult) {
        mock.alive = true;
        startedAt = Date.now();
      }
      return mock.restartResult;
    },
  } as unknown as McpSource & {
    alive: boolean;
    stopped: boolean;
    restartResult: boolean;
    restartCalls: number;
    setUptime: (ms: number) => void;
  };
  return mock;
}

function makeEventCollector(): EventSink & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    emit(event: EngineEvent) {
      events.push(event);
    },
  };
}

function eventNames(collector: { events: EngineEvent[] }): string[] {
  return collector.events.map((e) => (e.data as { event: string }).event);
}

describe("HealthMonitor", () => {
  it("detects crashed subprocess and restarts it", async () => {
    const source = makeMockSource("test-bundle");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // Kill the subprocess
    source.alive = false;

    // Run a check
    await monitor.check();

    // Should have emitted crashed, restarting, recovered
    const events = eventNames(sink);
    expect(events).toContain("bundle.crashed");
    expect(events).toContain("bundle.restarting");
    expect(events).toContain("bundle.recovered");

    // Status should show healthy after recovery
    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(1);

    monitor.stop();
  });

  it("backs off to cooldown after the quick-retry budget — not terminal — and stops hammering", async () => {
    const source = makeMockSource("flaky-bundle");
    const sink = makeEventCollector();
    // Large cooldown so the source stays in the cooling window across the checks
    // below; the self-heal-after-cooldown case is covered by its own test.
    const monitor = new HealthMonitor([source], sink, {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
      cooldownMs: 60_000,
    });

    // Each restart "succeeds" but the subprocess immediately dies again — a
    // crash loop that spends the whole quick-retry budget.
    for (let i = 0; i < 5; i++) {
      source.alive = false;
      await monitor.check();
      source.alive = false;
    }

    // 6th crash exhausts the budget → cooldown, NOT terminal dead.
    source.alive = false;
    await monitor.check();

    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("cooldown");

    const events = eventNames(sink);
    expect(events).toContain("bundle.cooldown");
    // `bundle.dead` is retired for the crash path — a crash never ends terminal.
    expect(events).not.toContain("bundle.dead");

    // While cooling, further checks neither restart nor re-emit `bundle.crashed`
    // — a throttling upstream is not hammered, and the crash-rate metric (which
    // counts `bundle.crashed`) is not inflated during the quiet window.
    const restartsBefore = source.restartCalls;
    const crashedBefore = eventNames(sink).filter((e) => e === "bundle.crashed").length;
    await monitor.check();
    await monitor.check();
    expect(source.restartCalls).toBe(restartsBefore);
    expect(eventNames(sink).filter((e) => e === "bundle.crashed").length).toBe(crashedBefore);

    monitor.stop();
  });

  it("self-heals: after the cooldown window elapses it retries and recovers", async () => {
    const source = makeMockSource("recoverable-bundle");
    const sink = makeEventCollector();
    // Tiny cooldown so the window elapses within the test.
    const monitor = new HealthMonitor([source], sink, {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
      cooldownMs: 5,
    });

    // Spend the budget → enter cooldown.
    for (let i = 0; i < 5; i++) {
      source.alive = false;
      await monitor.check();
      source.alive = false;
    }
    source.alive = false;
    await monitor.check();
    expect(monitor.getStatus()[0]!.state).toBe("cooldown");
    const restartsAtCooldown = source.restartCalls;

    // Upstream recovers: let the next restart stick (mock.restart sets alive).
    // Wait well past the 5ms cooldown window (generous margin so a jittery CI
    // clock can't race it), then a check resumes the burst and recovers.
    await new Promise((r) => setTimeout(r, 50));
    await monitor.check();

    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(source.restartCalls).toBeGreaterThan(restartsAtCooldown);
    // A recovery event fires once the source comes back — no operator action.
    expect(eventNames(sink)).toContain("bundle.recovered");

    monitor.stop();
  });

  it("a deliberate stop while cooling goes terminal dead (not re-probed)", async () => {
    const source = makeMockSource("cooling-then-stopped");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
      cooldownMs: 60_000,
    });

    // Spend the budget → cooldown.
    for (let i = 0; i < 5; i++) {
      source.alive = false;
      await monitor.check();
      source.alive = false;
    }
    source.alive = false;
    await monitor.check();
    expect(monitor.getStatus()[0]!.state).toBe("cooldown");

    // Operator disconnects it mid-cooldown → deliberate teardown is terminal.
    source.stopped = true;
    await monitor.check();
    expect(monitor.getStatus()[0]!.state).toBe("dead");

    // Terminal: no further re-probe.
    const restartsBefore = source.restartCalls;
    await monitor.check();
    expect(source.restartCalls).toBe(restartsBefore);

    monitor.stop();
  });

  it("a cooling source that comes back out of band goes healthy within one tick", async () => {
    const source = makeMockSource("cooling-then-alive");
    const sink = makeEventCollector();
    // Long cooldown: if the isAlive check didn't precede the cooldown gate, the
    // source would stay reported as `cooldown` for the whole window despite
    // being alive — a gauge false-positive. This asserts it recovers on the very
    // next tick.
    const monitor = new HealthMonitor([source], sink, {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
      cooldownMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      source.alive = false;
      await monitor.check();
      source.alive = false;
    }
    source.alive = false;
    await monitor.check();
    expect(monitor.getStatus()[0]!.state).toBe("cooldown");

    // Inline recovery (readResource/callTool self-heal) brought it back.
    source.alive = true;
    await monitor.check();
    expect(monitor.getStatus()[0]!.state).toBe("healthy");

    monitor.stop();
  });

  it("resets restartCount after sustained recovery so a flapping-but-recovering source never dies", async () => {
    const source = makeMockSource("flapping-bundle");
    const sink = makeEventCollector();
    const checkIntervalMs = 1000;
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs, baseDelayMs: 1 });

    // Eight independent drop episodes (> MAX_RESTARTS), each followed by a
    // SUSTAINED recovery: the source stays up beyond one full check interval
    // before the next drop. Under the lifetime-counter bug this dies at the
    // 6th episode; with the fix the counter clears on each sustained
    // recovery, so it never escalates to dead.
    for (let i = 0; i < 8; i++) {
      source.alive = false;
      await monitor.check(); // crashed → restarting → recovered (restartCount = 1)
      expect(monitor.getStatus()[0]!.state).toBe("healthy");
      expect(monitor.getStatus()[0]!.restartCount).toBe(1);

      // Source has now stayed up for a full check interval — next sweep
      // observes it alive + sustained and clears the counter.
      source.setUptime(checkIntervalMs);
      await monitor.check();
      expect(monitor.getStatus()[0]!.restartCount).toBe(0);
    }

    expect(monitor.getStatus()[0]!.state).toBe("healthy");
    expect(eventNames(sink)).not.toContain("bundle.dead");

    // Backoff resets between episodes: every restarting attempt fires at the
    // base delay (2 ** 0), never the escalated delays a climbing counter
    // would produce.
    const delays = sink.events
      .map((e) => e.data as { event: string; delayMs?: number })
      .filter((d) => d.event === "bundle.restarting")
      .map((d) => d.delayMs);
    expect(delays.length).toBe(8);
    for (const d of delays) expect(d).toBe(1);

    monitor.stop();
  });

  it("does not reset restartCount when recovery is not sustained — still escalates to cooldown", async () => {
    const source = makeMockSource("brief-flapper");
    const sink = makeEventCollector();
    const checkIntervalMs = 1000;
    const monitor = new HealthMonitor([source], sink, {
      checkIntervalMs,
      baseDelayMs: 1,
      cooldownMs: 60_000,
    });

    // Recovery is real but never sustained: the source is briefly alive with
    // sub-interval uptime, so it must NOT earn the reset. This guards against
    // an unconditional reset that would let a fast-flapping source burst
    // forever instead of escalating to the slow-re-probe cooldown.
    for (let i = 0; i < 5; i++) {
      source.alive = false;
      await monitor.check(); // recovers, counter climbs
      source.setUptime(10); // alive, but only 10ms << 1000ms interval
      await monitor.check(); // observed alive but NOT sustained → no reset
      expect(monitor.getStatus()[0]!.restartCount).toBe(i + 1);
    }

    // 6th drop spends the budget → cooldown (not terminal).
    source.alive = false;
    await monitor.check();
    expect(monitor.getStatus()[0]!.state).toBe("cooldown");
    expect(eventNames(sink)).toContain("bundle.cooldown");
    expect(eventNames(sink)).not.toContain("bundle.dead");

    monitor.stop();
  });

  it("getStatus reflects current state for each bundle", async () => {
    const healthy = makeMockSource("healthy-one");
    const crashed = makeMockSource("crashed-one");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([healthy, crashed], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // Verify initial state
    let status = monitor.getStatus();
    expect(status).toHaveLength(2);
    expect(status[0]!.name).toBe("healthy-one");
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(0);
    expect(status[1]!.name).toBe("crashed-one");
    expect(status[1]!.state).toBe("healthy");

    // Kill one source
    crashed.alive = false;
    await monitor.check();

    status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(0);
    expect(status[1]!.state).toBe("healthy"); // recovered
    expect(status[1]!.restartCount).toBe(1);
    expect(status[1]!.uptime).not.toBeNull();

    monitor.stop();
  });

  it("does not restart healthy bundles", async () => {
    const source = makeMockSource("stable-bundle");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    await monitor.check();

    expect(source.restartCalls).toBe(0);
    expect(sink.events).toHaveLength(0);

    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(0);

    monitor.stop();
  });

  it("stop() clears the interval so no more checks run", async () => {
    const source = makeMockSource("interval-bundle");
    const sink = makeEventCollector();
    // Use a very short interval
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 10, baseDelayMs: 1 });

    monitor.start();
    monitor.stop();

    // Kill the subprocess after stopping
    source.alive = false;

    // Wait longer than the interval
    await new Promise((r) => setTimeout(r, 50));

    // No events should have been emitted after stop
    expect(sink.events).toHaveLength(0);
    expect(source.restartCalls).toBe(0);
  });
});
