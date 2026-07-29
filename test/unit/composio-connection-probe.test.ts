import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ProbeTarget } from "../../src/bundles/connection-probe.ts";
import type { ConnectorDirectory } from "../../src/registries/directory.ts";
import { setConnectorsConfig } from "../../src/connectors/providers/config.ts";
// Drive the probe through the `@composio/core` vendor seam — the same seam the
// sibling composio suites mock — never the internal `sdk.ts`. `mock.module` is
// process-global and is never torn down at file boundaries; mocking `sdk.ts`
// (which nothing else re-registers) bleeds a stale stub into every sibling that
// imports it. `@composio/core` IS re-registered by those siblings, so a bleed of
// it self-heals. `findActiveComposioConnection` calls straight into
// `connectedAccounts.list`, so driving that one list result exercises the probe.
let activeResult: { id: string; status: string } | null = null;
let activeThrows = false;
/** Args the probe's list call carried — the seam the resolved auth-config id reaches. */
let listArgs: { authConfigIds?: string[] } | undefined;
mock.module("@composio/core", () => ({
  // Shape-complete vendor seam. bun's `mock.module` is process-global and
  // file-order sensitive, so every `@composio/core` registration must export
  // `AuthScheme` — read by sdk.ts's connectComposioApiKey — even where the suite
  // never calls it; omitting it leaves the key `undefined` under some discovery
  // orders and flakes CI.
  AuthScheme: {
    APIKey: (params: Record<string, string>) => ({
      authScheme: "API_KEY",
      val: { status: "ACTIVE", ...params },
    }),
  },
  Composio: class {
    connectedAccounts = {
      list: async (args: { authConfigIds?: string[] }) => {
        listArgs = args;
        if (activeThrows) throw new Error("composio API down");
        return { items: activeResult ? [activeResult] : [] };
      },
    };
  },
}));

const { ComposioConnectionProbe } = await import("../../src/connectors/providers/composio/connection-probe.ts");
const { _resetComposioConfigForTest } = await import("../../src/connectors/providers/composio/config.ts");
const { _resetConnectorsConfigForTest, setConnectorsConfig } = await import(
  "../../src/connectors/providers/config.ts"
);

/** The toolkit the fake catalog entry fronts — the key `authConfigs` is read under. */
const TOOLKIT = "teams";

/** A catalog entry for TOOLKIT — the only shape entries carry. */
function fakeDirectory(): ConnectorDirectory {
  return {
    catalogById: async () => ({ composio: { toolkit: TOOLKIT } }),
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
const ENV_KEYS = ["COMPOSIO_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  activeResult = null;
  activeThrows = false;
  listArgs = undefined;
  // `findActiveComposioConnection` now runs for real (driven by the mocked
  // vendor seam), so reset the process-cached config between tests.
  _resetComposioConfigForTest();
  setConnectorsConfig({ providers: { composio: { authConfigs: { [TOOLKIT]: "ac_probe" } } } });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // The declared block is a module singleton — leaving one installed would
  // resolve ids for whatever suite runs next in this process.
  _resetConnectorsConfigForTest();
});

describe("ComposioConnectionProbe — config gating returns indeterminate (never flips)", () => {
  it("aborted signal → indeterminate", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), AbortSignal.abort())).toBe("indeterminate");
  });

  it("missing COMPOSIO_API_KEY → indeterminate", async () => {
    delete process.env.COMPOSIO_API_KEY;
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
  });

  it("ref without composio connectorId → indeterminate", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target(undefined), live)).toBe("indeterminate");
  });

  it("toolkit with no declared auth-config id → indeterminate", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    setConnectorsConfig({ providers: { composio: { authConfigs: {} } } });
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
  });
});

/**
 * The probe is one of the readers that resolve through
 * `composioAuthConfigId(toolkit)`, and the only one whose
 * failure is silent: an unresolved id is `indeterminate` on every sweep, so a
 * connection whose vendor account lapsed never flips to `reauth_required` and
 * nothing is logged. Asserting the id reaches the vendor call — not just that a
 * verdict was reached — is what makes that regression visible.
 */
describe("ComposioConnectionProbe — auth-config id resolution", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k";
    activeResult = { id: "ca_1", status: "ACTIVE" };
  });

  it("resolves the declared authConfigs id and probes against it", async () => {
    // The only wired state a catalog entry can be in: the id comes from the
    // declared block, keyed by the toolkit the entry names.
    setConnectorsConfig({ providers: { composio: { authConfigs: { [TOOLKIT]: "ac_declared" } } } });

    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("live");
    expect(listArgs?.authConfigIds).toEqual(["ac_declared"]);
  });

  it("toolkit the deployment declined to wire → indeterminate (never a flip)", async () => {
    // The catalog is a menu, so an unwired toolkit is a normal state and must
    // not be read as a lost credential.
    setConnectorsConfig({ providers: { composio: { authConfigs: {} } } });
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
    expect(listArgs).toBeUndefined();
  });
});

describe("ComposioConnectionProbe — verdict mapping", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k";
  });

  it("an ACTIVE connected account → live", async () => {
    activeResult = { id: "ca_1", status: "ACTIVE" };
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("live");
  });

  it("no ACTIVE account (null) → credential_lost", async () => {
    activeResult = null;
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("credential_lost");
  });

  it("API error → indeterminate (never a flip)", async () => {
    activeThrows = true;
    const p = new ComposioConnectionProbe(fakeDirectory());
    expect(await p.probe(target("com.x"), live)).toBe("indeterminate");
  });
});
