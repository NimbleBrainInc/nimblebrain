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

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
import { log } from "../../src/observability/log.ts";

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
 * Install a declared block. The install's generation bump is what invalidates any
 * earlier resolution, so no explicit cache reset is needed here.
 *
 * (Named `declareComposio`, not `declare` — a function named `declare` parses as a
 * TypeScript ambient declaration and silently never runs.)
 */
function declareComposio(composio: ComposioProviderConfig): void {
  setConnectorsConfig({ providers: { composio } });
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

  it("recomputes when a block is installed after an earlier read", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    expect(validateComposioConfig().baseUrl).toBe("https://env.example.com");

    // No `_resetComposioConfigForTest()` here on purpose: the generation bump in
    // `setConnectorsConfig` is what must invalidate the env-only resolution.
    setConnectorsConfig({ providers: { composio: { baseUrl: "https://config.example.com" } } });
    expect(validateComposioConfig().baseUrl).toBe("https://config.example.com");
  });
});

describe("precedence — the block wins the settings, with one warning", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("uses the block and warns once, naming every superseded settings var", () => {
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    declareComposio({ baseUrl: "https://config.example.com" });

    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const cfg = validateComposioConfig();
      expect(cfg.baseUrl).toBe("https://config.example.com");
      // The env kill switch must not leak through — the block owns the settings whole.
      expect(cfg.monitorEnabled).toBe(true);

      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("connectors.providers.composio is declared");
      expect(msg).toContain("COMPOSIO_API_BASE_URL");
      expect(msg).toContain("COMPOSIO_MONITOR_ENABLED");
    } finally {
      warn.mockRestore();
    }
  });

  it("never advises removing COMPOSIO_API_KEY — it is not superseded", () => {
    // The credential is still read from the env, so telling an operator the
    // block supersedes it would be advice that breaks their deploy.
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    declareComposio({ baseUrl: "https://config.example.com" });

    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(validateComposioConfig().apiKey).toBe("k_env");
      const ignoreList = warn.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((m) => m.includes("ignoring"))
        .join("\n");
      expect(ignoreList).not.toContain("ignoring COMPOSIO_API_KEY");
      expect(ignoreList).not.toContain(", COMPOSIO_API_KEY");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when the block is declared and no settings env is set", () => {
    declareComposio({ baseUrl: "https://config.example.com" });

    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(validateComposioConfig().configured).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent on an unconfigured deploy — nothing is wired to supersede", () => {
    delete process.env.COMPOSIO_API_KEY;
    process.env.COMPOSIO_API_BASE_URL = "https://env.example.com";
    declareComposio({ baseUrl: "https://config.example.com" });

    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(validateComposioConfig().configured).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
