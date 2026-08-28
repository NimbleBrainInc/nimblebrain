import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureHooks, type HookReconcileDeps } from "../../src/hooks/reconcile.ts";
import { listRegistrations } from "../../src/hooks/registrations.ts";
import { type HookIdentity, openHookToken } from "../../src/hooks/token.ts";
import type { HookDeclaration } from "../../src/hooks/types.ts";
import type { Tool, ToolResult } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

/**
 * A fresh install reaches provisioning from two directions at once: the
 * connection-reached-running observer, fired from inside the awaited
 * `startBundleSource`, and the install handler on the line after the eager
 * start returns.
 *
 * Without coalescing, both read the workspace before either writes, both see no
 * registration, and both mint — two divergent kids, one persisted, neither
 * recorded as the other's `prevKid`, and the server handed two different URLs.
 * Which URL the server keeps is independent of which write landed, so the
 * connector can be left registered on a kid the door will never admit: every
 * delivery 404s permanently while the registration looks healthy.
 */

const IDENTITY: HookIdentity = { tid: "tenant-a", key: randomBytes(32) };
const CONNECTOR = "acme-billing-mcp";

const DECL: HookDeclaration = {
  vendor: "acme",
  route: "/ingest/acme",
  register_tool: "set_webhook_url",
};

const REGISTER_TOOL: Tool = {
  name: "set_webhook_url",
  description: "Register a webhook URL",
  inputSchema: {
    type: "object",
    properties: { vendor: { type: "string" }, url: { type: "string" } },
  },
  source: CONNECTOR,
};

let workDir: string;
let cleanup: () => void;
let store: WorkspaceStore;
let wsId: string;
/** Every `register_tool` call the reconcile made, with the URL it handed over. */
let registered: { vendor: string; url: string }[] = [];

function makeDeps(over: Partial<HookReconcileDeps> = {}): HookReconcileDeps {
  return {
    workspaceStore: store,
    identity: IDENTITY,
    declarationsFor: async () => [DECL],
    portFor: () => ({
      tools: async () => [REGISTER_TOOL],
      execute: async (_tool: string, input: Record<string, unknown>): Promise<ToolResult> => {
        // A real vendor round-trip takes time; that latency is what lets two
        // racing provisions interleave their writes and their registrations.
        await new Promise((r) => setTimeout(r, 5));
        registered.push({ vendor: String(input.vendor), url: String(input.url) });
        return { content: [], isError: false };
      },
    }),
    ...over,
  };
}

beforeEach(async () => {
  ({ workDir, cleanup } = makeTestWorkDir("hooks-singleflight"));
  store = new WorkspaceStore(workDir);
  wsId = (await store.create("Reconcile Test")).id;
  registered = [];
});

afterEach(() => cleanup());

describe("concurrent provisioning of one stream", () => {
  test("mints once, registers once, and persists the kid it handed over", async () => {
    const deps = makeDeps();
    // The observer's shape and the install handler's shape, started together —
    // the exact overlap `eagerStartRemoteSource` produces.
    const [observer, install] = await Promise.all([
      ensureHooks(deps, wsId, CONNECTOR, { onlyMissing: true }),
      ensureHooks(deps, wsId, CONNECTOR),
    ]);

    expect(registered).toHaveLength(1);

    const ws = await store.get(wsId);
    const regs = listRegistrations(ws ?? {});
    expect(regs).toHaveLength(1);
    const persisted = regs[0];

    // A first mint has nothing to rotate out of, so a `prevKid` here would mean
    // a second mint silently overwrote a live registration.
    expect(persisted?.prevKid).toBeUndefined();

    // The URL the server was handed must OPEN to the kid the door will admit.
    // Substring-matching the URL would pass on a token that merely mentions the
    // kid; the failure this guards is the server holding a URL whose sealed kid
    // the door refuses, so the token has to be opened.
    const handedKid = openHookToken(
      registered[0]?.url.split("/").pop() ?? "",
      IDENTITY.key,
      IDENTITY.tid,
    ).kid;
    expect(handedKid).toBe(persisted?.kid);

    // Both callers observe the same outcome, because they shared one run.
    expect(observer.map((h) => h.kid)).toEqual([persisted?.kid]);
    expect(install.map((h) => h.kid)).toEqual([persisted?.kid]);
  });

  test("a later call re-runs rather than joining the finished one", async () => {
    const deps = makeDeps();
    await ensureHooks(deps, wsId, CONNECTOR);
    const before = registered.length;
    // The install path deliberately re-registers: the operator asked for it,
    // and it repairs a registration the server lost.
    await ensureHooks(deps, wsId, CONNECTOR);
    expect(registered.length).toBe(before + 1);
    // Re-registering must not mint a second kid.
    expect(listRegistrations((await store.get(wsId)) ?? {})).toHaveLength(1);
  });

  test("a rotation never coalesces into somebody else's run", async () => {
    const deps = makeDeps();
    await ensureHooks(deps, wsId, CONNECTOR);
    const first = listRegistrations((await store.get(wsId)) ?? {})[0];

    const [a, b] = await Promise.all([
      ensureHooks(deps, wsId, CONNECTOR, { rotate: true, onlyVendor: "acme" }),
      ensureHooks(deps, wsId, CONNECTOR),
    ]);

    // An operator who asked for a fresh URL has to get one, even if an ensure
    // was already in flight for the same connector.
    expect(a[0]?.kid).not.toBe(first?.kid);
    expect(b).toHaveLength(1);
  });

  test("two different connectors do not block each other", async () => {
    const deps = makeDeps();
    const [a, b] = await Promise.all([
      ensureHooks(deps, wsId, CONNECTOR),
      ensureHooks(deps, wsId, "other-mcp"),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(registered).toHaveLength(2);
  });

  test("a failed run does not pin later callers to the rejection", async () => {
    let calls = 0;
    const deps = makeDeps({
      declarationsFor: async () => {
        calls++;
        if (calls === 1) throw new Error("catalog unavailable");
        return [DECL];
      },
    });
    await expect(ensureHooks(deps, wsId, CONNECTOR)).rejects.toThrow("catalog unavailable");
    // The flight entry must have been cleared, or every later call inherits the
    // rejection for the life of the process.
    expect(await ensureHooks(deps, wsId, CONNECTOR)).toHaveLength(1);
  });
});

describe("a manifest that breaks the hook contract", () => {
  test("provisions nothing and names the offending declaration", async () => {
    // The check cannot precede the install commit — it needs the server's tool
    // list, and the source is not started until after the bundle ref is
    // written. So it throws, the caller turns it into a warning on a successful
    // install, and nothing is half-provisioned.
    const deps = makeDeps({
      portFor: () => ({
        tools: async () => [{ ...REGISTER_TOOL, name: "something_else" }],
        execute: async (): Promise<ToolResult> => ({ content: [], isError: false }),
      }),
    });
    await expect(ensureHooks(deps, wsId, CONNECTOR)).rejects.toThrow(/set_webhook_url/);
    expect(registered).toHaveLength(0);
    expect(listRegistrations((await store.get(wsId)) ?? {})).toEqual([]);
  });

  test("is re-checked on the next reconcile rather than firing once", async () => {
    // The install path reports it once; what keeps it from going quiet is that
    // every transition to `running` re-runs the same reconcile. Fixing the
    // manifest and reconnecting provisions the stream without a reinstall.
    let broken = true;
    const deps = makeDeps({
      portFor: () => ({
        tools: async () => [broken ? { ...REGISTER_TOOL, name: "wrong" } : REGISTER_TOOL],
        execute: async (_t: string, input: Record<string, unknown>): Promise<ToolResult> => {
          registered.push({ vendor: String(input.vendor), url: String(input.url) });
          return { content: [], isError: false };
        },
      }),
    });
    await expect(ensureHooks(deps, wsId, CONNECTOR, { onlyMissing: true })).rejects.toThrow();
    broken = false;
    await ensureHooks(deps, wsId, CONNECTOR, { onlyMissing: true });
    expect(registered).toHaveLength(1);
  });
});
