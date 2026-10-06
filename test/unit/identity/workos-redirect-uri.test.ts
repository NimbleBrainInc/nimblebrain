/**
 * The WorkOS login redirect URI is always `${publicOrigin()}/v1/auth/callback`.
 * A regression here breaks login for custom-domain tenants.
 *
 * Observed through the public `getAuthorizationUrl()` (the WorkOS SDK embeds the
 * provider's redirectUri as the `redirect_uri` query param; no network needed).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";

function makeProvider(config: WorkosAuth): WorkosIdentityProvider {
  return new WorkosIdentityProvider(config, undefined);
}

function redirectUriOf(provider: WorkosIdentityProvider): string {
  const ru = new URL(provider.getAuthorizationUrl()).searchParams.get("redirect_uri");
  if (!ru) throw new Error("authorization URL has no redirect_uri");
  return ru;
}

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

describe("WorkosIdentityProvider redirectUri derivation", () => {
  it("derives the redirect URI from publicOrigin()", () => {
    process.env.NB_PLATFORM_HOST = "acme.nb.example.com";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    const provider = makeProvider({ adapter: "workos", clientId: "client_test" });
    expect(redirectUriOf(provider)).toBe("https://brain.acme.com/v1/auth/callback");
  });

  it("derives the platform host when no custom domain is configured", () => {
    process.env.NB_PLATFORM_HOST = "acme.nb.example.com";
    const provider = makeProvider({ adapter: "workos", clientId: "client_test" });
    expect(redirectUriOf(provider)).toBe("https://acme.nb.example.com/v1/auth/callback");
  });
});
