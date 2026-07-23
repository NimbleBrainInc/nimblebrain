import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ProbeTarget } from "../../src/bundles/connection-probe.ts";
import type { ConnectorDirectory } from "../../src/registries/directory.ts";
// Drive the probe through the `@composio/core` vendor seam — the same seam the
// sibling composio suites mock — never the internal `sdk.ts`. `mock.module` is
// process-global and is never torn down at file boundaries; mocking `sdk.ts`
// (which nothing else re-registers) bleeds a stale stub into every sibling that
// imports it. `@composio/core` IS re-registered by those siblings, so a bleed of
// it self-heals. `findActiveComposioConnection` calls straight into
// `connectedAccounts.list`, so driving that one list result exercises the probe.
let activeResult: { id: string; status: string } | null = null;
let activeThrows = false;
mock.module("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      list: async () => {
        if (activeThrows) throw new Error("composio API down");
        return { items: activeResult ? [activeResult] : [] };
      },
    };
  },
}));

const { ComposioConnectionProbe } = await import("../../src/composio/connection-probe.ts");
const { _resetComposioConfigForTest } = await import("../../src/composio/sdk.ts");

function fakeDirectory(authConfigEnv: string | undefined): ConnectorDirectory {
  return {
    catalogById: async () => (authConfigEnv ? { composio: { authConfigEnv } } : {}),
  } as unknown as ConnectorDirectory;
}

function target(connectorId: string | undefined): ProbeTarget {
  return {
    serverName: "teams",
    wsId: "ws_1",
    principalId: "_workspace",
    ref: (connectorId ? { url: "u", composio: { connectorId } } : { url: "u" }) as ProbeTarget["ref"],
  };
}

const live = new AbortController().signal;
const ENV_KEYS = ["COMPOSIO_API_KEY", "AUTH_CFG_X"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  activeResult = null;
  activeThrows = false;
  // `findActiveComposioConnection` now runs for real (driven by the mocked
  // vendor seam), so reset the process-cached config between tests.
  _resetComposioConfigForTest();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("ComposioConnectionProbe — config gating returns indeterminate (never flips)", () => {
  it("aborted signal → indeterminate", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    process.env.AUTH_CFG_X = "cfg";
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target("com.x"), AbortSignal.abort())).toBe("indeterminate");
  });

  it("missing COMPOSIO_API_KEY → indeterminate", async () => {
    delete process.env.COMPOSIO_API_KEY;
    process.env.AUTH_CFG_X = "cfg";
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
  });

  it("ref without composio connectorId → indeterminate", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target(undefined), live)).toBe("indeterminate");
  });

  it("auth config env var unset → indeterminate", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    delete process.env.AUTH_CFG_X;
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
  });
});

describe("ComposioConnectionProbe — verdict mapping", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k";
    process.env.AUTH_CFG_X = "cfg";
  });

  it("an ACTIVE connected account → live", async () => {
    activeResult = { id: "ca_1", status: "ACTIVE" };
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target("com.x"), live)).toBe("live");
  });

  it("no ACTIVE account (null) → credential_lost", async () => {
    activeResult = null;
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target("com.x"), live)).toBe("credential_lost");
  });

  it("API error → indeterminate (never a flip)", async () => {
    activeThrows = true;
    const p = new ComposioConnectionProbe(fakeDirectory("AUTH_CFG_X"));
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
  });
});
