/**
 * Tests for the OIDC token-refresh failure taxonomy.
 *
 * A refresh can fail two fundamentally different ways, and only one of them
 * means the user's session is over:
 *
 * - `rejected`    — the IdP definitively refused the refresh token
 *                   (`invalid_grant`: expired/revoked/reused). Session dead →
 *                   the handler returns 401 and the client logs out.
 * - `unavailable` — the refresh hop failed without a verdict (network throw,
 *                   IdP 5xx/429, a misconfig like `invalid_client`). Session is
 *                   probably fine → the handler returns 503 and the client keeps
 *                   the session and retries.
 *
 * Two layers are covered:
 *   1. WorkosIdentityProvider.refreshToken classifies SDK errors into
 *      RefreshTokenError("rejected" | "unavailable").
 *   2. handleOidcRefresh maps that verdict to an HTTP status (provider-agnostic).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { handleOidcRefresh } from "../../../src/api/handlers.ts";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import {
  type IdentityProvider,
  RefreshTokenError,
  type TokenResult,
} from "../../../src/identity/provider.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

// ── Layer 1: WorkOS provider classification ──────────────────────────

const BASE_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test_refresh",
  redirectUri: "http://localhost/callback",
  organizationId: "org_test_refresh",
  apiKey: "sk_test_fake_refresh",
};

/** Build a provider whose underlying WorkOS refresh call throws `thrown`. */
function providerThatThrows(thrown: unknown): WorkosIdentityProvider {
  const workspaceStore = new WorkspaceStore(mkdtempSync(join(tmpdir(), "oidc-refresh-")));
  const provider = new WorkosIdentityProvider(BASE_CONFIG, undefined, workspaceStore);
  // Cast escape hatch: `workos` is a private field typed as the full WorkOS SDK;
  // we only need to swap the one method under test, so we widen it to a bag of
  // unknowns rather than reconstruct the SDK's type.
  const sdk = (provider as unknown as { workos: { userManagement: Record<string, unknown> } })
    .workos;
  sdk.userManagement = {
    authenticateWithRefreshToken: async () => {
      throw thrown;
    },
  };
  return provider;
}

describe("WorkosIdentityProvider.refreshToken classification", () => {
  test("invalid_grant (OauthException shape) → rejected", async () => {
    // WorkOS surfaces a refused refresh token as an OauthException with
    // `.error === "invalid_grant"`. This is the ONLY dead-session signal.
    const provider = providerThatThrows({
      name: "OauthException",
      status: 400,
      error: "invalid_grant",
      message: "The refresh token is invalid.",
    });
    try {
      await provider.refreshToken("rt");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshTokenError);
      expect((err as RefreshTokenError).kind).toBe("rejected");
      expect((err as RefreshTokenError).code).toBe("invalid_grant");
    }
  });

  test("invalid_client (deployment misconfig) → unavailable, NOT a dead session", async () => {
    // Wrong client credentials are an operator problem; the user's token is
    // fine. Logging them out would destroy valid sessions fleet-wide on a bad
    // deploy. Transient bucket, but the code is preserved for the error log.
    const provider = providerThatThrows({
      name: "OauthException",
      status: 401,
      error: "invalid_client",
      message: "Client authentication failed.",
    });
    try {
      await provider.refreshToken("rt");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshTokenError);
      expect((err as RefreshTokenError).kind).toBe("unavailable");
      expect((err as RefreshTokenError).code).toBe("invalid_client");
    }
  });

  test("GenericServerException (IdP 5xx) → unavailable", async () => {
    const provider = providerThatThrows({
      name: "GenericServerException",
      status: 503,
      message: "Service unavailable",
    });
    try {
      await provider.refreshToken("rt");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RefreshTokenError).kind).toBe("unavailable");
      expect((err as RefreshTokenError).code).toBeUndefined();
    }
  });

  test("thrown network error (TypeError) → unavailable", async () => {
    const provider = providerThatThrows(new TypeError("Failed to fetch"));
    try {
      await provider.refreshToken("rt");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RefreshTokenError).kind).toBe("unavailable");
    }
  });
});

// ── Layer 2: handler maps the verdict to an HTTP status ──────────────

/** Minimal IdentityProvider that supports refresh; refreshToken is supplied. */
function refreshProvider(
  refreshToken: (rt: string) => Promise<TokenResult>,
  opts?: { tokenRefresh?: boolean },
): IdentityProvider {
  return {
    capabilities: {
      authCodeFlow: true,
      tokenRefresh: opts?.tokenRefresh ?? true,
      managedUsers: true,
    },
    verifyRequest: async () => null,
    refreshToken,
    listUsers: async () => [],
    createUser: async () => {
      throw new Error("unused");
    },
    deleteUser: async () => false,
  } as IdentityProvider;
}

const withCookie = (value = "rt-value") =>
  new Request("https://app.test/v1/auth/refresh", {
    method: "POST",
    headers: { cookie: `nb_refresh=${value}` },
  });

describe("handleOidcRefresh status mapping", () => {
  test("rejected → 401 refresh_failed (log out)", async () => {
    const provider = refreshProvider(async () => {
      throw new RefreshTokenError("rejected", "dead", { code: "invalid_grant" });
    });
    const res = await handleOidcRefresh(withCookie(), provider, false);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("refresh_failed");
  });

  test("unavailable → 503 refresh_unavailable + Retry-After (keep session)", async () => {
    const provider = refreshProvider(async () => {
      throw new RefreshTokenError("unavailable", "blip", { code: "invalid_client" });
    });
    const res = await handleOidcRefresh(withCookie(), provider, false);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect((await res.json()).error).toBe("refresh_unavailable");
  });

  test("a non-RefreshTokenError throw still defaults to 503 (never logs out on a surprise)", async () => {
    const provider = refreshProvider(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await handleOidcRefresh(withCookie(), provider, false);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("refresh_unavailable");
  });

  test("success → 200 with a fresh nb_session cookie", async () => {
    const provider = refreshProvider(async () => ({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }));
    const res = await handleOidcRefresh(withCookie(), provider, true);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("nb_session=new-access");
  });

  test("no refresh cookie → 401 no_refresh_token", async () => {
    const provider = refreshProvider(async () => {
      throw new Error("should not be called");
    });
    const res = await handleOidcRefresh(
      new Request("https://app.test/v1/auth/refresh", { method: "POST" }),
      provider,
      false,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("no_refresh_token");
  });

  test("provider can't refresh → 400 not_configured", async () => {
    const provider = refreshProvider(async () => ({ accessToken: "x" }), {
      tokenRefresh: false,
    });
    const res = await handleOidcRefresh(withCookie(), provider, false);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_configured");
  });
});
