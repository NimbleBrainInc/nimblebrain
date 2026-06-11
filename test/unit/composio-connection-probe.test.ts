import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ProbeTarget } from "../../src/bundles/connection-probe.ts";
import type { ConnectorDirectory } from "../../src/registries/directory.ts";

// Mock the SDK seam so the probe's verdict mapping can be tested without the
// network. Must be registered before the probe module is (dynamically) imported.
let activeResult: { id: string; status: string } | null = null;
let activeThrows = false;
mock.module("../../src/composio/sdk.ts", () => ({
  composioUserId: (wsId: string) => `user:${wsId}`,
  findActiveComposioConnection: async () => {
    if (activeThrows) throw new Error("composio API down");
    return activeResult;
  },
}));

const { ComposioConnectionProbe } = await import("../../src/composio/connection-probe.ts");

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
