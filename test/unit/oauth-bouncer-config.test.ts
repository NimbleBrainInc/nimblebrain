import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { log } from "../../src/cli/log.ts";
import { _resetBouncerModeForTest, getBouncerMode } from "../../src/oauth/bouncer-config.ts";

const ENV_VARS = [
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
  "NB_TENANT_ID",
] as const;

const VALID_KEY_B64 = randomBytes(32).toString("base64");
const VALID_CALLBACK = "https://connect.example.com/v1/mcp-auth/callback";
const VALID_TID = "tenant-a";

/**
 * Env-based config is tested via the real env. Each test snapshots and
 * restores the relevant vars + resets the module's lazy cache so the
 * next test reads cleanly.
 */
function snapshot(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
}
function restore(saved: Record<string, string | undefined>): void {
  for (const k of ENV_VARS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("bouncer-config: presence", () => {
  let saved: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    saved = snapshot();
    for (const k of ENV_VARS) delete process.env[k];
    _resetBouncerModeForTest();
    warnSpy = spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    restore(saved);
    _resetBouncerModeForTest();
    warnSpy.mockRestore();
  });

  test("returns null when no bouncer vars are set (direct mode), no warning", () => {
    expect(getBouncerMode()).toBeNull();
    // Locks in "warning only on stray key, never on clean direct mode."
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("returns null even when NB_TENANT_ID is set alone (direct mode), no warning", () => {
    // NB_TENANT_ID is a general-purpose primitive; setting it without the
    // OAuth-specific vars must NOT trip bouncer mode and must NOT warn.
    process.env.NB_TENANT_ID = VALID_TID;
    expect(getBouncerMode()).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("returns a populated config when both bouncer vars and NB_TENANT_ID are set", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;

    const cfg = getBouncerMode();
    expect(cfg).not.toBeNull();
    expect(cfg?.callbackUrl).toBe(VALID_CALLBACK);
    expect(cfg?.tid).toBe(VALID_TID);
    expect(cfg?.tenantKey).toHaveLength(32);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("caches the result — subsequent reads do not re-validate", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;

    const first = getBouncerMode();
    for (const k of ENV_VARS) delete process.env[k];
    const second = getBouncerMode();
    expect(second).toBe(first);
  });
});

describe("bouncer-config: URL is the mode signal", () => {
  let saved: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    saved = snapshot();
    for (const k of ENV_VARS) delete process.env[k];
    _resetBouncerModeForTest();
    warnSpy = spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    restore(saved);
    _resetBouncerModeForTest();
    warnSpy.mockRestore();
  });

  test("URL set + KEY missing → fatal (operator clearly meant to enable bouncer)", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    // Key deliberately unset
    expect(() => getBouncerMode()).toThrow(/NB_OAUTH_BOUNCER_TENANT_KEY is missing/);
    // Fatal path, not the warn path — confirm we didn't also fire the warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("URL unset + KEY set → direct mode + warn (residue from rollback, not fatal)", () => {
    // This is the shape after rolling back oauthBouncer.enabled: false:
    // the chart's envFrom: secretRef keeps injecting the key from
    // agent-secrets even though the URL is gone. The platform should
    // treat this as direct mode, not crash. And it must WARN —
    // otherwise the operator never knows there's leftover state.
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    expect(getBouncerMode()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(
      /NB_OAUTH_BOUNCER_TENANT_KEY is set but NB_OAUTH_BOUNCER_CALLBACK_URL is not/,
    );
    // Names the cleanup step explicitly — otherwise the warning is
    // sympathetic noise that doesn't tell the operator what to do.
    expect(msg).toMatch(/external-secret\.yaml/);
  });

  test("URL unset + KEY set + TID set → direct mode + warn (still benign)", () => {
    // NB_TENANT_ID is always injected by the chart (general primitive).
    // Stray key + tid without URL is still just rollback residue.
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;
    expect(getBouncerMode()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("warn fires only once across repeated getBouncerMode() calls (cache property)", () => {
    // The "warn once at boot" property is a side-effect of the lazy
    // cache: readAndValidate runs on the first call, the result is
    // memoized, subsequent calls return the cached value without
    // re-running validation. If a future refactor adds a code path
    // that clears the cache mid-process, the warn would re-fire on
    // the next call — which would be noisy but not incorrect. This
    // test pins the once-at-boot behavior under the cache.
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    expect(getBouncerMode()).toBeNull();
    expect(getBouncerMode()).toBeNull();
    expect(getBouncerMode()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("Bouncer mode requires NB_TENANT_ID when URL+KEY are both set", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    // NB_TENANT_ID deliberately unset
    expect(() => getBouncerMode()).toThrow(/NB_TENANT_ID/);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("bouncer-config: value validation", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshot();
    for (const k of ENV_VARS) delete process.env[k];
    _resetBouncerModeForTest();
  });
  afterEach(() => {
    restore(saved);
    _resetBouncerModeForTest();
  });

  test("rejects malformed callback URL", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = "not a url";
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/not a valid URL/);
  });

  test("rejects non-http(s) callback URL", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = "javascript:alert(1)";
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/must use http/);
  });

  test("rejects callback URL whose path doesn't end with /v1/mcp-auth/callback", () => {
    // The session-binding cookie is path-scoped to /v1/mcp-auth/callback.
    // A URL pointing elsewhere silently breaks every flow with a generic
    // session-mismatch error and no clear root-cause signal — exactly the
    // class of misconfiguration the boot check is meant to catch.
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = "https://connect.example.com/auth/callback";
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/must end with "\/v1\/mcp-auth\/callback"/);
  });

  test("rejects callback URL with no path component", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = "https://connect.example.com";
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/must end with/);
  });

  test("rejects tid that violates DNS-label grammar (in bouncer mode)", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    process.env.NB_TENANT_ID = "TENANT-UPPER";
    expect(() => getBouncerMode()).toThrow(/DNS-label grammar/);
  });

  test("rejects tenant key shorter than 32 bytes", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = randomBytes(16).toString("base64");
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/must decode to 32 bytes/);
  });

  test("rejects all-zeros tenant key (placeholder pattern)", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = Buffer.alloc(32, 0).toString("base64");
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/placeholder pattern/);
  });

  test("rejects all-0xff tenant key (placeholder pattern)", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = Buffer.alloc(32, 0xff).toString("base64");
    process.env.NB_TENANT_ID = VALID_TID;
    expect(() => getBouncerMode()).toThrow(/placeholder pattern/);
  });
});
