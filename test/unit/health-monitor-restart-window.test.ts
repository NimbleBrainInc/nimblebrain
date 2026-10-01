import { describe, expect, it, spyOn } from "bun:test";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
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

describe("a restart asked for mid-connect or mid-restart is joined", () => {
  it("test_monitor_check_during_first_start_does_not_stop_the_connect", async () => {
    // A connect flow registers the source before its first start() settles, so
    // a check can find it not yet alive while it is still connecting.
    const { closed: ready, release } = gate();
    const server = new Server({ name: "svc", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const source = new McpSource(
      "svc",
      {
        type: "inProcess",
        createServer: async () => {
          await ready;
          return { server, clientTransport };
        },
      },
      new NoopEventSink(),
    );
    const stop = spyOn(source, "stop");
    const monitor = new HealthMonitor(() => [source], new NoopEventSink(), {
      checkIntervalMs: 60_000,
      baseDelayMs: 1,
    });
    try {
      const starting = source.start();
      const checking = monitor.check();
      // Past the monitor's backoff, so its restart is waiting on the connect.
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([starting, checking]);
      expect(stop).not.toHaveBeenCalled();
      expect(source.isAlive()).toBe(true);
    } finally {
      monitor.stop();
      stop.mockRestore();
      await source.stop();
    }
  });

  it("test_call_arriving_mid_restart_joins_it_instead_of_failing", async () => {
    const { closed: started, release } = gate();
    const source = new McpSource(
      "svc",
      { type: "remote", url: new URL("https://svc.example.com/mcp") },
      new NoopEventSink(),
    );
    const internal = source as unknown as Internals;
    const okClient = {
      callTool: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false }),
      close: () => Promise.resolve(),
    };
    internal.client = okClient;
    internal.transport = { close: () => Promise.resolve() };
    internal.dead = true;
    internal.start = async () => {
      await started;
      internal.stopped = false;
      internal.client = okClient;
      internal.transport = { close: () => Promise.resolve() };
    };

    const restarting = source.restart();
    // stop() has finished: no client, `stopped` set, the restart's start() waiting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.client).toBeNull();

    const calling = source.execute("search", {});
    release();
    const [restarted, result] = await Promise.all([restarting, calling]);
    expect(restarted).toBe(true);
    expect(result.isError).toBe(false);
  });
});
