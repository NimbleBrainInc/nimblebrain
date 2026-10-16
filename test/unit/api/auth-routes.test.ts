import { describe, expect, test } from "bun:test";
import { authRoutes } from "../../../src/api/routes/auth.ts";
import type { AppContext } from "../../../src/api/types.ts";
import type { IdentityProvider } from "../../../src/identity/provider.ts";
import { stub } from "../../helpers/stub.ts";

/**
 * Unit coverage for `POST /v1/auth/logout`. Sign-out has to clear the browser's
 * cookies whether or not the access token is still valid: once it lapses,
 * `nb_refresh` is the only live credential, and leaving it in place lets the
 * login screen's first bootstrap refresh straight back into a session. It also
 * ends the identity provider's session, or the next sign-in resumes that one.
 */

// Only the fields authRoutes reads. The provider rejects every token, which is
// what a lapsed access token looks like to the verifier.
function makeCtx(endSession?: IdentityProvider["endSession"]): AppContext {
  const provider = stub<IdentityProvider>({
    verifyRequest: async () => null,
    ...(endSession ? { endSession } : {}),
  });
  return stub<AppContext>({
    provider,
    authOptions: {
      provider,
      eventSink: { emit: () => {} },
    },
    secureCookies: false,
    appOrigin: "http://localhost",
  });
}

async function logout(
  headers: Record<string, string>,
  endSession?: IdentityProvider["endSession"],
): Promise<Response> {
  return authRoutes(makeCtx(endSession)).request("/v1/auth/logout", {
    method: "POST",
    headers: {
      cookie: "nb_session=lapsed-access-token; nb_refresh=live-refresh-token",
      ...headers,
    },
  });
}

describe("POST /v1/auth/logout", () => {
  test("clears both session cookies when the access token has lapsed", async () => {
    const res = await logout({ "content-type": "application/json" });

    expect(res.status).toBe(200);
    const cleared = res.headers.getSetCookie();
    expect(
      cleared.filter((c) => c.startsWith("nb_session=;") && c.includes("Max-Age=0")),
    ).toHaveLength(2);
    expect(cleared).toContain("nb_refresh=; HttpOnly; SameSite=Lax; Path=/v1/auth; Max-Age=0");
  });

  test("ends the identity provider's session for the request's credential", async () => {
    const seen: string[] = [];
    await logout({ "content-type": "application/json" }, async (req) => {
      seen.push(req.headers.get("cookie") ?? "");
    });

    expect(seen).toEqual(["nb_session=lapsed-access-token; nb_refresh=live-refresh-token"]);
  });

  test("clears the cookies when the provider fails to end its session", async () => {
    const res = await logout({ "content-type": "application/json" }, async () => {
      throw new Error("identity provider unreachable");
    });

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toContain(
      "nb_refresh=; HttpOnly; SameSite=Lax; Path=/v1/auth; Max-Age=0",
    );
  });

  // A cross-site HTML form can send these content types without a CORS
  // preflight. Refusing them is what keeps a foreign page from signing the
  // user out.
  for (const contentType of [
    undefined,
    "application/x-www-form-urlencoded",
    "text/plain",
    "multipart/form-data",
  ]) {
    test(`refuses ${contentType ?? "a missing content type"} and ends nothing`, async () => {
      let ended = false;
      const res = await logout(contentType ? { "content-type": contentType } : {}, async () => {
        ended = true;
      });

      expect(res.status).toBe(415);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(ended).toBe(false);
    });
  }
});
