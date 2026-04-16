import { describe, expect, it } from "bun:test";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { HealthMonitor } from "../../src/tools/health-monitor.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";

/** Mock remote source — has isRemote() returning true. */
function makeMockRemoteSource(
  name: string,
): McpSource & {
  alive: boolean;
  startResult: boolean;
  stopCalls: number;
  startCalls: number;
} {
  let startedAt: number | null = Date.now();
  const mock = {
    name,
    alive: true,
    startResult: true,
    stopCalls: 0,
    startCalls: 0,
    isRemote() {
      return true;
    },
    isAlive() {
      return mock.alive;
    },
    uptime() {
      return startedAt !== null ? Date.now() - startedAt : null;
    },
    async restart() {
      // Should NOT be called for remote sources
      throw new Error("restart() should not be called for remote sources");
    },
    async stop() {
      mock.stopCalls++;
    },
    async start() {
      mock.startCalls++;
      if (mock.startResult) {
        mock.alive = true;
        startedAt = Date.now();
      } else {
        throw new Error("Remote connection failed");
      }
    },
  } as unknown as McpSource & {
    alive: boolean;
    startResult: boolean;
    stopCalls: number;
    startCalls: number;
  };
  return mock;
}

/** Mock stdio source — no isRemote() method (or returns false). */
function makeMockStdioSource(
  name: string,
): McpSource & { alive: boolean; restartResult: boolean; restartCalls: number } {
  let startedAt: number | null = Date.now();
  const mock = {
    name,
    alive: true,
    restartResult: true,
    restartCalls: 0,
    isAlive() {
      return mock.alive;
    },
    uptime() {
      return startedAt !== null ? Date.now() - startedAt : null;
    },
    async restart() {
      mock.restartCalls++;
      if (mock.restartResult) {
        mock.alive = true;
        startedAt = Date.now();
      }
      return mock.restartResult;
    },
  } as unknown as McpSource & { alive: boolean; restartResult: boolean; restartCalls: number };
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

function eventData(collector: { events: EngineEvent[] }): Record<string, unknown>[] {
  return collector.events.map((e) => e.data as Record<string, unknown>);
}

describe("HealthMonitor — remote sources", () => {
  it("detects crashed remote source and reconnects via stop+start", async () => {
    const source = makeMockRemoteSource("remote-bundle");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // Simulate remote disconnect
    source.alive = false;

    await monitor.check();

    // Should have emitted crashed, restarting, recovered
    const events = eventNames(sink);
    expect(events).toContain("bundle.crashed");
    expect(events).toContain("bundle.restarting");
    expect(events).toContain("bundle.recovered");

    // All events should have remote: true
    for (const data of eventData(sink)) {
      expect(data.remote).toBe(true);
    }

    // Should have used stop+start, not restart()
    expect(source.stopCalls).toBe(1);
    expect(source.startCalls).toBe(1);

    // Status should show healthy after recovery
    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(1);

    monitor.stop();
  });

  it("remote source transitions to dead after MAX_RESTARTS failures", async () => {
    const source = makeMockRemoteSource("flaky-remote");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // Each reconnect succeeds but remote immediately dies again
    for (let i = 0; i < 5; i++) {
      source.alive = false;
      await monitor.check();
      source.alive = false;
    }

    // 6th crash — should hit the limit
    source.alive = false;
    await monitor.check();

    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("dead");

    const events = eventNames(sink);
    expect(events).toContain("bundle.dead");

    // dead event should have remote: true
    const deadEvent = eventData(sink).find(
      (d) => d.event === "bundle.dead",
    );
    expect(deadEvent?.remote).toBe(true);

    // No further reconnect attempts
    const stopsBefore = source.stopCalls;
    const startsBefore = source.startCalls;
    await monitor.check();
    expect(source.stopCalls).toBe(stopsBefore);
    expect(source.startCalls).toBe(startsBefore);

    monitor.stop();
  });

  it("remote source that recovers after reconnect transitions back to healthy", async () => {
    const source = makeMockRemoteSource("recoverable-remote");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // First disconnect
    source.alive = false;
    await monitor.check();

    expect(monitor.getStatus()[0]!.state).toBe("healthy");
    expect(monitor.getStatus()[0]!.restartCount).toBe(1);

    // Second disconnect — also recovers
    source.alive = false;
    await monitor.check();

    expect(monitor.getStatus()[0]!.state).toBe("healthy");
    expect(monitor.getStatus()[0]!.restartCount).toBe(2);

    // recovered event has remote: true
    const recoveredEvents = eventData(sink).filter(
      (d) => d.event === "bundle.recovered",
    );
    expect(recoveredEvents).toHaveLength(2);
    for (const ev of recoveredEvents) {
      expect(ev.remote).toBe(true);
    }

    monitor.stop();
  });

  it("remote source reconnect failure leaves state as restarting", async () => {
    const source = makeMockRemoteSource("failing-remote");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // Disconnect and make reconnect fail
    source.alive = false;
    source.startResult = false;

    await monitor.check();

    // Should be in restarting state (not healthy, not dead)
    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("restarting");
    expect(status[0]!.restartCount).toBe(1);

    // Should have crashed and restarting events but NOT recovered
    const events = eventNames(sink);
    expect(events).toContain("bundle.crashed");
    expect(events).toContain("bundle.restarting");
    expect(events).not.toContain("bundle.recovered");

    monitor.stop();
  });

  it("subprocess sources still work identically (no regression)", async () => {
    const source = makeMockStdioSource("stdio-bundle");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor([source], sink, { checkIntervalMs: 60_000, baseDelayMs: 1 });

    // Kill the subprocess
    source.alive = false;
    await monitor.check();

    // Should use restart(), not stop+start
    expect(source.restartCalls).toBe(1);

    // Events should NOT have remote: true
    for (const data of eventData(sink)) {
      expect(data.remote).toBeUndefined();
    }

    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(1);

    monitor.stop();
  });

  it("mixed remote and stdio sources both work in same monitor", async () => {
    const remote = makeMockRemoteSource("remote-one");
    const stdio = makeMockStdioSource("stdio-one");
    const sink = makeEventCollector();
    const monitor = new HealthMonitor(
      [remote as unknown as McpSource, stdio as unknown as McpSource],
      sink,
      { checkIntervalMs: 60_000, baseDelayMs: 1 },
    );

    // Kill both
    remote.alive = false;
    stdio.alive = false;

    await monitor.check();

    // Both should be recovered
    const status = monitor.getStatus();
    expect(status[0]!.state).toBe("healthy");
    expect(status[0]!.restartCount).toBe(1);
    expect(status[1]!.state).toBe("healthy");
    expect(status[1]!.restartCount).toBe(1);

    // Remote events should have remote: true, stdio should not
    const remoteEvents = eventData(sink).filter((d) => d.source === "remote-one");
    const stdioEvents = eventData(sink).filter((d) => d.source === "stdio-one");

    for (const ev of remoteEvents) {
      expect(ev.remote).toBe(true);
    }
    for (const ev of stdioEvents) {
      expect(ev.remote).toBeUndefined();
    }

    // Remote used stop+start, stdio used restart()
    expect(remote.stopCalls).toBe(1);
    expect(remote.startCalls).toBe(1);
    expect(stdio.restartCalls).toBe(1);

    monitor.stop();
  });
});
