import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  buildMintRequest,
  createMintingFetch,
  MintError,
  mintServiceToken,
  readTenantIdentityFromEnv,
  ServiceTokenCache,
  type TenantIdentity,
} from "../../src/oauth/tenant-key-mint.ts";

// ---------------------------------------------------------------------------
// Faithful inline mirror of the authorizer's verifier
// (platform/services/mcp-authorizer/src/tenant-assertion.ts). The MINT request
// is verified there by `verifyMac` → `verifyMintRequest`; we reproduce both so a
// drift in HKDF info / MAC framing / payload shape / field caps breaks CI on the
// runtime side. The live cross-impl proof is /tmp/tenant-key-e2e.sh, which mints
// against the deployed authorizer; this keeps the guard in-repo and offline.
// ---------------------------------------------------------------------------
const HKDF_INFO = Buffer.from("mcp-authorizer/v1");
const ALLOWED_TID = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Mirrors the authorizer's ALLOWED_WORKSPACE_PATTERN — a bounded, injection-safe
// opaque id, distinct from the tid DNS-label rule.
const ALLOWED_WORKSPACE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ENVELOPE_LIFETIME = 30 * 60;
const CLOCK_SKEW = 60;

function deriveTenantKey(master: Buffer, tid: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(tid, "utf8"), HKDF_INFO, 32));
}

type VerifyResult =
  | { ok: true; tid: string; workspace: string; audience: string; scope: string; exp: number }
  | { ok: false; reason: string };

function verifyMintAsAuthorizer(wire: string, master: Buffer, nowSeconds: number): VerifyResult {
  const parts = wire.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "invalid_format" };
  const payloadB64 = parts[1] as string;
  const macB64 = parts[2] as string;
  const payloadRaw = Buffer.from(payloadB64, "base64url");
  const peeked = JSON.parse(payloadRaw.toString("utf8")) as Record<string, unknown>;
  const tid = peeked.tid;
  if (typeof tid !== "string" || !ALLOWED_TID.test(tid)) return { ok: false, reason: "invalid_tid" };

  const tenantKey = deriveTenantKey(master, tid);
  const macExpected = createHmac("sha256", tenantKey).update(`v1.${payloadB64}`).digest();
  const macProvided = Buffer.from(macB64, "base64url");
  if (macProvided.length !== macExpected.length || !timingSafeEqual(macProvided, macExpected)) {
    return { ok: false, reason: "bad_mac" };
  }

  const { workspace, audience, scope, iat, exp } = peeked;
  if (typeof workspace !== "string" || !ALLOWED_WORKSPACE.test(workspace)) {
    return { ok: false, reason: "invalid_workspace" };
  }
  if (typeof audience !== "string" || audience.length === 0 || audience.length > 128) {
    return { ok: false, reason: "invalid_audience" };
  }
  if (typeof scope !== "string" || scope.length === 0 || Buffer.byteLength(scope, "utf8") > 512) {
    return { ok: false, reason: "invalid_scope" };
  }
  if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (exp - iat > MAX_ENVELOPE_LIFETIME) return { ok: false, reason: "lifetime_too_long" };
  if (nowSeconds > exp) return { ok: false, reason: "expired" };
  if (nowSeconds < iat - CLOCK_SKEW) return { ok: false, reason: "issued_in_future" };
  return { ok: true, tid, workspace, audience, scope, exp };
}

const MASTER = randomBytes(32);
const TID = "hq";
const TENANT_KEY = deriveTenantKey(MASTER, TID);
const IDENTITY: TenantIdentity = { tid: TID, tenantKey: TENANT_KEY };

describe("buildMintRequest — authorizer parity", () => {
  it("produces a wire the authorizer's verifier accepts, carrying the named fields", () => {
    const now = 1_700_000_000;
    const wire = buildMintRequest({
      tid: TID,
      workspace: "ws_smoke",
      audience: "artifacts",
      scope: "artifacts:write",
      tenantKey: TENANT_KEY,
      now,
    });
    const v = verifyMintAsAuthorizer(wire, MASTER, now);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v).toMatchObject({
      tid: "hq",
      workspace: "ws_smoke",
      audience: "artifacts",
      scope: "artifacts:write",
    });
  });

  it("is rejected when signed with the wrong tenant key (the key is the boundary)", () => {
    const now = 1_700_000_000;
    const wrongKey = deriveTenantKey(randomBytes(32), TID);
    const wire = buildMintRequest({
      tid: TID,
      workspace: "ws_smoke",
      audience: "artifacts",
      scope: "artifacts:write",
      tenantKey: wrongKey,
      now,
    });
    const v = verifyMintAsAuthorizer(wire, MASTER, now);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("bad_mac");
  });

  it("rejects an expired request at the verifier (short request TTL is enforced end-to-end)", () => {
    const iat = 1_700_000_000;
    const wire = buildMintRequest({
      tid: TID,
      workspace: "ws_smoke",
      audience: "artifacts",
      scope: "artifacts:write",
      tenantKey: TENANT_KEY,
      now: iat,
      ttlSeconds: 60,
    });
    const v = verifyMintAsAuthorizer(wire, MASTER, iat + 61);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("expired");
  });
});

describe("buildMintRequest — local validation", () => {
  const base = {
    tid: TID,
    workspace: "ws_smoke",
    audience: "artifacts",
    scope: "artifacts:write",
    tenantKey: TENANT_KEY,
  };

  it("accepts the runtime's real workspace ids (ws_<hex>, ws_user_<id>) verbatim", () => {
    expect(() => buildMintRequest({ ...base, workspace: "ws_1a2b3c4d5e6f7a8b" })).not.toThrow();
    expect(() => buildMintRequest({ ...base, workspace: "ws_user_01HXYZ" })).not.toThrow();
  });

  it("rejects a string that is not a NimbleBrain workspace id", () => {
    // No ws_ prefix, traversal, and whitespace all fail the runtime's own grammar.
    expect(() => buildMintRequest({ ...base, workspace: "not-a-workspace" })).toThrow(MintError);
    expect(() => buildMintRequest({ ...base, workspace: "ws_../etc" })).toThrow(MintError);
    expect(() => buildMintRequest({ ...base, workspace: "ws_a b" })).toThrow(MintError);
  });

  it("rejects an over-long audience", () => {
    expect(() => buildMintRequest({ ...base, audience: "a".repeat(129) })).toThrow(MintError);
  });

  it("rejects an empty scope", () => {
    expect(() => buildMintRequest({ ...base, scope: "" })).toThrow(MintError);
  });

  it("rejects a short tenant key", () => {
    expect(() => buildMintRequest({ ...base, tenantKey: randomBytes(16) })).toThrow(MintError);
  });
});

describe("readTenantIdentityFromEnv", () => {
  it("throws unprovisioned with the missing var named", () => {
    expect(() => readTenantIdentityFromEnv({ NB_TENANT_ID: "hq" } as NodeJS.ProcessEnv)).toThrow(
      /NB_MCP_AUTHORIZER_TENANT_KEY/,
    );
    expect(() =>
      readTenantIdentityFromEnv({ NB_MCP_AUTHORIZER_TENANT_KEY: TENANT_KEY.toString("base64") } as NodeJS.ProcessEnv),
    ).toThrow(/NB_TENANT_ID/);
  });

  it("reads and decodes a provisioned identity", () => {
    const id = readTenantIdentityFromEnv({
      NB_TENANT_ID: "hq",
      NB_MCP_AUTHORIZER_TENANT_KEY: TENANT_KEY.toString("base64"),
    } as NodeJS.ProcessEnv);
    expect(id.tid).toBe("hq");
    expect(id.tenantKey.equals(TENANT_KEY)).toBe(true);
  });
});

/** A fake authorizer `/token` endpoint: verifies the inbound mint and returns a
 *  token whose value encodes the requested audience, so the test can assert the
 *  right token reached the caller. Counts calls for single-flight assertions. */
function fakeAuthorizer(opts: { expiresIn?: number; failStatus?: number; now?: () => number } = {}) {
  let calls = 0;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    const url = String(input);
    if (!url.endsWith("/token")) return new Response("not found", { status: 404 });
    if (opts.failStatus) {
      return new Response(`{"error":"invalid_request"}`, { status: opts.failStatus });
    }
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("urn:nimblebrain:params:oauth:grant-type:tenant-key");
    const wire = body.get("tenant_assertion") ?? "";
    const v = verifyMintAsAuthorizer(wire, MASTER, now());
    if (!v.ok) return new Response(`{"error":"${v.reason}"}`, { status: 400 });
    return Response.json({
      access_token: `tok-${v.audience}-${calls}`,
      token_type: "Bearer",
      expires_in: opts.expiresIn ?? 300,
    });
  };
  return { fetchImpl, calls: () => calls };
}

describe("mintServiceToken", () => {
  it("mints a token and computes absolute expiry from expires_in", async () => {
    const { fetchImpl } = fakeAuthorizer({ expiresIn: 300, now: () => 1000 });
    const tok = await mintServiceToken({
      issuer: "https://authz.test",
      workspace: "ws_smoke",
      audience: "artifacts",
      scope: "artifacts:write",
      identity: IDENTITY,
      fetchImpl,
      now: () => 1000,
    });
    expect(tok.accessToken).toBe("tok-artifacts-1");
    expect(tok.expiresAt).toBe(1300);
  });

  it("throws http_error with the authorizer's detail on a non-200", async () => {
    const { fetchImpl } = fakeAuthorizer({ failStatus: 400 });
    await expect(
      mintServiceToken({
        issuer: "https://authz.test",
        workspace: "ws_smoke",
        audience: "artifacts",
        scope: "artifacts:write",
        identity: IDENTITY,
        fetchImpl,
      }),
    ).rejects.toThrow(MintError);
  });
});

describe("ServiceTokenCache", () => {
  const req = { issuer: "https://authz.test", workspace: "ws_smoke", audience: "artifacts", scope: "artifacts:write" };

  it("serves a cached token until the renew skew, then re-mints", async () => {
    let clock = 1000;
    const authz = fakeAuthorizer({ expiresIn: 300, now: () => clock });
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: authz.fetchImpl, now: () => clock });

    expect(await cache.getToken(req)).toBe("tok-artifacts-1");
    clock = 1100; // well within 300s - 30s skew → cache hit
    expect(await cache.getToken(req)).toBe("tok-artifacts-1");
    expect(authz.calls()).toBe(1);

    clock = 1271; // past expiresAt(1300) - 30s skew → re-mint
    expect(await cache.getToken(req)).toBe("tok-artifacts-2");
    expect(authz.calls()).toBe(2);
  });

  it("dedupes concurrent mints for the same key (single-flight)", async () => {
    const authz = fakeAuthorizer({ expiresIn: 300, now: () => 1000 });
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: authz.fetchImpl, now: () => 1000 });

    const [a, b, c] = await Promise.all([cache.getToken(req), cache.getToken(req), cache.getToken(req)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(authz.calls()).toBe(1);
  });

  it("forceRefresh discards the cached token and re-mints (the 401-retry path)", async () => {
    const authz = fakeAuthorizer({ expiresIn: 300, now: () => 1000 });
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: authz.fetchImpl, now: () => 1000 });

    expect(await cache.getToken(req)).toBe("tok-artifacts-1");
    expect(await cache.getToken(req, { forceRefresh: true })).toBe("tok-artifacts-2");
    expect(authz.calls()).toBe(2);
  });

  it("does not pin callers to a failed mint (in-flight marker cleared on error)", async () => {
    let mode: "fail" | "ok" = "fail";
    const okAuthz = fakeAuthorizer({ now: () => 1000 });
    const fetchImpl: typeof fetch = async (input, init) => {
      if (mode === "fail") return new Response(`{"error":"boom"}`, { status: 500 });
      return okAuthz.fetchImpl(input, init);
    };
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl, now: () => 1000 });

    await expect(cache.getToken(req)).rejects.toThrow(MintError);
    mode = "ok";
    expect(await cache.getToken(req)).toBe("tok-artifacts-1");
  });
});

describe("createMintingFetch", () => {
  const req = { issuer: "https://authz.test", workspace: "ws_smoke", audience: "artifacts", scope: "artifacts:write" };

  it("attaches a freshly-minted bearer to each outbound request", async () => {
    const authz = fakeAuthorizer({ now: () => 1000 });
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: authz.fetchImpl, now: () => 1000 });
    let seenAuth: string | null = null;
    const baseFetch: typeof fetch = async (_input, init) => {
      seenAuth = new Headers(init?.headers).get("Authorization");
      return new Response("ok", { status: 200 });
    };
    const f = createMintingFetch({ cache, ...req, baseFetch });

    const res = await f("https://artifacts.test/v1/artifacts", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seenAuth).toBe("Bearer tok-artifacts-1");
  });

  it("force-re-mints and retries exactly once on a 401", async () => {
    const authz = fakeAuthorizer({ now: () => 1000 });
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: authz.fetchImpl, now: () => 1000 });
    let serviceCalls = 0;
    const seen: (string | null)[] = [];
    const baseFetch: typeof fetch = async (_input, init) => {
      serviceCalls++;
      seen.push(new Headers(init?.headers).get("Authorization"));
      // Reject the first token, accept the (re-minted) second.
      return serviceCalls === 1 ? new Response("no", { status: 401 }) : new Response("ok", { status: 200 });
    };
    const f = createMintingFetch({ cache, ...req, baseFetch });

    const res = await f("https://artifacts.test/v1/artifacts");
    expect(res.status).toBe(200);
    expect(serviceCalls).toBe(2);
    expect(authz.calls()).toBe(2); // initial mint + one forced re-mint
    expect(seen).toEqual(["Bearer tok-artifacts-1", "Bearer tok-artifacts-2"]);
  });

  it("does not retry on a non-auth error (e.g. 500)", async () => {
    const authz = fakeAuthorizer({ now: () => 1000 });
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: authz.fetchImpl, now: () => 1000 });
    let serviceCalls = 0;
    const baseFetch: typeof fetch = async () => {
      serviceCalls++;
      return new Response("boom", { status: 500 });
    };
    const f = createMintingFetch({ cache, ...req, baseFetch });

    const res = await f("https://artifacts.test/v1/artifacts");
    expect(res.status).toBe(500);
    expect(serviceCalls).toBe(1); // 500 is surfaced, not retried
  });
});
