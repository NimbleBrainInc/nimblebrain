import { injectTraceparent } from "../observability/index.ts";
import { WORKSPACE_ID_RE } from "../workspace/workspace-id-pattern.ts";
import { ALLOWED_TID_PATTERN, EnvelopeError, signMacEnvelope } from "./envelope.ts";

/**
 * Tenant-key MINT grant — the machine plane.
 *
 * A tenant's runtime is authoritative over its own workspaces. To talk to a
 * platform data-plane service (artifacts, nimbletasks, web-search) it signs a
 * mint request with its per-tenant key — `NB_MCP_AUTHORIZER_TENANT_KEY` =
 * HKDF(authorizer-master, salt=tid, info="mcp-authorizer/v1"), provisioned at
 * deploy time — naming exactly the `(workspace, audience, scope)` it wants, and
 * POSTs it to the authorizer's `/token`. The authorizer re-derives the key from
 * the master, MAC-verifies, and mints a short-lived workspace-scoped service
 * token (`aud=<service>`, `workspace_id=<workspace>`). RLS in the service fences
 * the data by `(tenant_id, workspace_id)`.
 *
 * The request rides the SAME MAC envelope as the OAuth login assertion
 * (`signEnvelope`) — one crypto construction, `signMacEnvelope` — but its
 * payload carries `(workspace, audience, scope)` instead of a PKCE `inner`. The
 * authorizer mirrors this with a single `verifyMac` feeding either
 * `verifyAssertion` (login) or `verifyMintRequest` (mint).
 *
 * Unlike the login assertion, a missing key here is a HARD error, not a graceful
 * no-op: a service configured for tenant-key auth cannot be reached without it,
 * and silently falling back would surface as an opaque downstream 401. Fail at
 * the signer with a message that names the missing env var.
 */

/** Grant type — must byte-match the authorizer's `TENANT_KEY_GRANT`. */
const TENANT_KEY_GRANT = "urn:nimblebrain:params:oauth:grant-type:tenant-key";

/** Mirrors the authorizer's `verifyMintRequest` field caps so an over-long
 *  audience/scope fails at the signer with a clear cause rather than a generic
 *  400 from the wire. */
const MAX_AUDIENCE_LENGTH = 128;
const MAX_SCOPE_LENGTH = 512;
const MIN_TENANT_KEY_BYTES = 32;

/**
 * TTL of the mint REQUEST envelope itself (not the minted token). The request
 * only has to survive the POST round-trip; the authorizer caps any envelope at
 * 30 min regardless. Short by design — a leaked request grants nothing the key
 * holder couldn't already mint, but there's no reason to let it linger.
 */
const MINT_REQUEST_TTL_SECONDS = 120;

/**
 * Re-mint this many seconds BEFORE the token's stated expiry. Covers clock skew
 * between runtime and service plus in-flight request latency, so a token handed
 * to a caller is never about to expire mid-request.
 */
const RENEW_SKEW_SECONDS = 30;

export interface MintRequestParams {
  tid: string;
  /** Workspace dimension — becomes the token's `workspace_id` claim. Validated
   *  against the runtime's canonical workspace-id grammar (`WORKSPACE_ID_RE`);
   *  the authorizer accepts it via its own bounded safe-id grammar. */
  workspace: string;
  audience: string;
  scope: string;
  tenantKey: Buffer;
  ttlSeconds?: number;
  now?: number;
}

/**
 * Build the signed mint-request wire string. Pure — no I/O, no env. Validates
 * the same shape the authorizer enforces so failures surface here with a named
 * field instead of a generic wire rejection.
 */
export function buildMintRequest(params: MintRequestParams): string {
  if (!ALLOWED_TID_PATTERN.test(params.tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  // Validate against the runtime's OWN canonical workspace-id grammar — the
  // runtime is authoritative over its workspaces and mints only for real ids
  // (`ws_<hex>`, `ws_user_<userId>`). This is stricter than the authorizer's
  // generic safe-id gate, and fails loud here if a non-workspace string ever
  // reaches the signer. The real id flows through verbatim — no rewriting.
  if (!WORKSPACE_ID_RE.test(params.workspace)) {
    throw new MintError(
      "invalid_workspace",
      `mint workspace must be a valid NimbleBrain workspace id (got '${params.workspace}')`,
    );
  }
  if (
    typeof params.audience !== "string" ||
    params.audience.length === 0 ||
    params.audience.length > MAX_AUDIENCE_LENGTH
  ) {
    throw new MintError(
      "invalid_audience",
      `mint audience must be 1..${MAX_AUDIENCE_LENGTH} chars`,
    );
  }
  if (
    typeof params.scope !== "string" ||
    params.scope.length === 0 ||
    Buffer.byteLength(params.scope, "utf8") > MAX_SCOPE_LENGTH
  ) {
    throw new MintError("invalid_scope", `mint scope must be 1..${MAX_SCOPE_LENGTH} bytes`);
  }
  if (params.tenantKey.length < MIN_TENANT_KEY_BYTES) {
    throw new MintError(
      "invalid_key",
      `tenant key must decode to >= ${MIN_TENANT_KEY_BYTES} bytes (got ${params.tenantKey.length})`,
    );
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? MINT_REQUEST_TTL_SECONDS;
  const payload = {
    tid: params.tid,
    workspace: params.workspace,
    audience: params.audience,
    scope: params.scope,
    iat: now,
    exp: now + ttl,
  };
  return signMacEnvelope(payload, params.tenantKey);
}

export type MintFailureCode =
  | "invalid_workspace"
  | "invalid_audience"
  | "invalid_scope"
  | "invalid_key"
  | "unprovisioned"
  | "http_error"
  | "bad_response";

export class MintError extends Error {
  readonly code: MintFailureCode;
  constructor(code: MintFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MintError";
  }
}

/** A minted service token plus the absolute epoch-second at which it expires. */
export interface ServiceToken {
  accessToken: string;
  /** Epoch seconds. Derived from the response `expires_in` at mint time. */
  expiresAt: number;
}

/** Identity the runtime mints AS — its own tenant. Read once from the env the
 *  authorizer provisioned. Exposed for override in tests. */
export interface TenantIdentity {
  tid: string;
  tenantKey: Buffer;
}

/**
 * Read `(tid, tenantKey)` from the deploy-provisioned env. Throws `unprovisioned`
 * — with the exact missing var — if either is absent, because a tenant-key
 * service is unreachable without them and a downstream 401 would not name the
 * cause.
 */
export function readTenantIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): TenantIdentity {
  const tid = env.NB_TENANT_ID;
  const keyB64 = env.NB_MCP_AUTHORIZER_TENANT_KEY;
  if (!tid) {
    throw new MintError("unprovisioned", "NB_TENANT_ID is not set; cannot mint service tokens");
  }
  if (!keyB64) {
    throw new MintError(
      "unprovisioned",
      "NB_MCP_AUTHORIZER_TENANT_KEY is not set; cannot mint service tokens (run `make derive-authorizer-tenant-key`)",
    );
  }
  const tenantKey = Buffer.from(keyB64, "base64");
  if (tenantKey.length < MIN_TENANT_KEY_BYTES) {
    throw new MintError(
      "invalid_key",
      `NB_MCP_AUTHORIZER_TENANT_KEY must decode to >= ${MIN_TENANT_KEY_BYTES} bytes (got ${tenantKey.length})`,
    );
  }
  return { tid, tenantKey };
}

/**
 * Resolve the authorizer's token endpoint (the POST target) — decoupled from the
 * `iss` identity. An explicit `tokenUrl` wins (a per-connection override, or
 * `NB_FLEET_AUTHORIZER_TOKEN_URL`); otherwise it is derived from the legacy,
 * identity-overloaded issuer as `${issuer}/token` for backward-compat. Because the
 * mint never inspects `iss` (only verifiers do), the endpoint can move
 * (namespace/cluster) with ZERO token-contract change — set the new var and the
 * POST target moves while `iss` stays put. Returns `undefined` when neither is
 * configured; the caller decides whether that is an error.
 */
export function resolveAuthorizerTokenUrl(
  opts: { tokenUrl?: string; issuer?: string } = {},
): string | undefined {
  // Per-connection config (opts) is more specific than global env, so it wins
  // OUTRIGHT — a connection pinned to its own authorizer via `config.issuer` /
  // `config.tokenUrl` is never silently redirected to the global endpoint once
  // Item 2 sets NB_FLEET_AUTHORIZER_TOKEN_URL. Within each tier, an explicit
  // endpoint beats the issuer-derived one.
  if (opts.tokenUrl) return opts.tokenUrl;
  if (opts.issuer) return new URL("/token", opts.issuer).toString();
  const envTokenUrl = process.env.NB_FLEET_AUTHORIZER_TOKEN_URL;
  if (envTokenUrl) return envTokenUrl;
  const envIssuer = process.env.NB_FLEET_AUTHORIZER_ISSUER;
  return envIssuer ? new URL("/token", envIssuer).toString() : undefined;
}

export interface MintServiceTokenOptions {
  /** The authorizer's token endpoint, e.g. `http://mcp-authorizer.mcp-shared.svc/token`.
   *  This is the physical POST target — deployment plumbing, NOT the `iss` identity.
   *  The mint never inspects `iss` (only verifiers do), so location and identity are
   *  decoupled: the endpoint can move (namespace/cluster) without any token-contract
   *  change. Resolve via `resolveAuthorizerTokenUrl()`. */
  tokenUrl: string;
  workspace: string;
  audience: string;
  scope: string;
  identity: TenantIdentity;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Mint one workspace-scoped service token via a single `/token` POST. No retry,
 * no cache — that's the cache layer's job. Throws `MintError` on any non-200 or
 * malformed response.
 */
export async function mintServiceToken(opts: MintServiceTokenOptions): Promise<ServiceToken> {
  const nowSeconds = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  const wire = buildMintRequest({
    tid: opts.identity.tid,
    workspace: opts.workspace,
    audience: opts.audience,
    scope: opts.scope,
    tenantKey: opts.identity.tenantKey,
    now: nowSeconds,
  });

  const tokenUrl = opts.tokenUrl;
  const body = new URLSearchParams({ grant_type: TENANT_KEY_GRANT, tenant_assertion: wire });
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(tokenUrl, {
      method: "POST",
      // Continue the trace into the authorizer (a traced mesh service). The
      // traceparent is correlation only — the tenant assertion in the body is
      // the authority. No-op when there's no active span (e.g. boot-time mint).
      headers: injectTraceparent({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: body.toString(),
    });
  } catch (cause) {
    throw new MintError(
      "http_error",
      `mint POST to ${tokenUrl} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!res.ok) {
    // The authorizer returns an OAuth-style form error; include its text so a
    // misconfig (audience not allowed, key drift) is diagnosable from logs.
    const detail = await res.text().catch(() => "");
    throw new MintError(
      "http_error",
      `mint for aud=${opts.audience} workspace=${opts.workspace} rejected ${res.status}: ${detail.slice(0, 300)}`,
    );
  }

  let json: { access_token?: unknown; expires_in?: unknown };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new MintError("bad_response", "mint response was not JSON");
  }
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new MintError("bad_response", "mint response missing access_token");
  }
  if (
    typeof json.expires_in !== "number" ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
    throw new MintError("bad_response", "mint response missing a positive expires_in");
  }
  return { accessToken: json.access_token, expiresAt: nowSeconds + json.expires_in };
}

/** Cache key — one minted token per distinct `(tokenUrl, tid, workspace, audience,
 *  scope)`. tid is included so a key-rotation that changes identity can't serve a
 *  stale token; tokenUrl namespaces by authorizer endpoint. */
function cacheKey(
  tokenUrl: string,
  tid: string,
  workspace: string,
  audience: string,
  scope: string,
): string {
  return [tokenUrl, tid, workspace, audience, scope].join("|");
}

interface CacheSlot {
  token?: ServiceToken;
  /** Single-flight: concurrent callers awaiting an in-progress mint share it. */
  inflight?: Promise<ServiceToken>;
}

export interface TokenRequest {
  /** Authorizer token endpoint (POST target), not the `iss` identity. */
  tokenUrl: string;
  workspace: string;
  audience: string;
  scope: string;
}

/**
 * Expiry-aware, single-flight cache over `mintServiceToken`. One instance backs
 * all tenant-key connections in a runtime: it dedupes concurrent mints for the
 * same `(tokenUrl, tid, workspace, audience, scope)` and re-mints just before expiry
 * (or on demand after a 401).
 *
 * Identity (`tid` + key) is read once from the env at construction and reused —
 * the runtime mints only ever AS its own tenant.
 */
export class ServiceTokenCache {
  private readonly slots = new Map<string, CacheSlot>();
  private readonly identity: TenantIdentity;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;

  constructor(
    opts: { identity?: TenantIdentity; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.identity = opts.identity ?? readTenantIdentityFromEnv();
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Return a valid bearer for the request, minting (and caching) if none is
   * fresh. `forceRefresh` discards any cached token first — the 401-retry path.
   */
  async getToken(req: TokenRequest, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const key = cacheKey(req.tokenUrl, this.identity.tid, req.workspace, req.audience, req.scope);
    const slot = this.slots.get(key) ?? {};

    if (opts.forceRefresh) {
      slot.token = undefined;
    }

    const nowSeconds = this.now();
    if (slot.token && slot.token.expiresAt - RENEW_SKEW_SECONDS > nowSeconds) {
      return slot.token.accessToken;
    }
    if (slot.inflight) {
      return (await slot.inflight).accessToken;
    }

    const inflight = mintServiceToken({
      tokenUrl: req.tokenUrl,
      workspace: req.workspace,
      audience: req.audience,
      scope: req.scope,
      identity: this.identity,
      fetchImpl: this.fetchImpl,
      now: this.now,
    });
    slot.inflight = inflight;
    this.slots.set(key, slot);

    try {
      const token = await inflight;
      slot.token = token;
      return token.accessToken;
    } finally {
      // Clear the in-flight marker whether the mint resolved or threw, so a
      // failed mint doesn't pin every future caller to the rejected promise.
      slot.inflight = undefined;
    }
  }
}

/**
 * Process-wide default cache. One instance backs every tenant-key connection in
 * the runtime, so concurrent connections to the same `(workspace, audience,
 * scope)` share a single minted token. Lazily constructed so a runtime with no
 * tenant-key bundles never reads the (possibly absent) provisioning env.
 */
let defaultCache: ServiceTokenCache | undefined;
export function getDefaultServiceTokenCache(): ServiceTokenCache {
  if (!defaultCache) defaultCache = new ServiceTokenCache();
  return defaultCache;
}

export interface MintingFetchOptions {
  cache: ServiceTokenCache;
  /** Authorizer token endpoint the cache mints against (POST target, not `iss`). */
  tokenUrl: string;
  workspace: string;
  audience: string;
  scope: string;
  /** Underlying fetch the authorized request is sent with. Defaults to global. */
  baseFetch?: typeof fetch;
}

/**
 * Build a `fetch` that authorizes every outbound request with a freshly-minted
 * (cached) tenant-key service token for one `(workspace, audience, scope)`. On a
 * 401/403 — the service rejected the token (early expiry, key rotation) — it
 * force-re-mints and retries exactly once, then surfaces the result.
 *
 * Intended as the MCP transport's `fetch` override, so the runtime reaches a
 * tenant-key data-plane service unattended: no interactive OAuth, no static
 * secret, a short-lived workspace-scoped bearer minted on demand.
 */
export function createMintingFetch(opts: MintingFetchOptions): typeof fetch {
  const base = opts.baseFetch ?? fetch;
  const req: TokenRequest = {
    tokenUrl: opts.tokenUrl,
    workspace: opts.workspace,
    audience: opts.audience,
    scope: opts.scope,
  };
  const minting = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const send = async (forceRefresh: boolean): Promise<Response> => {
      const token = await opts.cache.getToken(req, { forceRefresh });
      // We own Authorization for this connection; the transport's own headers
      // (content-type, session id) ride through via `init`.
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      // Propagate the active trace onto the authenticated remote-MCP request so
      // the span continues on the same hop as the verified service identity.
      injectTraceparent(headers);
      return base(input, { ...init, headers });
    };
    const res = await send(false);
    if (res.status === 401 || res.status === 403) {
      return send(true);
    }
    return res;
  };
  return minting as typeof fetch;
}
