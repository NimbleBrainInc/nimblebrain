/**
 * Composio provider config resolution: the declared
 * `connectors.providers.composio` block, the `COMPOSIO_*` env fallback, and the
 * precedence between them.
 *
 * The contract under test splits on what the value *is*:
 *
 *   - **settings** (`baseUrl`, `monitorEnabled`) — each falls back on its own. A
 *     setting declared in the block wins; a setting left out — or left blank —
 *     reads its `COMPOSIO_*` var. Nothing is ever silently discarded, so
 *     declaring one setting cannot disturb another.
 *   - **the broker credential** — same per-field rule. It became declarable once
 *     an installed connector's transport named a credential provider rather than
 *     an env var, so nothing persisted pins it to `COMPOSIO_API_KEY`.
 *
 * Nothing here mocks `@composio/core` — config resolution is vendor-free by
 * construction, so the suite must never trigger a vendor load.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _resetComposioConfigForTest,
  COMPOSIO_API_BASE,
  composioAuthConfigId,
  validateComposioConfig,
} from "../../src/connectors/providers/composio/config.ts";
import {
  _resetConnectorsConfigForTest,
  type ComposioProviderConfig,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import {
  _resetSmitheryConfigForTest,
  SMITHERY_API_BASE,
  validateSmitheryConfig,
} from "../../src/connectors/providers/smithery/config.ts";
import { _resetBouncerModeForTest } from "../../src/oauth/bouncer-config.ts";

const ENV_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_API_BASE_URL",
  "COMPOSIO_MONITOR_ENABLED",
  "SMITHERY_API_KEY",
  "SMITHERY_NAMESPACE",
  "SMITHERY_API_BASE_URL",
  "SMITHERY_MONITOR_ENABLED",
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

describe("the broker credential", () => {
  it("reports not configured when COMPOSIO_API_KEY is unset", () => {
    expect(validateComposioConfig().apiKey).toBe("");
  });

  it("stays unconfigured when a block declares no credential", () => {
    // A block that declares only settings supplies no credential, so it must not
    // make the provider look configured.
    declareComposio({ baseUrl: "https://composio.internal" });
    expect(validateComposioConfig().apiKey).toBe("");
  });

  it("resolves from the env when the block declares no apiKey", () => {
    // The documented posture for most deployments: settings in the block,
    // credential in the secret store → env.
    process.env.COMPOSIO_API_KEY = "k_env";
    declareComposio({ baseUrl: "https://composio.internal" });

    const cfg = validateComposioConfig();
    expect(cfg.apiKey).toBe("k_env");
    expect(cfg.baseUrl).toBe("https://composio.internal");
  });
});

describe("settings — resolved from the declared block", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("resolves every setting the block declares", () => {
    setConnectorsConfig({ providers: { composio: { baseUrl: "https://composio.example.com" } } });

    expect(validateComposioConfig()).toMatchObject({
      baseUrl: "https://composio.example.com",
      monitorEnabled: true,
    });
  });

  it("defaults the base URL", () => {
    expect(validateComposioConfig().baseUrl).toBe(COMPOSIO_API_BASE);
  });

  it("takes an explicit monitorEnabled: false", () => {
    // A boolean in config, so there is no string parsing to fail safe around —
    // that was the env fallback's problem, not this one's.
    setConnectorsConfig({ providers: { composio: { monitorEnabled: false } } });
    expect(validateComposioConfig().monitorEnabled).toBe(false);
  });

  it("rejects a non-http(s) baseUrl (open-redirect mitigation)", () => {
    setConnectorsConfig({ providers: { composio: { baseUrl: "javascript:alert(1)" } } });
    expect(() => validateComposioConfig()).toThrow(/http\(s\)/);
  });

  it("rejects a malformed baseUrl", () => {
    setConnectorsConfig({ providers: { composio: { baseUrl: "not a url" } } });
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

describe("the broker credential — the one value with two sources", () => {
  // Settings resolve from the declared block only. `apiKey` is a secret, so the
  // environment stays a legitimate home for it and the block may also carry one;
  // it is the single exception, not the pattern (#839).
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("a declared apiKey wins over COMPOSIO_API_KEY", () => {
    declareComposio({ apiKey: "k_declared" });
    expect(validateComposioConfig().apiKey).toBe("k_declared");
  });

  it("a blank declared apiKey falls back to the env", () => {
    // A templated deploy renders an unset value to "". Counting that as a
    // declaration would discard the operator's key and disable the integration.
    declareComposio({ apiKey: "   " });
    expect(validateComposioConfig().apiKey).toBe("k_env");
  });

  it("settings declared alongside it do not disturb the credential", () => {
    declareComposio({ baseUrl: "https://composio.internal", monitorEnabled: false });

    const cfg = validateComposioConfig();
    expect(cfg.apiKey).toBe("k_env");
    expect(cfg.baseUrl).toBe("https://composio.internal");
    expect(cfg.monitorEnabled).toBe(false);
  });
});

describe("composioAuthConfigId", () => {
  it("reads the declared id for the toolkit", () => {
    declareComposio({ authConfigs: { gmail: "ac_declared" } });
    expect(composioAuthConfigId("gmail")).toBe("ac_declared");
  });

  it("returns empty for a toolkit with no declared id", () => {
    declareComposio({ authConfigs: { gmail: "ac_declared" } });
    expect(composioAuthConfigId("notion")).toBe("");
  });

  it("returns empty when no block is declared at all", () => {
    declareComposio({});
    expect(composioAuthConfigId("gmail")).toBe("");
  });

  it("treats a blank declared id as absent", () => {
    for (const blank of ["", "   "]) {
      declareComposio({ authConfigs: { gmail: blank } });
      expect(composioAuthConfigId("gmail")).toBe("");
    }
  });

  it("trims a declared id", () => {
    declareComposio({ authConfigs: { gmail: "  ac_declared  " } });
    expect(composioAuthConfigId("gmail")).toBe("ac_declared");
  });
});

/**
 * The five settings vars are inert — the whole set, in one place.
 *
 * Each removal was verified individually when it landed, which is not the same
 * as verifying the set: four of the five were reinstatable with the suite still
 * green, because every other file deletes these names in `beforeEach` and a
 * restored fallback finds nothing to read. Asserting them together, with all
 * five *set*, is what makes the absence falsifiable.
 *
 * Not a substitute for deleting them from the env-key arrays elsewhere — those
 * exist so a developer's `.env` can't reach the suite (#835), which is a
 * different job from proving the code ignores them.
 */
describe("the five retired settings vars are inert", () => {
  it("resolves defaults with every retired var set", () => {
    process.env.COMPOSIO_API_KEY = "k_env";
    process.env.SMITHERY_API_KEY = "sk_env";
    process.env.COMPOSIO_API_BASE_URL = "https://composio.retired";
    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    process.env.SMITHERY_NAMESPACE = "retired-ns";
    process.env.SMITHERY_API_BASE_URL = "https://smithery.retired";
    process.env.SMITHERY_MONITOR_ENABLED = "false";
    setConnectorsConfig({ providers: { smithery: { namespace: "declared-ns" } } });
    _resetComposioConfigForTest();
    _resetSmitheryConfigForTest();

    const composio = validateComposioConfig();
    expect(composio.baseUrl).toBe(COMPOSIO_API_BASE);
    expect(composio.monitorEnabled).toBe(true);

    const smithery = validateSmitheryConfig();
    expect(smithery.namespace).toBe("declared-ns");
    expect(smithery.baseUrl).toBe(SMITHERY_API_BASE);
    expect(smithery.monitorEnabled).toBe(true);
  });
});
