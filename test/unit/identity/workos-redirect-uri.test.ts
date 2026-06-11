/**
 * The WorkOS login leg of the public-origin fix: when instance.json carries no
 * explicit `redirectUri`, the provider derives `${publicOrigin()}/v1/auth/callback`.
 * This is the branch that breaks login for custom-domain tenants if it regresses,
 * and every other WorkOS fixture sets redirectUri explicitly — so it's covered here.
 *
 * Observed through the public `getAuthorizationUrl()` (the WorkOS SDK embeds the
 * provider's redirectUri as the `redirect_uri` query param; no network needed).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

function makeProvider(config: WorkosAuth): WorkosIdentityProvider {
  const workspaceStore = new WorkspaceStore(mkdtempSync(join(tmpdir(), "workos-redirect-")));
  return new WorkosIdentityProvider(config, undefined, workspaceStore);
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
  it("derives the redirect URI from publicOrigin() when instance.json omits it", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    const provider = makeProvider({ adapter: "workos", clientId: "client_test" });
    expect(redirectUriOf(provider)).toBe("https://brain.acme.com/v1/auth/callback");
  });

  it("derives the platform host when no custom domain is configured", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    const provider = makeProvider({ adapter: "workos", clientId: "client_test" });
    expect(redirectUriOf(provider)).toBe(
      "https://acme.platform.nimblebrain.ai/v1/auth/callback",
    );
  });

  it("uses an explicit redirectUri over the derived one (legacy override)", () => {
    process.env.NB_PLATFORM_HOST = "acme.platform.nimblebrain.ai";
    process.env.NB_CUSTOM_DOMAIN = "brain.acme.com";
    const provider = makeProvider({
      adapter: "workos",
      clientId: "client_test",
      redirectUri: "https://explicit.example.com/v1/auth/callback",
    });
    expect(redirectUriOf(provider)).toBe("https://explicit.example.com/v1/auth/callback");
  });
});
