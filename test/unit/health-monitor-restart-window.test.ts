import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { HealthMonitor } from "../../src/tools/health-monitor.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/**
 * A restart runs stop() then start(), and stop() sets `stopped` before it awaits
 * the transport's close. A HealthMonitor check that lands in that window must not
 * read the restart as a deliberate teardown and mark a live source dead for good.
 */

interface Internals {
  client: unknown;
  transport: unknown;
  dead: boolean;
  stopped: boolean;
  start: () => Promise<void>;
}

/** Resolves when `release()` is called, so a test can hold stop() mid-close. */
function gate() {
  let release = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { closed, release };
}

/** A crashed remote source whose close blocks on `closed`, and whose start succeeds. */
function crashedSource(closed: Promise<void>) {
  const source = new McpSource(
    "svc",
    { type: "remote", url: new URL("https://svc.example.com/mcp") },
    new NoopEventSink(),
  );
  const internal = source as unknown as Internals;
  internal.client = { close: () => closed };
  internal.transport = { close: () => Promise.resolve() };
  internal.dead = true;
  internal.start = async () => {
    internal.stopped = false;
    internal.client = { close: () => Promise.resolve() };
    internal.transport = { close: () => Promise.resolve() };
  };
  return { source, internal };
}

describe("a restart in flight is not a deliberate stop", () => {
  it("test_is_stopped_is_false_while_a_restart_is_in_flight", async () => {
    const { closed, release } = gate();
    const { source, internal } = crashedSource(closed);
    const restarting = source.restart();
    // stop() has set the durable marker and is waiting on the close.
    expect(internal.stopped).toBe(true);
    expect(source.isStopped()).toBe(false);
    release();
    expect(await restarting).toBe(true);
    expect(source.isStopped()).toBe(false);
  });

  it("test_deliberate_stop_still_reads_stopped", async () => {
    const { source } = crashedSource(Promise.resolve());
    await source.stop();
    expect(source.isStopped()).toBe(true);
  });

  it("test_monitor_check_mid_restart_does_not_mark_the_source_dead", async () => {
    const { closed, release } = gate();
    const { source } = crashedSource(closed);
    const monitor = new HealthMonitor(() => [source], new NoopEventSink(), {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
    });
    try {
      const restarting = source.restart();
      const checking = monitor.check();
      expect(monitor.getStatus()[0]?.state).not.toBe("dead");
      release();
      await Promise.all([restarting, checking]);
      await monitor.check();
      expect(monitor.getStatus()[0]?.state).toBe("healthy");
    } finally {
      monitor.stop();
    }
  });
});
