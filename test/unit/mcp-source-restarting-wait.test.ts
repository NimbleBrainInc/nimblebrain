import { describe, expect, it, spyOn } from "bun:test";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { createRunSupervisor } from "../../src/engine/supervisor.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/**
 * A source that restarts is waited for, bounded, instead of answering "not
 * started" and spending a strike on each call; a source that is not coming back
 * still trips the run supervisor at three.
 */

interface Internals {
  client: unknown;
  stopped: boolean;
  downSince: number | null;
  restartingSourceWait: { waitMs: number; horizonMs: number; retryMs: number };
  tryRestart: () => Promise<boolean>;
}

const okClient = {
  callTool: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false }),
  close: () => Promise.resolve(),
};

/** A remote source whose client is gone, down since `downSince`. */
function downSource(wait: Internals["restartingSourceWait"], downSince = Date.now()) {
  const source = new McpSource(
    "svc",
    { type: "remote", url: new URL("https://svc.example.com/mcp") },
    new NoopEventSink(),
  );
  const internal = source as unknown as Internals;
  internal.client = null;
  internal.downSince = downSince;
  internal.restartingSourceWait = wait;
  return { source, internal };
}

/** A restart that fails until `backAt`, then re-establishes the client. */
function restartsBackAt(source: McpSource, backAt: number) {
  const internal = source as unknown as Internals;
  return spyOn(internal, "tryRestart").mockImplementation(async () => {
    if (Date.now() < backAt) return false;
    internal.client = okClient;
    internal.downSince = null;
    return true;
  });
}

function isNotStarted(result: ToolResult): boolean {
  return result.isError === true && JSON.stringify(result.content).includes("not started");
}

describe("McpSource waits for a restarting source", () => {
  it("test_restarting_source_shorter_than_wait_does_not_trip_and_calls_succeed", async () => {
    const { source } = downSource({ waitMs: 1_000, horizonMs: 10_000, retryMs: 20 });
    const restart = restartsBackAt(source, Date.now() + 150);
    const supervisor = createRunSupervisor();
    try {
      for (let i = 0; i < 4; i++) {
        const result = await source.execute("search", { q: `query ${i}` });
        expect(result.isError).toBe(false);
        const verdict = supervisor.observe(
          { id: `c${i}`, name: "svc__search", input: { q: `query ${i}` } },
          result,
        );
        expect(verdict.type).toBe("pass");
      }
      expect(supervisor.snapshot().trippedTools).toEqual([]);
      expect(restart.mock.calls.length).toBeGreaterThan(1);
    } finally {
      restart.mockRestore();
    }
  });

  it("test_source_that_never_returns_trips_at_three_within_the_bound", async () => {
    const waitMs = 120;
    const { source } = downSource({ waitMs, horizonMs: 60_000, retryMs: 20 });
    const restart = restartsBackAt(source, Number.POSITIVE_INFINITY);
    const supervisor = createRunSupervisor();
    const verdicts: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const result = await source.execute("search", { q: `query ${i}` });
        const elapsed = Date.now() - started;
        expect(isNotStarted(result)).toBe(true);
        // Bounded: the wait ends at its deadline, plus timer slack.
        expect(elapsed).toBeLessThan(waitMs + 500);
        verdicts.push(
          supervisor.observe(
            { id: `c${i}`, name: "svc__search", input: { q: `query ${i}` } },
            result,
          ).type,
        );
      }
      expect(verdicts).toEqual(["pass", "pass", "synth"]);
    } finally {
      restart.mockRestore();
    }
  });

  it("test_source_down_past_horizon_strikes_without_waiting", async () => {
    const horizonMs = 1_000;
    const { source } = downSource(
      { waitMs: 5_000, horizonMs, retryMs: 20 },
      Date.now() - horizonMs - 1,
    );
    const restart = restartsBackAt(source, Number.POSITIVE_INFINITY);
    try {
      const started = Date.now();
      const result = await source.execute("search", {});
      expect(isNotStarted(result)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      // Only the on-demand reconnect ran; nothing retried inside a wait.
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      restart.mockRestore();
    }
  });

  it("test_abort_ends_the_wait", async () => {
    const { source } = downSource({ waitMs: 5_000, horizonMs: 60_000, retryMs: 20 });
    const restart = restartsBackAt(source, Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    try {
      const started = Date.now();
      const result = await source.execute("search", {}, controller.signal);
      expect(isNotStarted(result)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      restart.mockRestore();
    }
  });

  it("test_deliberately_stopped_source_is_not_waited_for", async () => {
    const { source, internal } = downSource({ waitMs: 5_000, horizonMs: 60_000, retryMs: 20 });
    internal.stopped = true;
    const restart = restartsBackAt(source, Number.POSITIVE_INFINITY);
    try {
      const started = Date.now();
      const result = await source.execute("search", {});
      expect(isNotStarted(result)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(restart).not.toHaveBeenCalled();
    } finally {
      restart.mockRestore();
    }
  });

  it("test_crash_records_down_since_once_per_outage", () => {
    const source = new McpSource(
      "svc",
      { type: "remote", url: new URL("https://svc.example.com/mcp") },
      new NoopEventSink(),
    );
    const internal = source as unknown as Internals & { dead: boolean };
    expect(internal.downSince).toBeNull();
    source._emitSourceCrashedForTesting("transport closed");
    const first = internal.downSince;
    expect(first).not.toBeNull();
    // A second observation in the same outage keeps the outage's start.
    internal.dead = false;
    internal.downSince = (first ?? 0) - 5_000;
    source._emitSourceCrashedForTesting("again");
    expect(internal.downSince).toBe((first ?? 0) - 5_000);
  });

  it("test_failed_start_records_down_since_and_keeps_it_across_retries", async () => {
    // A transport that cannot open fails the connect, which goes through
    // cleanupOnStartFailure(): the path every failed restart takes.
    const unreachable = {
      start: () => Promise.reject(new Error("connect refused")),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const server = new Server({ name: "svc", version: "0.1.0" }, { capabilities: {} });
    const source = new McpSource(
      "svc",
      {
        type: "inProcess",
        createServer: async () => ({
          server,
          clientTransport: unreachable as unknown as InMemoryTransport,
        }),
      },
      new NoopEventSink(),
    );
    const internal = source as unknown as Internals;
    await expect(source.start()).rejects.toThrow();
    const first = internal.downSince;
    expect(first).not.toBeNull();
    internal.downSince = (first ?? 0) - 5_000;
    await expect(source.start()).rejects.toThrow();
    expect(internal.downSince).toBe((first ?? 0) - 5_000);
  });

  it("test_successful_connect_clears_down_since", async () => {
    const server = new Server({ name: "svc", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const source = new McpSource(
      "svc",
      { type: "inProcess", createServer: async () => ({ server, clientTransport }) },
      new NoopEventSink(),
    );
    const internal = source as unknown as Internals;
    internal.downSince = Date.now() - 5_000;
    try {
      await source.start();
      expect(internal.downSince).toBeNull();
    } finally {
      await source.stop();
    }
  });
});
