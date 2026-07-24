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
      source: "env",
    });
  });

  it("defaults the base URL", () => {
    expect(validateComposioConfig().baseUrl).toBe(COMPOSIO_API_BASE);
  });

  it("honors the monitor kill switch", () => {
    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    expect(validateComposioConfig().monitorEnabled).toBe(false);
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
      monitor: { enabled: true },
    });

    expect(validateComposioConfig()).toMatchObject({
      configured: true,
      baseUrl: "https://composio.internal",
      monitorEnabled: true,
      source: "config",
    });
  });

  it("defaults the settings an empty block leaves out", () => {
    declareComposio({});
    const cfg = validateComposioConfig();
    expect(cfg.baseUrl).toBe(COMPOSIO_API_BASE);
    expect(cfg.monitorEnabled).toBe(true);
  });

  it("honors monitor.enabled: false", () => {
    declareComposio({ monitor: { enabled: false } });
    expect(validateComposioConfig().monitorEnabled).toBe(false);
  });

  it("applies the same base-URL validation to a declared value", () => {
    declareComposio({ baseUrl: "ftp://composio.internal" });
    expect(() => validateComposioConfig()).toThrow(
      /connectors\.providers\.composio\.baseUrl must be http\(s\)/,
    );
  });
});

describe("precedence — the block owns the settings, and ambiguity is refused", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("refuses to boot when a superseded var is also set, naming every one", () => {
    // Whole-block precedence would discard these. For `monitor.enabled` that
    // means a kill switch silently reverting, so the state is made unreachable.
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    declareComposio({ baseUrl: "https://config.example.com" });

    expect(() => validateComposioConfig()).toThrow(/COMPOSIO_API_BASE_URL/);
    _resetComposioConfigForTest();
    expect(() => validateComposioConfig()).toThrow(/COMPOSIO_MONITOR_ENABLED/);
  });

  it("cannot silently revert a deliberately-disabled probe", () => {
    // The regression this guards: an operator running with the probe off adds a
    // block for an unrelated reason; `monitor` is absent, so whole-block
    // precedence would default it back on and resume flipping connectors.
    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    declareComposio({ baseUrl: "https://composio.staging" });

    expect(() => validateComposioConfig()).toThrow(/monitor kill switch/);
  });

  it("accepts the block alongside COMPOSIO_API_KEY — the credential is not superseded", () => {
    declareComposio({ baseUrl: "https://config.example.com" });

    const cfg = validateComposioConfig();
    expect(cfg.apiKey).toBe("k_env");
    expect(cfg.baseUrl).toBe("https://config.example.com");
  });

  it("is inert on an unconfigured deploy — a dormant provider shouldn't take down boot", () => {
    delete process.env.COMPOSIO_API_KEY;
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    declareComposio({ baseUrl: "https://config.example.com" });

    expect(validateComposioConfig().configured).toBe(false);
  });
});
