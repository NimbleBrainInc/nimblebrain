/**
 * The Composio transport credential.
 *
 * The invariant under test: **persisted state names what credential it needs,
 * never where the value comes from.** A Composio ref names the `composio`
 * credential provider, so it resolves the same whether the broker credential
 * lives in `nimblebrain.json` or the environment.
 *
 * Nothing here mocks `@composio/core`. The credential path is vendor-free, so a
 * vendor load would itself be the bug.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import {
  COMPOSIO_CREDENTIAL_PROVIDER,
  composioCredentialProvider,
  registerComposioCredentialProvider,
} from "../../src/connectors/providers/composio/transport-credential.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import type { RemoteTransportConfig } from "../../src/connectors/runtime/types.ts";
import { createRemoteTransport } from "../../src/tools/remote-transport.ts";

const ENV_KEYS = ["COMPOSIO_API_KEY", "COMPOSIO_API_BASE_URL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
});

/** The transport a Composio install persists into `workspace.json`. */
const PROVIDER_AUTH: RemoteTransportConfig = {
  type: "streamable-http",
  auth: { type: "provider", provider: COMPOSIO_CREDENTIAL_PROVIDER, config: {} },
  headers: { "x-trace": "keep-me" },
};

describe("the credential provider attaches the resolved broker key", () => {
  it("reads the key from the environment", () => {
    process.env.COMPOSIO_API_KEY = "k_env";
    expect(composioCredentialProvider.credentialFor(undefined, {})).toEqual({
      headers: { "x-api-key": "k_env" },
    });
  });

  it("reads the key from the declared block — the point of the seam", () => {
    // This is what the env template made impossible: with the credential named
    // rather than located, a declared key reaches an installed connector.
    setConnectorsConfig({ providers: { composio: { apiKey: "k_config" } } });
    _resetComposioConfigForTest();

    expect(composioCredentialProvider.credentialFor(undefined, {})).toEqual({
      headers: { "x-api-key": "k_config" },
    });
  });

  it("is workspace-independent — one broker account serves the tenant", () => {
    process.env.COMPOSIO_API_KEY = "k_env";
    const a = composioCredentialProvider.credentialFor("ws_00079598e311c160", {});
    const b = composioCredentialProvider.credentialFor("ws_001c32f121060ff3", {});
    expect(a).toEqual(b);
  });

  it("throws rather than attaching an empty header when unconfigured", () => {
    // An empty `x-api-key` is a silent 401 at first tool call — the failure mode
    // this seam exists to remove. Fail at source start, naming the cause.
    expect(() => composioCredentialProvider.credentialFor(undefined, {})).toThrow(
      /no broker credential configured/,
    );
  });
});

describe("registration happens at the composition root", () => {
  // Whether `Runtime.start` actually performs the registration is pinned by
  // `test/integration/composio-credential-boot.test.ts` — asserting it here
  // would only prove that calling the register function registers.

  it("resolves a config-only key onto an installed ref's transport header — the headline case", async () => {
    // End to end in one test: broker credential declared ONLY in
    // nimblebrain.json, nothing in the environment. Asserting the header VALUE,
    // not just that nothing threw — the two halves passing separately is what
    // let the boot-ordering bug through.
    delete process.env.COMPOSIO_API_KEY;
    setConnectorsConfig({ providers: { composio: { apiKey: "k_config" } } });
    _resetComposioConfigForTest();
    const { registerComposioCredentialProvider } = await import(
      "../../src/connectors/providers/composio/transport-credential.ts"
    );
    const { createRemoteTransport } = await import("../../src/tools/remote-transport.ts");
    registerComposioCredentialProvider();

    const transport = await createRemoteTransport(
      new URL("https://composio.test/mcp"),
      PROVIDER_AUTH,
      undefined,
      {},
    );
    const seen: Headers[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    try {
      await transport.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen.at(-1)?.get("x-api-key")).toBe("k_config");
  });

  it("builds a transport for an installed ref once the provider is registered", async () => {
    const { registerComposioCredentialProvider } = await import(
      "../../src/connectors/providers/composio/transport-credential.ts"
    );
    const { createRemoteTransport } = await import("../../src/tools/remote-transport.ts");
    process.env.COMPOSIO_API_KEY = "k_env";
    registerComposioCredentialProvider();

    // The end-to-end path a boot-start takes: persisted ref → transport.
    await expect(
      createRemoteTransport(new URL("https://composio.test/mcp"), PROVIDER_AUTH, undefined, {}),
    ).resolves.toBeDefined();
  });
});

describe("the transport's own SSRF posture, not just the URL gate's", () => {
  // `startAuthInner` (Reconnect / `POST /v1/workspaces/:wsId/mcp-auth/initiate`) builds its source
  // WITHOUT calling `validateConnectorUrl` — grep it: the only call sites are
  // `startup.ts`, `ssrf-guarded-fetch.ts` and `workspace-oauth-provider.ts`. So on
  // that path `isMintedFleetSource` inside `createRemoteTransport` is the ONLY
  // thing deciding whether a brokered session URL reaches an in-cluster service
  // over plain HTTP. `ref-transport-resolution.test.ts` covers the boot path's
  // gate; this covers the transport's.
  const IN_CLUSTER = "http://composio-session.mcp-shared.svc.cluster.local/mcp";

  async function guardedFetchFor(provider: string): Promise<(u: string) => Promise<unknown>> {
    const transport = await createRemoteTransport(new URL(IN_CLUSTER), {
      type: "streamable-http",
      auth: { type: "provider", provider, config: {} },
    } as never);
    return (transport as unknown as Record<string, (u: string) => Promise<unknown>>)._fetch;
  }

  it("refuses an in-cluster plain-HTTP target for a brokered Composio session", async () => {
    // The regression: widening this back to `auth.type === "provider"` grants a
    // vendor-supplied, tenant-persisted session URL the fleet rail's exception.
    process.env.COMPOSIO_API_KEY = "k_env";
    registerComposioCredentialProvider();

    const guarded = await guardedFetchFor("composio");
    await expect(guarded(IN_CLUSTER)).rejects.toThrow(/HTTPS|http/i);
  });
});
