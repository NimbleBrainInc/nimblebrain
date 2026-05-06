import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SseEventManager } from "../../src/api/events.ts";

/**
 * Drain an SSE ReadableStream into the list of `event: <type>` lines it has
 * emitted so far. We don't need to parse the full SSE frame — the event-name
 * prefix is enough to assert which events landed on which client.
 *
 * Heartbeat is filtered out because the manager is constructed with a long
 * interval in these tests; it should never appear unless one of the cases
 * sleeps past 1s, which they don't.
 */
function collect(stream: ReadableStream<Uint8Array>): {
  events: string[];
  release: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let stopped = false;

  void (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event: ")) {
            const name = line.slice("event: ".length).trim();
            if (name && name !== "heartbeat") events.push(name);
          }
        }
      }
    } catch {
      // Reader released — fine.
    }
  })();

  return {
    events,
    release: () => {
      stopped = true;
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Yield to the event loop so the per-client reader's pending `await
 * reader.read()` resolves and the chunk lands in the collector. One
 * `setTimeout(0)` is enough — chunks are enqueued synchronously by the
 * manager and the reader is drained by a microtask continuation.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SseEventManager — routing table", () => {
  let mgr: SseEventManager;
  const released: Array<() => void> = [];

  beforeEach(() => {
    // Long heartbeat so it doesn't pollute event collectors during async
    // assertions. Manager is started so the heartbeat timer is owned and
    // `stop()` cleans it up — same as production wiring.
    mgr = new SseEventManager(1_000_000);
    mgr.start();
  });

  afterEach(() => {
    for (const r of released.splice(0)) r();
    mgr.stop();
  });

  test("connection.state_changed is forwarded to the matching workspace only", async () => {
    const wsA = collect(mgr.addClient("ws_a"));
    const wsB = collect(mgr.addClient("ws_b"));
    released.push(wsA.release, wsB.release);

    mgr.emit({
      type: "connection.state_changed",
      data: {
        wsId: "ws_a",
        serverName: "granola",
        bundleName: "https://granola.test/",
        principalId: "_workspace",
        state: "running",
      },
    });
    await flush();

    expect(wsA.events).toContain("connection.state_changed");
    expect(wsB.events).not.toContain("connection.state_changed");
  });

  test("bundle.* events are workspace-scoped", async () => {
    const wsA = collect(mgr.addClient("ws_a"));
    const wsB = collect(mgr.addClient("ws_b"));
    released.push(wsA.release, wsB.release);

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "ipinfo", bundleName: "@nb/ipinfo" },
    });
    mgr.emit({
      type: "bundle.crashed",
      data: { wsId: "ws_b", serverName: "granola", bundleName: "https://x" },
    });
    await flush();

    expect(wsA.events).toEqual(["bundle.installed"]);
    expect(wsB.events).toEqual(["bundle.crashed"]);
  });

  test("workspace-scoped event with missing wsId is dropped (no global fan-out)", async () => {
    const wsA = collect(mgr.addClient("ws_a"));
    const wsB = collect(mgr.addClient("ws_b"));
    released.push(wsA.release, wsB.release);

    // wsId field absent on a workspace-scoped event — emitter bug. The
    // alternative (broadcast to all) leaks one workspace's signals to its
    // neighbors, so the manager refuses.
    mgr.emit({
      type: "bundle.installed",
      data: { serverName: "x", bundleName: "y" } as Record<string, unknown>,
    });
    await flush();

    expect(wsA.events).toEqual([]);
    expect(wsB.events).toEqual([]);
  });

  test("global-scope events reach all clients regardless of workspace", async () => {
    const wsA = collect(mgr.addClient("ws_a"));
    const wsB = collect(mgr.addClient("ws_b"));
    const noWs = collect(mgr.addClient(undefined));
    released.push(wsA.release, wsB.release, noWs.release);

    mgr.emit({ type: "config.changed", data: { key: "models.default" } });
    mgr.emit({
      type: "skill.created",
      data: { id: "/skills/x", name: "x", scope: "user", type: "skill" },
    });
    await flush();

    expect(wsA.events).toEqual(["config.changed", "skill.created"]);
    expect(wsB.events).toEqual(["config.changed", "skill.created"]);
    expect(noWs.events).toEqual(["config.changed", "skill.created"]);
  });

  test("unrouted event types (tool.progress, run.error) are dropped", async () => {
    const ws = collect(mgr.addClient("ws_a"));
    released.push(ws.release);

    mgr.emit({
      type: "tool.progress",
      data: { source: "x", tool: "y", status: "working" },
    });
    mgr.emit({
      type: "run.error",
      data: { source: "x", event: "source.crashed", error: "boom" },
    });
    await flush();

    expect(ws.events).toEqual([]);
  });

  test("bridge.tool.* events scope by workspaceId (not wsId)", async () => {
    // Bridge events from handlers.ts use `workspaceId` as the field name —
    // pre-existing payload shape, codified in the routing table.
    const wsA = collect(mgr.addClient("ws_a"));
    const wsB = collect(mgr.addClient("ws_b"));
    released.push(wsA.release, wsB.release);

    mgr.emit({
      type: "bridge.tool.call",
      data: {
        name: "x__y",
        id: "api_1",
        server: "x",
        userId: null,
        workspaceId: "ws_a",
      },
    });
    await flush();

    expect(wsA.events).toContain("bridge.tool.call");
    expect(wsB.events).not.toContain("bridge.tool.call");
  });
});
