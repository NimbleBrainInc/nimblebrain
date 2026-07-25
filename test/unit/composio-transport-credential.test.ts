/**
 * The Composio transport credential and the forward-mapping of legacy refs.
 *
 * The invariant under test: **persisted state names what credential it needs,
 * never where the value comes from.** A ref written today names the `composio`
 * credential provider; a ref written before the seam carries a
 * `${COMPOSIO_API_KEY}` env reference and is mapped forward on read, so both
 * resolve identically — including on a deploy whose broker credential lives in
 * `nimblebrain.json` rather than the environment.
 *
 * Nothing here mocks `@composio/core`. The credential path is vendor-free, so a
 * vendor load would itself be the bug.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RemoteTransportConfig } from "../../src/bundles/types.ts";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import {
  COMPOSIO_CREDENTIAL_PROVIDER,
  composioCredentialProvider,
  composioTransportConfig,
} from "../../src/connectors/providers/composio/transport-credential.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";

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

/** The shape a pre-seam install persisted into `workspace.json`. */
const LEGACY_AUTH: RemoteTransportConfig = {
  type: "streamable-http",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal legacy placeholder under test
  auth: { type: "header", name: "x-api-key", value: "${COMPOSIO_API_KEY}" },
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
    const a = composioCredentialProvider.credentialFor("ws_a", {});
    const b = composioCredentialProvider.credentialFor("ws_b", {});
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

describe("legacy refs map forward on read", () => {
  it("rewrites the env-template auth to name the provider", () => {
    const migrated = composioTransportConfig(LEGACY_AUTH);
    expect(migrated?.auth).toEqual({
      type: "provider",
      provider: COMPOSIO_CREDENTIAL_PROVIDER,
      config: {},
    });
  });

  it("preserves everything else on the ref", () => {
    const migrated = composioTransportConfig(LEGACY_AUTH);
    expect(migrated?.type).toBe("streamable-http");
    expect(migrated?.headers).toEqual({ "x-trace": "keep-me" });
  });

  it("is idempotent — an already-migrated ref passes through untouched", () => {
    const once = composioTransportConfig(LEGACY_AUTH);
    expect(composioTransportConfig(once)).toEqual(once);
  });

  it("leaves every other transport shape alone", () => {
    const untouched: RemoteTransportConfig[] = [
      { type: "streamable-http", auth: { type: "bearer", token: "t" } },
      { type: "streamable-http", auth: { type: "none" } },
      // Same header name, a different value — someone else's credential.
      { type: "streamable-http", auth: { type: "header", name: "x-api-key", value: "literal" } },
      // A different header carrying the legacy template — not Composio's auth.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder under test
      { type: "streamable-http", auth: { type: "header", name: "x-other", value: "${COMPOSIO_API_KEY}" } },
      { type: "streamable-http", auth: { type: "provider", provider: "minted", config: {} } },
    ];
    for (const config of untouched) {
      expect(composioTransportConfig(config)).toBe(config);
    }
    expect(composioTransportConfig(undefined)).toBeUndefined();
  });
});
