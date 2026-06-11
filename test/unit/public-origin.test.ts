import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { canonicalOrigins, publicOrigin } from "../../src/oauth/public-origin.ts";

/**
 * Env keys this module reads. Snapshotted and restored around every test so a
 * leaked value can't bleed between cases (and so the real ambient env — which
 * may set NB_API_URL — doesn't taint assertions).
 */
const ENV_KEYS = [
  "NB_PUBLIC_ORIGIN",
  "NB_PLATFORM_HOST",
  "NB_CUSTOM_DOMAIN",
  "NB_CUSTOM_DOMAIN_CANONICAL",
  "NB_API_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("publicOrigin — derivation policy", () => {
  it("derives the custom domain when set and canonical (default)", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    expect(publicOrigin()).toBe("https://brain.acme.com");
  });

  it("derives the custom domain when canonical is explicitly true", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    process.env.NB_CUSTOM_DOMAIN_CANONICAL = "true";
    expect(publicOrigin()).toBe("https://brain.acme.com");
  });

  it("falls back to the platform host when the custom domain is pinned non-canonical", () => {
    process.env.NB_PLATFORM_HOST = "tenant-b.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.tenant-b.com";
    process.env.NB_CUSTOM_DOMAIN_CANONICAL = "false";
    expect(publicOrigin()).toBe("https://tenant-b.platform.nimblebrain.ai");
  });

  it("uses the platform host when no custom domain is set", () => {
    process.env.NB_PLATFORM_HOST = "tenant-c.platform.nimblebrain.ai";
    expect(publicOrigin()).toBe("https://tenant-c.platform.nimblebrain.ai");
  });

  it("honors an explicit NB_PUBLIC_ORIGIN override above derivation", () => {
    process.env.NB_PUBLIC_ORIGIN = "https://auth.customer.com";
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "ai.acme.com";
    expect(publicOrigin()).toBe("https://auth.customer.com");
  });

  it("falls back to legacy NB_API_URL when no host facts are present", () => {
    process.env.NB_API_URL = "https://legacy.platform.nimblebrain.ai";
    expect(publicOrigin()).toBe("https://legacy.platform.nimblebrain.ai");
  });

  it("prefers derived host facts over a legacy NB_API_URL", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "ai.acme.com";
    process.env.NB_API_URL = "https://stale.platform.nimblebrain.ai";
    expect(publicOrigin()).toBe("https://ai.acme.com");
  });

  it("returns the dev origin when nothing is configured", () => {
    expect(publicOrigin()).toBe("http://localhost:27247");
  });
});

describe("publicOrigin — fail-closed assertions", () => {
  it("rejects a non-https origin from config", () => {
    process.env.NB_PUBLIC_ORIGIN = "http://brain.acme.com";
    expect(() => publicOrigin()).toThrow(/must be https/);
  });

  it("rejects an origin carrying a path", () => {
    process.env.NB_PUBLIC_ORIGIN = "https://brain.acme.com/v1/auth/callback";
    expect(() => publicOrigin()).toThrow(/bare origin/);
  });

  it("rejects an unparseable value", () => {
    process.env.NB_PUBLIC_ORIGIN = "not a url";
    expect(() => publicOrigin()).toThrow(/not a valid URL/);
  });

  it("allows http://localhost for local dev", () => {
    process.env.NB_PUBLIC_ORIGIN = "http://localhost:27247";
    expect(publicOrigin()).toBe("http://localhost:27247");
  });

  it("allows http://[::1] (IPv6 loopback) for local dev", () => {
    process.env.NB_PUBLIC_ORIGIN = "http://[::1]:27247";
    expect(publicOrigin()).toBe("http://[::1]:27247");
  });

  it("normalizes away a trailing slash", () => {
    process.env.NB_PUBLIC_ORIGIN = "https://brain.acme.com/";
    expect(publicOrigin()).toBe("https://brain.acme.com");
  });

  it("tolerates sloppy trailing slashes from legacy NB_API_URL", () => {
    process.env.NB_API_URL = "https://legacy.platform.nimblebrain.ai//";
    expect(publicOrigin()).toBe("https://legacy.platform.nimblebrain.ai");
  });
});

describe("canonicalOrigins", () => {
  it("includes both the canonical origin and the platform host for CORS", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    const origins = canonicalOrigins();
    expect(origins).toContain("https://brain.acme.com");
    expect(origins).toContain("https://acme.platform.nimblebrain.ai");
  });

  it("dedupes when there is no custom domain", () => {
    process.env.NB_PLATFORM_HOST = "tenant-c.platform.nimblebrain.ai";
    expect(canonicalOrigins()).toEqual(["https://tenant-c.platform.nimblebrain.ai"]);
  });
});

describe("NB_CUSTOM_DOMAIN_CANONICAL parsing — the rollout safety pin", () => {
  it("pins non-canonical case-insensitively (False / FALSE)", () => {
    process.env.NB_PLATFORM_HOST = "tenant-b.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.tenant-b.com";
    for (const v of ["false", "False", "FALSE", "  false  "]) {
      process.env.NB_CUSTOM_DOMAIN_CANONICAL = v;
      expect(publicOrigin()).toBe("https://tenant-b.platform.nimblebrain.ai");
    }
  });

  it("stays canonical for true (case-insensitive) and when unset", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    for (const v of ["true", "TRUE", undefined]) {
      if (v === undefined) delete process.env.NB_CUSTOM_DOMAIN_CANONICAL;
      else process.env.NB_CUSTOM_DOMAIN_CANONICAL = v;
      expect(publicOrigin()).toBe("https://brain.acme.com");
    }
  });

  it("fails closed on an unrecognized value (typo can't silently flip the pin)", () => {
    process.env.NB_PLATFORM_HOST = "tenant-b.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.tenant-b.com";
    for (const v of ["no", "0", "off", "nope"]) {
      process.env.NB_CUSTOM_DOMAIN_CANONICAL = v;
      expect(() => publicOrigin()).toThrow(/must be "true" or "false"/);
    }
  });
});
