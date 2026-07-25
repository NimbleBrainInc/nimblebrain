/**
 * Composio provider config resolution: the declared
 * `connectors.providers.composio` block, the `COMPOSIO_*` env fallback, and the
 * precedence between them.
 *
 * The contract under test splits on what the value *is*:
 *
 *   - **settings** (`baseUrl`, `monitor`) — block absent hydrates from env
 *     (back-compat; an upgrade breaks nothing); block present wins for every
 *     setting, and one warning names the env vars being ignored.
 *   - **the broker credential** — always `COMPOSIO_API_KEY`, never superseded,
 *     because an installed connector's persisted transport credential is an env
 *     reference into that name.
 *
 * Nothing here mocks `@composio/core` — config resolution is vendor-free by
 * construction, so the suite must never trigger a vendor load.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetComposioConfigForTest,
  COMPOSIO_API_BASE,
  validateComposioConfig,
} from "../../src/connectors/providers/composio/config.ts";
import {
  _resetConnectorsConfigForTest,
  type ComposioProviderConfig,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import { _resetBouncerModeForTest } from "../../src/oauth/bouncer-config.ts";

const ENV_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_API_BASE_URL",
  "COMPOSIO_MONITOR_ENABLED",
  "NB_TENANT_ID",
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
] as const;

let saved: Record<string, string | undefined>;

/**
 * Install a declared block and drop any resolution cached from an earlier read.
 * Production installs once at the composition root ahead of every read, so the
 * reset is a test-only affordance.
 *
 * (Named `declareComposio`, not `declare` — a function named `declare` parses as a
 * TypeScript ambient declaration and silently never runs.)
 */
function declareComposio(composio: ComposioProviderConfig): void {
  setConnectorsConfig({ providers: { composio } });
  _resetComposioConfigForTest();
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // Leaving a declared block installed would change the config source for every
  // sibling suite in the run — this module's state is process-wide.
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
});

describe("the broker credential is env-only", () => {
  it("reports not configured when COMPOSIO_API_KEY is unset", () => {
    const cfg = validateComposioConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.apiKey).toBe("");
  });

  it("stays unconfigured when only a settings block is declared", () => {
    // The block cannot supply a credential, so declaring one must not make the
    // provider look configured.
    declareComposio({ baseUrl: "https://composio.internal" });
    expect(validateComposioConfig().configured).toBe(false);
  });

  it("resolves from the env even when a block is declared", () => {
    // The load-bearing case: the documented posture — settings in the block,
    // credential in the secret store → env.
    process.env.COMPOSIO_API_KEY = "k_env";
    declareComposio({ baseUrl: "https://composio.internal" });

    const cfg = validateComposioConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.apiKey).toBe("k_env");
    expect(cfg.baseUrl).toBe("https://composio.internal");
  });
});

describe("settings — env fallback when no block is declared", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("hydrates every setting from the env", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://composio.example.com";

    expect(validateComposioConfig()).toMatchObject({
      configured: true,
      baseUrl: "https://composio.example.com",
      monitorEnabled: true,
    });
  });

  it("defaults the base URL", () => {
    expect(validateComposioConfig().baseUrl).toBe(COMPOSIO_API_BASE);
  });

  it("honors the monitor kill switch, and only on an explicit false", () => {
    // Absorbed from the deleted monitor-config suite: default ON, disabled only
    // by a case/whitespace-insensitive `false`, so a malformed value fails safe
    // to enabled rather than silently stopping the probe.
    for (const [value, expected] of [
      ["false", false],
      ["FALSE", false],
      ["  false ", false],
      ["true", true],
      ["yes", true],
      ["", true],
    ] as const) {
      process.env.COMPOSIO_MONITOR_ENABLED = value;
      _resetComposioConfigForTest();
      expect(validateComposioConfig().monitorEnabled).toBe(expected);
    }
  });

  it("rejects a non-http(s) COMPOSIO_API_BASE_URL (open-redirect mitigation)", () => {
    process.env.COMPOSIO_API_BASE_URL = "javascript:alert(1)";
    expect(() => validateComposioConfig()).toThrow(/http\(s\)/);
  });

  it("rejects a malformed COMPOSIO_API_BASE_URL", () => {
    process.env.COMPOSIO_API_BASE_URL = "not a url";
    expect(() => validateComposioConfig()).toThrow(/valid URL/);
  });

  it("requires NB_TENANT_ID in bouncer (multi-tenant) mode", () => {
    // Minimal bouncer config — both vars must be set or `getBouncerMode` throws
    // on the partial-config branch. NB_TENANT_ID intentionally unset.
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = "https://b.test/v1/mcp-auth/callback";
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = Buffer.alloc(32, 1).toString("base64");
    expect(() => validateComposioConfig()).toThrow(/NB_TENANT_ID/);
  });

  it("caches the resolution across calls (resolved once at startup)", () => {
    const first = validateComposioConfig();
    delete process.env.COMPOSIO_API_KEY;
    expect(validateComposioConfig()).toBe(first); // same object, no re-read
  });
});

describe("settings — the declared block", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("resolves every setting from the block", () => {
    declareComposio({
      baseUrl: "https://composio.internal",
      monitorEnabled: true,
    });

    expect(validateComposioConfig()).toMatchObject({
      configured: true,
      baseUrl: "https://composio.internal",
      monitorEnabled: true,
    });
  });

  it("defaults the settings an empty block leaves out", () => {
    declareComposio({});
    const cfg = validateComposioConfig();
    expect(cfg.baseUrl).toBe(COMPOSIO_API_BASE);
    expect(cfg.monitorEnabled).toBe(true);
  });

  it("honors monitor.enabled: false", () => {
    declareComposio({ monitorEnabled: false });
    expect(validateComposioConfig().monitorEnabled).toBe(false);
  });

  it("applies the same base-URL validation to a declared value", () => {
    declareComposio({ baseUrl: "ftp://composio.internal" });
    expect(() => validateComposioConfig()).toThrow(
      /connectors\.providers\.composio\.baseUrl must be http\(s\)/,
    );
  });
});

describe("precedence — per field, so nothing is silently discarded", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("a declared field wins over its env var", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    declareComposio({ baseUrl: "https://config.example.com" });

    expect(validateComposioConfig().baseUrl).toBe("https://config.example.com");
  });

  it("a field the block leaves out still reads its env var", () => {
    // The regression this guards: an operator running with the probe off adds a
    // block for an unrelated reason. Under whole-block precedence `monitorEnabled`
    // would default back on and the revalidator would resume flipping connectors.
    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    declareComposio({ baseUrl: "https://composio.staging" });

    const cfg = validateComposioConfig();
    expect(cfg.baseUrl).toBe("https://composio.staging");
    expect(cfg.monitorEnabled).toBe(false);
  });

  it("mixes the two sources in one resolution", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    declareComposio({ monitorEnabled: false });

    const cfg = validateComposioConfig();
    expect(cfg.baseUrl).toBe("https://env.example.com");
    expect(cfg.monitorEnabled).toBe(false);
  });
});
