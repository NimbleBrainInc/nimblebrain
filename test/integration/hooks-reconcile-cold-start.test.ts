import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hookPortForSource } from "../../src/hooks/provisioning.ts";
import {
  ensureHooks,
  ensureHooksOnRunning,
  type HookReconcileDeps,
  stopAllHookWatches,
  stopWatchingHooks,
} from "../../src/hooks/reconcile.ts";
import { listRegistrations } from "../../src/hooks/registrations.ts";
import type { HookIdentity } from "../../src/hooks/token.ts";
import type { HookDeclaration } from "../../src/hooks/types.ts";
import type { Tool, ToolResult } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

/**
 * Provisioning a declared stream against a connection that is cold — a source
 * whose tools are not enumerable yet, and one that comes back after the single
 * transition to `running` has already been spent.
 *
 * Both are ordinary states of a source, and both used to end with a permanent,
 * false report that the connector declared a registration tool it does not
 * serve. What the connector's server actually advertises is a REGISTRY tool
 * list — every name qualified `<source>__<tool>` — while a declaration names
 * the bare tool, so this suite drives the reconcile through the same port
 * adapter the runtime builds rather than through a hand-written bare list: a
 * mock that answers in the vocabulary the check happens to want cannot fail
 * when the two vocabularies disagree.
 */

const IDENTITY: HookIdentity = { tid: "tenant-a", key: randomBytes(32) };
const CONNECTOR = "acme-billing-mcp";
const OTHER_CONNECTOR = "acme-shipping-mcp";

const DECL: HookDeclaration = {
  vendor: "acme",
  route: "/ingest/acme",
  register_tool: "set_webhook_url",
};

/** A tool as the REGISTRY advertises it: qualified with its source. */
function advertised(bareName: string): Tool {
  return {
    name: `${CONNECTOR}__${bareName}`,
    description: "Register a webhook URL",
    inputSchema: {
      type: "object",
      properties: { vendor: { type: "string" }, url: { type: "string" } },
    },
    source: `mcpb:${CONNECTOR}`,
  };
}

/**
 * A stand-in for the connector's live source, with the two moving parts a cold
 * connection has: a tool list that can populate after the fact, and the
 * tool-set signal a real source emits when it does.
 */
function makeSource(initial: Tool[]) {
  let tools = initial;
  const listeners = new Set<() => void>();
  const calls: { tool: string; vendor: string; url: string }[] = [];
  /** How many passes have read the tool list — one per provisioning attempt. */
  let toolsReads = 0;
  /** When set, the next read holds open until `releaseRead` — a `tools/list` on the wire. */
  let parkNext = false;
  let release: (() => void) | null = null;
  return {
    calls,
    toolsReads: () => toolsReads,
    /** Hold the next tool-list read open, so a change can land while it is outstanding. */
    parkNextRead(): void {
      parkNext = true;
    },
    isParked: () => release !== null,
    releaseRead(): void {
      release?.();
      release = null;
    },
    /** Populate the tool list and fire the signal, as a source completing its connect does. */
    advertise(next: Tool[]): void {
      tools = next;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
    source: {
      tools: async (): Promise<Tool[]> => {
        toolsReads++;
        // A read answers with the list as it stood when the read STARTED. That
        // is what makes a change landing mid-read invisible to it.
        const atEntry = tools;
        if (parkNext) {
          parkNext = false;
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return atEntry;
      },
      execute: async (toolName: string, input: Record<string, unknown>): Promise<ToolResult> => {
        calls.push({
          tool: toolName,
          vendor: String(input.vendor),
          url: String(input.url),
        });
        return { content: [], isError: false };
      },
      subscribeToolsChanged: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

function makeDeps(
  source: ReturnType<typeof makeSource>["source"] | undefined,
  over: Partial<HookReconcileDeps> = {},
): HookReconcileDeps {
  return {
    workspaceStore: store,
    identity: IDENTITY,
    declarationsFor: async () => [DECL],
    portFor: () => (source ? hookPortForSource(source) : undefined),
    ...over,
  };
}

/** Let a fire-and-forget reconcile that has read its tool list run to completion. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

/** Poll until `check` holds, so a fire-and-forget reconcile can be asserted on. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let workDir: string;
let cleanup: () => void;
let store: WorkspaceStore;
let wsId: string;

beforeEach(async () => {
  ({ workDir, cleanup } = makeTestWorkDir("hooks-cold-start"));
  store = new WorkspaceStore(workDir);
  wsId = (await store.create("Cold Start")).id;
});

afterEach(() => {
  stopWatchingHooks(wsId, CONNECTOR);
  cleanup();
});

describe("a connector whose tools are advertised the way the registry advertises them", () => {
  test("provisions the stream and calls the registration tool by its bare name", async () => {
    const fake = makeSource([advertised("set_webhook_url"), advertised("list_invoices")]);

    const provisioned = await ensureHooks(makeDeps(fake.source), wsId, CONNECTOR);

    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]?.registered).toBe(true);
    // `execute` takes the bare name — the registry strips the prefix before
    // dispatch, and the port has to hand over the same form.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.tool).toBe("set_webhook_url");
    expect(listRegistrations((await store.get(wsId)) ?? {})).toHaveLength(1);
  });
});

describe("a source that is running but has advertised nothing yet", () => {
  test("defers instead of reporting a broken contract", async () => {
    const fake = makeSource([]);

    // An empty list is not evidence of a missing tool. Nothing is written, so
    // nothing is half done, and no manifest is accused of a fault it lacks.
    expect(await ensureHooks(makeDeps(fake.source), wsId, CONNECTOR)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(listRegistrations((await store.get(wsId)) ?? {})).toEqual([]);
  });

  test("provisions once the tools arrive, without a reinstall or a runtime restart", async () => {
    const fake = makeSource([]);
    const deps = makeDeps(fake.source);

    ensureHooksOnRunning(deps, wsId, CONNECTOR);
    // The first pass must be finished before the tools arrive, or it could read
    // the populated list itself and the retrigger would go untested.
    await until(() => fake.toolsReads() === 1, "the first pass to read the tool list");
    await settle();
    expect(fake.calls).toHaveLength(0);
    expect(fake.listenerCount()).toBe(1);

    // The source finishes coming up and its tool set becomes enumerable. That
    // signal is the retrigger: `running` has already fired and will not fire
    // again.
    fake.advertise([advertised("set_webhook_url")]);

    await until(() => fake.calls.length === 1, "the retriggered provision");
    expect(fake.toolsReads()).toBe(2);
    expect(fake.calls[0]?.tool).toBe("set_webhook_url");
    expect(listRegistrations((await store.get(wsId)) ?? {})).toHaveLength(1);
  });

  test("a tool set that changes mid-read is not answered by the read that missed it", async () => {
    // `singleFlight` coalesces concurrent provisioning for a connector, and for
    // the install/running pair it was written for that is right — they ask the
    // same question at the same moment. A retrigger does not: its whole content
    // is "the list you read is stale", so being handed that pass's answer
    // consumes the one notice that a re-read was needed.
    const fake = makeSource([]);
    const deps = makeDeps(fake.source);

    fake.parkNextRead();
    ensureHooksOnRunning(deps, wsId, CONNECTOR);
    await until(() => fake.isParked(), "the pass to be reading the tool list");

    // The server finishes registering its tools and pushes the change while
    // that read is still outstanding.
    fake.advertise([advertised("set_webhook_url")]);
    await settle();
    // The retrigger reached the flight and joined it rather than reading for
    // itself — without this the test would pass on the serialized ordering the
    // case above already covers.
    expect(fake.toolsReads()).toBe(1);

    // The parked read now answers with the list as it stood BEFORE the change.
    fake.releaseRead();

    await until(() => fake.calls.length === 1, "the pass queued behind the stale one");
    expect(listRegistrations((await store.get(wsId)) ?? {})).toHaveLength(1);
  });

  test("a reconnect after a live registration re-registers nothing", async () => {
    const fake = makeSource([advertised("set_webhook_url")]);
    const deps = makeDeps(fake.source);

    ensureHooksOnRunning(deps, wsId, CONNECTOR);
    await until(() => fake.calls.length === 1, "the first provision");

    // A source reconnecting re-emits the signal. `onlyMissing` filters the
    // declaration set to empty before anything reaches the server, so the
    // vendor's API is not called again for a stream that is already live.
    await settle();
    fake.advertise([advertised("set_webhook_url")]);
    await settle();

    expect(fake.calls).toHaveLength(1);
  });

  test("the watch is dropped when the connector is uninstalled", async () => {
    const fake = makeSource([]);
    ensureHooksOnRunning(makeDeps(fake.source), wsId, CONNECTOR);
    await until(() => fake.toolsReads() === 1, "the first pass to read the tool list");
    await settle();
    expect(fake.listenerCount()).toBe(1);

    stopWatchingHooks(wsId, CONNECTOR);

    expect(fake.listenerCount()).toBe(0);
    fake.advertise([advertised("set_webhook_url")]);
    await settle();
    expect(fake.calls).toHaveLength(0);
  });

  test("every watch is dropped when the runtime shuts down", async () => {
    // The map outlives the runtime that filled it: each entry holds the
    // unsubscribe closure, its source, and through the listener's `deps` the
    // runtime itself, so a shutdown that only removes sources leaves all three
    // reachable. `Runtime.shutdown()` calls this drain for that reason.
    const first = makeSource([]);
    const second = makeSource([]);
    ensureHooksOnRunning(makeDeps(first.source), wsId, CONNECTOR);
    ensureHooksOnRunning(makeDeps(second.source), wsId, OTHER_CONNECTOR);
    await until(
      () => first.toolsReads() === 1 && second.toolsReads() === 1,
      "both passes to read their tool lists",
    );
    await settle();
    expect(first.listenerCount()).toBe(1);
    expect(second.listenerCount()).toBe(1);

    stopAllHookWatches();

    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(0);
    first.advertise([advertised("set_webhook_url")]);
    second.advertise([advertised("set_webhook_url")]);
    await settle();
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });
});

describe("a source that genuinely does not serve the declared registration tool", () => {
  test("still raises, and names what the server actually advertises", async () => {
    const fake = makeSource([advertised("list_invoices"), advertised("create_invoice")]);

    const err = await ensureHooks(makeDeps(fake.source), wsId, CONNECTOR).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("set_webhook_url");
    // The reader is shown the observed list, not sent back to a manifest that
    // is correct.
    expect(String(err)).toContain("list_invoices");
    expect(listRegistrations((await store.get(wsId)) ?? {})).toEqual([]);
  });
});
