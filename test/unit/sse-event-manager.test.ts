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

// ── Identity-scoped clients (the /v1/events route) ────────────────

/**
 * Minimal stand-in for the bits of `WorkspaceStore` the manager touches:
 * `getWorkspacesForUser` and `onMembershipChanged`. Avoids spinning up a
 * full store + temp dir for routing-only assertions.
 *
 * `setMemberships` mutates the per-user table and synchronously fires
 * the registered handlers, mirroring how the real store does it post-
 * write — that's the precise contract the manager depends on.
 */
function fakeWorkspaceStore() {
  const byUser = new Map<string, string[]>();
  const handlers = new Set<(userId: string) => void>();
  return {
    setMemberships(userId: string, wsIds: string[]): void {
      byUser.set(userId, wsIds);
      for (const h of handlers) h(userId);
    },
    // Subset of WorkspaceStore that SseEventManager uses. Cast at the
    // injection site to avoid pulling the real store's full surface
    // into the test.
    async getWorkspacesForUser(userId: string) {
      const ids = byUser.get(userId) ?? [];
      return ids.map((id) => ({ id }) as { id: string });
    },
    onMembershipChanged(handler: (userId: string) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

describe("SseEventManager — identity-scoped clients", () => {
  let store: ReturnType<typeof fakeWorkspaceStore>;
  let mgr: SseEventManager;
  const released: Array<() => void> = [];

  beforeEach(() => {
    store = fakeWorkspaceStore();
    // biome-ignore lint/suspicious/noExplicitAny: minimal store stub, see fakeWorkspaceStore docblock
    mgr = new SseEventManager(1_000_000, store as any);
    mgr.start();
  });

  afterEach(() => {
    for (const r of released.splice(0)) r();
    mgr.stop();
  });

  test("identity client receives workspace-scoped events only for member workspaces", async () => {
    // Alice is in ws_a; Bob is in ws_b. Each opens an identity-scoped
    // /v1/events stream. The fan-out gate is the cached membership set.
    const alice = collect(mgr.addIdentityClient("usr_alice", new Set(["ws_a"])));
    const bob = collect(mgr.addIdentityClient("usr_bob", new Set(["ws_b"])));
    released.push(alice.release, bob.release);

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "ipinfo", bundleName: "@nb/ipinfo" },
    });
    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_b", serverName: "granola", bundleName: "@nb/granola" },
    });
    await flush();

    expect(alice.events).toEqual(["bundle.installed"]);
    expect(bob.events).toEqual(["bundle.installed"]);
  });

  test("multi-workspace identity client receives events for any member workspace", async () => {
    // A user with membership in both workspaces — the everyday case for
    // an operator with a personal and a team workspace.
    const both = collect(mgr.addIdentityClient("usr_op", new Set(["ws_a", "ws_b"])));
    released.push(both.release);

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "ipinfo", bundleName: "@nb/ipinfo" },
    });
    mgr.emit({
      type: "connection.state_changed",
      data: {
        wsId: "ws_b",
        serverName: "granola",
        bundleName: "https://granola.test/",
        principalId: "_workspace",
        state: "running",
      },
    });
    await flush();

    expect(both.events).toEqual(["bundle.installed", "connection.state_changed"]);
  });

  test("global events still reach identity clients regardless of memberships", async () => {
    // Even a client with an empty membership set sees global broadcasts —
    // global events have no `wsId` and skip the membership filter.
    const empty = collect(mgr.addIdentityClient("usr_x", new Set()));
    released.push(empty.release);

    mgr.emit({ type: "config.changed", data: { key: "models.default" } });
    await flush();

    expect(empty.events).toEqual(["config.changed"]);
  });

  test("membership-change refresh delivers events for newly-added workspaces", async () => {
    // Alice starts with no workspaces. Workspace add → manager re-queries
    // and the next emit reaches her. This is the workspace-switch /
    // newly-invited path post-Stage-2, without an SSE reconnect.
    store.setMemberships("usr_alice", []);
    const alice = collect(mgr.addIdentityClient("usr_alice", new Set()));
    released.push(alice.release);

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "x", bundleName: "y" },
    });
    await flush();
    expect(alice.events).toEqual([]); // not yet a member

    // The workspace store fires a membership change — manager refreshes.
    store.setMemberships("usr_alice", ["ws_a"]);
    // Refresh is async (awaits getWorkspacesForUser); flush twice so the
    // promise-then microtask runs before the next emit.
    await flush();
    await flush();

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "x", bundleName: "z" },
    });
    await flush();

    expect(alice.events).toEqual(["bundle.installed"]);
  });

  test("membership-change refresh drops events for removed workspaces", async () => {
    // Alice was a member; removal → manager re-queries to an empty set;
    // subsequent emits for ws_a no longer reach her.
    store.setMemberships("usr_alice", ["ws_a"]);
    const alice = collect(mgr.addIdentityClient("usr_alice", new Set(["ws_a"])));
    released.push(alice.release);

    store.setMemberships("usr_alice", []);
    await flush();
    await flush();

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "x", bundleName: "y" },
    });
    await flush();

    expect(alice.events).toEqual([]);
  });

  test("identity client unaffected by other identities' membership changes", async () => {
    // Membership-change fires per-userId; the manager scans only matching
    // clients. Alice's set must not be churned by Bob's mutations.
    store.setMemberships("usr_alice", ["ws_a"]);
    store.setMemberships("usr_bob", ["ws_b"]);
    const alice = collect(mgr.addIdentityClient("usr_alice", new Set(["ws_a"])));
    released.push(alice.release);

    store.setMemberships("usr_bob", []);
    await flush();
    await flush();

    mgr.emit({
      type: "bundle.installed",
      data: { wsId: "ws_a", serverName: "x", bundleName: "y" },
    });
    await flush();

    expect(alice.events).toEqual(["bundle.installed"]);
  });
});
