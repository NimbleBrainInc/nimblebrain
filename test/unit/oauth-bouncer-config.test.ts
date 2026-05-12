import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  beforeEach(() => {
    saved = snapshot();
    for (const k of ENV_VARS) delete process.env[k];
    _resetBouncerModeForTest();
  });
  afterEach(() => {
    restore(saved);
    _resetBouncerModeForTest();
  });

  test("returns null when no bouncer vars are set (direct mode)", () => {
    expect(getBouncerMode()).toBeNull();
  });

  test("returns null even when NB_TENANT_ID is set alone (direct mode)", () => {
    // NB_TENANT_ID is a general-purpose primitive; setting it without the
    // OAuth-specific vars must NOT trip bouncer mode.
    process.env.NB_TENANT_ID = VALID_TID;
    expect(getBouncerMode()).toBeNull();
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

describe("bouncer-config: partial configuration is rejected", () => {
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

  test("throws when only callback URL is set", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    expect(() => getBouncerMode()).toThrow(/Partial configuration/);
  });

  test("throws when only tenant key is set", () => {
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    expect(() => getBouncerMode()).toThrow(/Partial configuration/);
  });

  test("error message names the missing bouncer variable", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    expect(() => getBouncerMode()).toThrow(/NB_OAUTH_BOUNCER_TENANT_KEY/);
  });

  test("throws when bouncer vars are set but NB_TENANT_ID is missing", () => {
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = VALID_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = VALID_KEY_B64;
    // NB_TENANT_ID deliberately unset
    expect(() => getBouncerMode()).toThrow(/NB_TENANT_ID/);
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
