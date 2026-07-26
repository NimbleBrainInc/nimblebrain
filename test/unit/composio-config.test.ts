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

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
import { log } from "../../src/observability/log.ts";
import { _resetBouncerModeForTest } from "../../src/oauth/bouncer-config.ts";

const ENV_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
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

describe("settings — env fallback when no block is declared", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("hydrates every setting from the env", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://composio.example.com";

    expect(validateComposioConfig()).toMatchObject({
      baseUrl: "https://composio.example.com",
      monitorEnabled: true,
    });
  });

  it("defaults the base URL", () => {
    expect(validateComposioConfig().baseUrl).toBe(COMPOSIO_API_BASE);
  });

  it("honors the monitor kill switch, and only on an explicit false", () => {
    // Default ON: disabled only by a case/whitespace-insensitive `false`, so a
    // malformed value fails safe to enabled rather than silently stopping the probe.
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

  it("a declared apiKey wins over COMPOSIO_API_KEY", () => {
    // The direction the CHANGELOG, the schema description and both docs pages
    // claim, and the one no test covered: every apiKey case set one source or
    // the other, never both.
    process.env.COMPOSIO_API_KEY = "k_env";
    declareComposio({ apiKey: "k_config" });
    expect(validateComposioConfig().apiKey).toBe("k_config");
  });

  it("a blank declared apiKey falls back to the env, like its siblings", () => {
    process.env.COMPOSIO_API_KEY = "k_env";
    declareComposio({ apiKey: "   " });
    expect(validateComposioConfig().apiKey).toBe("k_env");
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

  it("treats a blank declared value as absent, so the env fallback still applies", () => {
    // A templated deploy renders an unset value to "". Counting that as a
    // declaration would discard the operator's env value — the loss this
    // precedence model exists to prevent.
    process.env.COMPOSIO_API_BASE_URL = "https://composio.internal";
    for (const blank of ["", "   "]) {
      declareComposio({ baseUrl: blank });
      expect(validateComposioConfig().baseUrl).toBe("https://composio.internal");
    }
  });

  it("mixes the two sources in one resolution", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    declareComposio({ monitorEnabled: false });

    const cfg = validateComposioConfig();
    expect(cfg.baseUrl).toBe("https://env.example.com");
    expect(cfg.monitorEnabled).toBe(false);
  });
});

/**
 * Per-toolkit auth-config ids. Keyed by toolkit slug — the identifier the
 * catalog entry already carries — so declaring one adds no string that has to
 * match anything elsewhere.
 *
 * The legacy env arm exists only so a deployment mid-upgrade keeps resolving
 * while its values move into the block. It reads the var the catalog entry's
 * `authConfigEnv` names, and goes away with that field.
 */
describe("composioAuthConfigId", () => {
  it("reads the declared id for the toolkit", () => {
    declareComposio({ authConfigs: { gmail: "ac_declared" } });
    expect(composioAuthConfigId("gmail")).toBe("ac_declared");
  });

  it("returns empty for a toolkit with no id anywhere", () => {
    declareComposio({ authConfigs: { gmail: "ac_declared" } });
    expect(composioAuthConfigId("notion")).toBe("");
  });

  it("falls back to the env var the catalog entry names", () => {
    // A deployment that has not yet moved its ids into the block. Without this
    // arm the upgrade is a hard cutover: every composio connector stops
    // resolving the moment the runtime rolls, before any values have moved.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({});
    expect(composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID")).toBe("ac_env");
  });

  it("prefers the declared id over the legacy env var", () => {
    // The direction that makes the migration one-way: once a toolkit is declared,
    // a stale env var left behind in the pod cannot resurrect the old id.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({ authConfigs: { gmail: "ac_declared" } });
    expect(composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID")).toBe("ac_declared");
  });

  it("treats a blank declared id as absent, so the env fallback still applies", () => {
    // Matches the sibling settings: a templated deploy rendering "" must not
    // discard the operator's env value.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    for (const blank of ["", "   "]) {
      declareComposio({ authConfigs: { gmail: blank } });
      expect(composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID")).toBe("ac_env");
    }
  });

  it("returns empty when the entry names no env var and nothing is declared", () => {
    // The shape of a new catalog entry, which omits `authConfigEnv` entirely.
    declareComposio({});
    expect(composioAuthConfigId("gmail")).toBe("");
  });

  it("trims a declared id", () => {
    declareComposio({ authConfigs: { gmail: "  ac_declared  " } });
    expect(composioAuthConfigId("gmail")).toBe("ac_declared");
  });
});

/**
 * The deprecation warning is the readiness signal for removing the env arm
 * (#789): when no deployment emits it, nothing is left on the legacy path. It is
 * load-bearing for that decision, so it is covered like any other behavior.
 */
describe("composioAuthConfigId — legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof spyOn<typeof log, "warn">>;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    warnSpy = spyOn(log, "warn").mockImplementation((msg?: unknown) => {
      warnings.push(String(msg));
    });
  });

  afterEach(() => warnSpy.mockRestore());

  it("warns when the env var is the value's actual source", () => {
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({});

    composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("COMPOSIO_GMAIL_AUTH_CONFIG_ID");
    expect(warnings[0]).toContain("connectors.providers.composio.authConfigs.gmail");
    expect(warnings[0]).toContain("#789");
  });

  it("warns once per toolkit, not once per resolution", () => {
    // Resolution runs on every install, connect, and revalidator sweep — a warn
    // per call would bury the signal it exists to give.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({});

    for (let i = 0; i < 5; i++) composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID");

    expect(warnings).toHaveLength(1);
  });

  it("stays silent when the declared entry supplies the value", () => {
    // A migrated toolkit must not warn merely because a stale env var lingers
    // in the pod — that would report a problem the operator already fixed.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({ authConfigs: { gmail: "ac_declared" } });

    expect(composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID")).toBe("ac_declared");
    expect(warnings).toHaveLength(0);
  });

  it("stays silent when nothing resolves at all", () => {
    // The connector is unconfigured, not deprecated — callers report that in
    // their own words, and a deprecation warning here would misdirect.
    declareComposio({});
    expect(composioAuthConfigId("gmail", "COMPOSIO_GMAIL_AUTH_CONFIG_ID")).toBe("");
    expect(warnings).toHaveLength(0);
  });
});
