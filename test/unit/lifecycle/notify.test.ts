import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LifecycleContractError } from "../../../src/lifecycle/declaration.ts";
import {
  forgetReadyNotification,
  type LifecycleNotifyDeps,
  notifyReady,
  notifyReadyOnRunning,
  notifyRemoving,
  resetReadyNotifications,
} from "../../../src/lifecycle/notify.ts";
import type { LifecycleDeclaration } from "../../../src/lifecycle/types.ts";
import {
  type ConnectorPort,
  stopAllToolSurfaceWatches,
} from "../../../src/tools/connector-surface.ts";
import type { Tool, ToolResult } from "../../../src/tools/types.ts";

/**
 * Telling a connector it is installed, and telling it that it is going away.
 *
 * The case this suite exists for is the first one: a fresh install delivers a
 * call flavoured `install`, and neither the connection-running observer's
 * dedupe nor the hooks single-flight may swallow it. Without that assertion the
 * bug returns the next time somebody aligns the two paths, because aligning
 * them looks like a tidy-up.
 *
 * The other half of that pair — the hooks reconcile still coalescing its two
 * concurrent callers into one mint — is `hooks-reconcile-singleflight.test.ts`,
 * and `connector-lifecycle-notify.test.ts` drives both off one simulated
 * install.
 */

const WS = "ws_acme";
const CONNECTOR = "acme-billing-mcp";

const DECL: LifecycleDeclaration = {
  on_ready: "workspace_ready",
  on_removing: "workspace_removing",
};

/** A handler as a well-behaved server advertises it: no required arguments. */
function handler(name: string): Tool {
  return {
    name,
    description: "Lifecycle handler",
    inputSchema: { type: "object", properties: {} },
    source: CONNECTOR,
  };
}

interface Fake {
  calls: { tool: string; input: Record<string, unknown> }[];
  /** Populate the tool list and fire the tool-surface signal, as a connecting source does. */
  advertise(tools: Tool[]): void;
  port: ConnectorPort;
  /** Make the next `execute` fail, as an unreachable vendor would. */
  failNext(): void;
  listenerCount(): number;
}

function makeFake(tools: Tool[], notice = "Setting up your workspace — watch the panel."): Fake {
  let advertised = tools;
  let fail = false;
  const listeners = new Set<() => void>();
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    failNext: () => {
      fail = true;
    },
    listenerCount: () => listeners.size,
    advertise(next: Tool[]): void {
      advertised = next;
      for (const l of [...listeners]) l();
    },
    port: {
      tools: async () => advertised,
      execute: async (tool: string, input: Record<string, unknown>): Promise<ToolResult> => {
        calls.push({ tool, input });
        if (fail) {
          fail = false;
          return { content: [{ type: "text", text: "vendor unreachable" }], isError: true };
        }
        return { content: [{ type: "text", text: notice }], isError: false };
      },
      subscribeToolsChanged: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** `null` means the connector declares no lifecycle block at all. */
function makeDeps(fake: Fake | undefined, decl: LifecycleDeclaration | null = DECL) {
  const deps: LifecycleNotifyDeps = {
    declarationFor: async () => decl ?? undefined,
    portFor: () => fake?.port,
  };
  return deps;
}

/** Poll until `check` holds, so a fire-and-forget notification can be asserted on. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Let a fire-and-forget notification that has read its tool list run to completion. */
function settleTicks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  resetReadyNotifications();
});

afterEach(() => {
  stopAllToolSurfaceWatches();
  resetReadyNotifications();
});

describe("on_ready", () => {
  test("the install path calls with reason 'install' and carries the handler's words back", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);

    const outcome = await notifyReady(makeDeps(fake), WS, CONNECTOR, "install");

    expect(outcome.settled).toBe(true);
    expect(outcome.notice).toBe("Setting up your workspace — watch the panel.");
    expect(fake.calls).toEqual([
      { tool: "workspace_ready", input: { reason: "install" } },
    ]);
  });

  test("a fresh install is NOT swallowed by the observer's dedupe", async () => {
    // r4c1's regression test, and the reason this seam diverges from the hooks
    // reconcile. `singleFlight` exists to stop two concurrent MINTS diverging;
    // `on_ready` mints nothing, so joining the flight — or letting the
    // observer's success record suppress the install call — would tell a
    // freshly-installed connector `resume` and take the install notice with it.
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);
    const deps = makeDeps(fake);

    // The observer's shape and the install handler's shape, started together —
    // the exact overlap `eagerStartRemoteSource` produces.
    notifyReadyOnRunning(deps, WS, CONNECTOR);
    const outcome = await notifyReady(deps, WS, CONNECTOR, "install");
    await until(() => fake.calls.length === 2, "both notifications");

    expect(outcome.notice).toBeDefined();
    const reasons = fake.calls.map((c) => c.input.reason).sort();
    // Two calls, in a racy order, one of each flavour. At-least-once is the
    // contract and handlers are required to be idempotent; suppressing one
    // would need "an install is in progress" state the runtime does not hold.
    expect(reasons).toEqual(["install", "resume"]);
  });

  test("a second transition to running does not call again after the first success", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);
    const deps = makeDeps(fake);

    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await until(() => fake.calls.length === 1, "the first resume");

    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await settleTicks();
    // A set, not a timer: per boot is the whole guarantee, and a later
    // reconnect is suppressed by design.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.input).toEqual({ reason: "resume" });
  });

  test("a failed call is retried on the next transition", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);
    const deps = makeDeps(fake);
    fake.failNext();

    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await until(() => fake.calls.length === 1, "the failing resume");
    await settleTicks();

    // The failure never fails anything — but it must not be recorded as
    // delivered either, or the bundle never hears about this boot at all.
    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await until(() => fake.calls.length === 2, "the retry");
  });

  test("an uninstall re-arms it, so a reinstall is told it is a new installation", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);
    const deps = makeDeps(fake);
    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await until(() => fake.calls.length === 1, "the first resume");

    forgetReadyNotification(WS, CONNECTOR);
    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await until(() => fake.calls.length === 2, "the reinstall's resume");
  });

  test("a source that is not running defers, silently and without recording success", async () => {
    const deps = makeDeps(undefined);
    const outcome = await notifyReady(deps, WS, CONNECTOR, "install");
    expect(outcome).toEqual({ settled: false });
  });

  test("an empty tool list defers rather than accusing a correct manifest", async () => {
    // Every declared name is absent from an empty list, so checking one against
    // it would report a manifest that is correct. The tool-surface signal is
    // what brings the pass back when the list materializes.
    const fake = makeFake([]);
    const deps = makeDeps(fake);

    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await settleTicks();
    expect(fake.calls).toHaveLength(0);

    fake.advertise([handler("workspace_ready"), handler("workspace_removing")]);
    await until(() => fake.calls.length === 1, "the retriggered notification");
    expect(fake.calls[0]?.input).toEqual({ reason: "resume" });
  });

  test("a declared handler the server does not advertise is a contract error", async () => {
    const fake = makeFake([handler("something_else")]);
    await expect(notifyReady(makeDeps(fake), WS, CONNECTOR, "install")).rejects.toBeInstanceOf(
      LifecycleContractError,
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("a connector that declares no lifecycle block is a silent no-op", async () => {
    const fake = makeFake([handler("workspace_ready")]);
    const outcome = await notifyReady(makeDeps(fake, null), WS, CONNECTOR, "install");
    expect(outcome).toEqual({ settled: true });
    expect(fake.calls).toHaveLength(0);
  });

  test("a server that declares only on_removing settles without a call", async () => {
    // Nothing to call now and nothing to come back for — but its contract is
    // still checked here, where a violation can still be reported.
    const fake = makeFake([handler("workspace_removing")]);
    const deps = makeDeps(fake, { on_removing: "workspace_removing" });

    const outcome = await notifyReady(deps, WS, CONNECTOR, "install");
    expect(outcome).toEqual({ settled: true });
    expect(fake.calls).toHaveLength(0);

    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await settleTicks();
    notifyReadyOnRunning(deps, WS, CONNECTOR);
    await settleTicks();
    expect(fake.calls).toHaveLength(0);
  });

  test("a handler that returns no text produces no notice", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")], "");
    const outcome = await notifyReady(makeDeps(fake), WS, CONNECTOR, "install");
    expect(outcome).toEqual({ settled: true });
  });
});

describe("on_removing", () => {
  test("calls the declared handler with no arguments", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);
    await notifyRemoving(makeDeps(fake), WS, CONNECTOR);
    expect(fake.calls).toEqual([{ tool: "workspace_removing", input: {} }]);
  });

  test("a handler that errors does not raise", async () => {
    const fake = makeFake([handler("workspace_ready"), handler("workspace_removing")]);
    fake.failNext();
    await notifyRemoving(makeDeps(fake), WS, CONNECTOR);
    expect(fake.calls).toHaveLength(1);
  });

  test("a handler that throws does not raise", async () => {
    const deps: LifecycleNotifyDeps = {
      declarationFor: async () => DECL,
      portFor: () => ({
        tools: async () => [handler("workspace_removing")],
        execute: async () => {
          throw new Error("connection reset");
        },
      }),
    };
    // Blocking a user's uninstall on a vendor's availability would be the wrong
    // trade in both directions.
    await notifyRemoving(deps, WS, CONNECTOR);
  });

  test("a connector that is no longer running is skipped, not awaited", async () => {
    await notifyRemoving(makeDeps(undefined), WS, CONNECTOR);
  });

  test("a connector that declares no on_removing is a no-op", async () => {
    const fake = makeFake([handler("workspace_ready")]);
    await notifyRemoving(makeDeps(fake, { on_ready: "workspace_ready" }), WS, CONNECTOR);
    expect(fake.calls).toHaveLength(0);
  });
});
