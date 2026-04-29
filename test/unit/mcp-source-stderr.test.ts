import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { McpSource, type McpTransportMode } from "../../src/tools/mcp-source.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

/** Build a stdio-mode source for tests that don't actually spawn. */
function makeStdioSource(name = "stderr-test", sink: EventSink = new NoopEventSink()) {
  const mode: McpTransportMode = {
    type: "stdio",
    spawn: { command: "true", args: [], env: {} },
  };
  return new McpSource(name, mode, sink);
}

/** Collecting EventSink. */
function recorder(): { events: EngineEvent[]; sink: EventSink } {
  const events: EngineEvent[] = [];
  return {
    events,
    sink: {
      emit(e) {
        events.push(e);
      },
    },
  };
}

describe("McpSource stderr drain", () => {
  it("splits a single chunk on newlines and stores complete lines in the ring buffer", () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    stream.write("hello\nworld\n");
    // PassThrough delivers data synchronously to listeners; no microtask wait needed.

    const tail = source._stderrTailForTesting();
    expect(tail).toEqual(["hello", "world"]);
  });

  it("buffers partial lines across chunks until a newline arrives", () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    stream.write("Trace");
    stream.write("back (most ");
    stream.write("recent call last):\n");

    expect(source._stderrTailForTesting()).toEqual(["Traceback (most recent call last):"]);
  });

  it("flushes a final partial line on stream end (no trailing newline)", async () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    stream.write("ModuleNotFoundError: rpds.rpds");
    const ended = new Promise<void>((resolve) => stream.once("end", () => resolve()));
    stream.end();
    await ended;
    // The reader's own `end` listener runs in the same emission cycle —
    // wait one more microtask so its mutation of stderrTail is visible.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(source._stderrTailForTesting()).toEqual(["ModuleNotFoundError: rpds.rpds"]);
  });

  it("strips trailing CR on CRLF lines", () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    stream.write("first\r\nsecond\r\n");

    expect(source._stderrTailForTesting()).toEqual(["first", "second"]);
  });

  it("caps the ring buffer at 50 lines (FIFO eviction)", () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    // Write 60 lines; only the last 50 should survive.
    let payload = "";
    for (let i = 0; i < 60; i++) payload += `line ${i}\n`;
    stream.write(payload);

    const tail = source._stderrTailForTesting();
    expect(tail.length).toBe(50);
    expect(tail[0]).toBe("line 10");
    expect(tail[49]).toBe("line 59");
  });

  it("truncates a runaway single line that exceeds the byte cap", () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    // 9 KB of bytes with no newline — exceeds 8 KB cap, must be flushed
    // with a truncation marker instead of growing unboundedly.
    const huge = "x".repeat(9000);
    stream.write(huge);

    const tail = source._stderrTailForTesting();
    expect(tail.length).toBe(1);
    expect(tail[0]!.endsWith("[…truncated]")).toBe(true);
    expect(tail[0]!.length).toBeLessThanOrEqual(8192 + " […truncated]".length);
  });

  it("ignores empty lines (consecutive newlines)", () => {
    const source = makeStdioSource();
    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);

    stream.write("a\n\n\nb\n");
    expect(source._stderrTailForTesting()).toEqual(["a", "b"]);
  });
});

describe("McpSource crash event semantics", () => {
  it("emitSourceCrashed fires exactly once even when called twice (dead-guard)", () => {
    const { events, sink } = recorder();
    const source = makeStdioSource("dedup", sink);

    source._emitSourceCrashedForTesting("first");
    source._emitSourceCrashedForTesting("second");

    const crashes = events.filter(
      (e) => e.type === "run.error" && (e.data as { event?: string }).event === "source.crashed",
    );
    expect(crashes).toHaveLength(1);
    expect((crashes[0]!.data as { error: string }).error).toBe("first");
    expect(source._isDeadForTesting()).toBe(true);
  });

  it("source.crashed payload includes stderrTail joined by newlines", () => {
    const { events, sink } = recorder();
    const source = makeStdioSource("payload", sink);

    const stream = new PassThrough();
    source._attachStderrReaderForTesting(stream);
    stream.write("traceback line 1\ntraceback line 2\n");

    source._emitSourceCrashedForTesting("Stdio subprocess exited");

    const crash = events.find(
      (e) => e.type === "run.error" && (e.data as { event?: string }).event === "source.crashed",
    );
    expect(crash).toBeDefined();
    const data = crash!.data as { error: string; stderrTail: string };
    expect(data.error).toBe("Stdio subprocess exited");
    expect(data.stderrTail).toBe("traceback line 1\ntraceback line 2");
  });
});

describe("McpSource lifecycle guards", () => {
  it("graceful stop() does not emit source.crashed when transport.close fires onclose", async () => {
    const { events, sink } = recorder();
    const { defineInProcessApp } = await import("../../src/tools/in-process-app.ts");
    const source = defineInProcessApp(
      { name: "graceful-stop", version: "1.0.0", tools: [] },
      sink,
    );
    await source.start();
    await source.stop();

    const crashes = events.filter(
      (e) => e.type === "run.error" && (e.data as { event?: string }).event === "source.crashed",
    );
    expect(crashes).toHaveLength(0);
  });

  it("failed start() does not emit source.crashed for a source that never ran", async () => {
    const { events, sink } = recorder();
    // In-process factory that throws synchronously — the connect path
    // never reaches "running"; cleanupOnStartFailure then closes the
    // (already-half-built) transport, which must not surface as a crash
    // event since the listener never saw the source alive.
    const mode: McpTransportMode = {
      type: "inProcess",
      createServer: async () => {
        throw new Error("createServer failed");
      },
    };
    const source = new McpSource("never-started", mode, sink);
    await expect(source.start()).rejects.toThrow("createServer failed");

    const crashes = events.filter(
      (e) => e.type === "run.error" && (e.data as { event?: string }).event === "source.crashed",
    );
    expect(crashes).toHaveLength(0);
  });

  it("restart re-arms crash detection (stopping flag clears on start)", async () => {
    const { events, sink } = recorder();
    const { defineInProcessApp } = await import("../../src/tools/in-process-app.ts");
    const source = defineInProcessApp(
      { name: "restart-rearm", version: "1.0.0", tools: [] },
      sink,
    );
    await source.start();
    await source.stop();
    // Restart cycle.
    await source.start();
    // After restart, dead is false and a fresh emit should produce one event.
    expect(source._isDeadForTesting()).toBe(false);
    source._emitSourceCrashedForTesting("post-restart crash");
    await source.stop();

    const crashes = events.filter(
      (e) => e.type === "run.error" && (e.data as { event?: string }).event === "source.crashed",
    );
    expect(crashes).toHaveLength(1);
    expect((crashes[0]!.data as { error: string }).error).toBe("post-restart crash");
  });

  it("stderr ring buffer resets on start (no bleed across restart)", async () => {
    const source = makeStdioSource();
    const stream1 = new PassThrough();
    source._attachStderrReaderForTesting(stream1);
    stream1.write("old instance line\n");
    expect(source._stderrTailForTesting()).toEqual(["old instance line"]);

    // Simulate the start() reset path. start() itself spawns a real
    // process for stdio mode; we just verify the documented invariant
    // that fresh state at the top of start() clears the tail.
    await source
      .start()
      .catch(() => {
        // `true` is a real binary that exits cleanly with no MCP handshake;
        // we expect start() to fail at the handshake. What we care about
        // is that the stderr buffer was reset at the top of start() before
        // anything else — including the failure — happened.
      });

    // Tail should not contain the "old instance line" anymore.
    const tail = source._stderrTailForTesting();
    expect(tail.includes("old instance line")).toBe(false);
  });
});
