import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Signed state envelope for the OAuth callback bouncer.
 *
 * The platform supports two deployment modes for vendor OAuth callbacks:
 *
 * 1. **Direct mode** (default; single-tenant self-hosts):
 *    `redirect_uri` registered at the vendor is the tenant's own host.
 *    `state` is opaque; no envelope.
 *
 * 2. **Bouncer mode** (multi-tenant deployments):
 *    A single `redirect_uri` is registered at every vendor — pointing
 *    at a stateless router that fans callbacks out to the originating
 *    tenant by name. The wire `state` is wrapped in this envelope so
 *    the router can authenticate the routing decision without holding
 *    session state.
 *
 * Wire format (URL-safe, compact, version-tagged):
 *
 *     v1.<base64url(payload)>.<base64url(mac)>
 *
 *     payload  = { tid, inner, iat, exp }   (canonical JSON)
 *     mac      = HMAC-SHA256(tenantKey, "v1.<base64url(payload)>")
 *     tenantKey = HKDF-SHA256(masterKey, salt=tid, info="oauth-bouncer/v1", L=32)
 *
 * `inner` is the existing CSRF state token (already bound to
 * `nb_oauth_state` cookie by the callback route). The envelope does not
 * replace that binding — it carries it through opaquely. Both checks
 * must pass on callback: router-side HMAC and tenant-side cookie hash.
 *
 * Trust boundary:
 *   - `masterKey` lives ONLY on the bouncer.
 *   - Tenant pods receive a pre-derived `tenantKey` at deploy time.
 *   - Compromise of a tenant pod leaks one derived key — forged states
 *     for that tid route back to that same tid (no lateral movement).
 */

export const ENVELOPE_VERSION = "v1";
const VERSION_PREFIX = `${ENVELOPE_VERSION}.`;
const HKDF_INFO = Buffer.from("oauth-bouncer/v1");

export const DEFAULT_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/**
 * Maximum lifetime of an envelope at verify time, regardless of what `exp`
 * the signer claimed. Enforced as `exp - iat <= MAX_ENVELOPE_LIFETIME`.
 * Caps the blast radius of a derived-key leak: rather than letting an
 * attacker mint long-lived forgeries that bypass the freshness window,
 * the verifier rejects anything claiming a longer life than this. Set
 * to 2× the default TTL so any future operator change to `ttlSeconds`
 * within reasonable bounds still works without revisiting this.
 */
const MAX_ENVELOPE_LIFETIME_SECONDS = 30 * 60;
const MIN_MASTER_KEY_BYTES = 32;

const MAX_WIRE_LENGTH = 4096;
const MAX_PAYLOAD_BYTES = 1024;

/**
 * Cap on the inner CSRF token length. Mirrors the verifier-side cap so
 * sign and verify stay symmetric — `signEnvelope` rejects oversize
 * inputs upfront rather than producing wire bytes that every peer
 * refuses to verify.
 */
const MAX_INNER_LENGTH = 512;

/**
 * Tenant identifiers are interpolated into hostnames downstream by the
 * bouncer. The regex pins them to RFC 1123 §2.1 DNS label grammar
 * (1–63 chars, leading letter, alphanumeric or hyphen interior,
 * trailing alphanumeric) so an attacker cannot smuggle path segments,
 * ports, or percent-encoding through a forged payload to coerce the
 * bouncer into an off-platform redirect.
 */
export const ALLOWED_TID_PATTERN = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type EnvelopeFailureCode =
  | "invalid_format"
  | "invalid_payload"
  | "invalid_tid"
  | "expired"
  | "issued_in_future"
  | "bad_mac"
  | "tid_mismatch";

export class EnvelopeError extends Error {
  readonly code: EnvelopeFailureCode;
  constructor(code: EnvelopeFailureCode) {
    super(`oauth envelope rejected: ${code}`);
    this.code = code;
    this.name = "EnvelopeError";
  }
}

export interface EnvelopePayload {
  tid: string;
  inner: string;
  iat: number;
  exp: number;
}

export interface SignOptions {
  tid: string;
  inner: string;
  tenantKey: Buffer;
  ttlSeconds?: number;
  now?: number;
}

/**
 * Derive a per-tenant signing key from the bouncer's master key.
 *
 * Used by:
 *   - Deploy-time provisioning that writes a tenant's key to its
 *     credential store. The tenant pod itself never sees the master.
 *   - The bouncer at request time, to verify states whose tid was
 *     extracted from the (still-unverified) payload.
 *
 * Returned keys MUST be treated as opaque, length-32 secrets — passing
 * shorter inputs as `masterKey` weakens the derived key, so the caller
 * is expected to validate length at boot.
 */
export function deriveTenantKey(masterKey: Buffer, tid: string): Buffer {
  if (masterKey.length < MIN_MASTER_KEY_BYTES) {
    // Fail loud at the boundary. A short master would silently weaken every
    // derived key, and the failure mode (verification mismatches in prod)
    // wouldn't point at the root cause.
    throw new Error(
      `oauth envelope: master key must be at least ${MIN_MASTER_KEY_BYTES} bytes (got ${masterKey.length})`,
    );
  }
  if (!ALLOWED_TID_PATTERN.test(tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from(tid, "utf8"), HKDF_INFO, 32));
}

export function signEnvelope(opts: SignOptions): string {
  if (!ALLOWED_TID_PATTERN.test(opts.tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  if (
    typeof opts.inner !== "string" ||
    opts.inner.length === 0 ||
    opts.inner.length > MAX_INNER_LENGTH
  ) {
    throw new EnvelopeError("invalid_payload");
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const payload: EnvelopePayload = {
    tid: opts.tid,
    inner: opts.inner,
    iat: now,
    exp: now + ttl,
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  if (payloadB64.length > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeError("invalid_payload");
  }
  const signed = `${VERSION_PREFIX}${payloadB64}`;
  const macB64 = base64UrlEncode(createHmac("sha256", opts.tenantKey).update(signed).digest());
  return `${signed}.${macB64}`;
}

/**
 * Tenant-side verification: the caller (a tenant pod) presents the key
 * it already holds and the tid it expects (its own). Mismatched tid is
 * a routing bug or a forgery — either way, reject.
 *
 * Returns the parsed payload so the caller can extract `inner` for the
 * downstream cookie-binding check.
 */
export function verifyEnvelopeAsTenant(opts: {
  wire: string;
  tenantKey: Buffer;
  expectedTid: string;
  now?: number;
}): EnvelopePayload {
  const { payload } = parseAndVerify(opts.wire, opts.tenantKey, opts.now);
  if (payload.tid !== opts.expectedTid) {
    throw new EnvelopeError("tid_mismatch");
  }
  return payload;
}

/**
 * Bouncer-side verification: the caller is the router, which doesn't
 * know which tenant the flow belongs to until it has parsed the
 * envelope. We extract tid from the payload BEFORE HMAC verification,
 * but that's safe — tid is allowlist-validated, and a forged tid won't
 * pass HMAC unless the attacker also has the (derived) tenant key.
 *
 * Returns the verified tid so the bouncer can construct the redirect.
 */
export function verifyEnvelopeAsRouter(opts: { wire: string; masterKey: Buffer; now?: number }): {
  tid: string;
  payload: EnvelopePayload;
} {
  const peeked = peekTid(opts.wire);
  const tenantKey = deriveTenantKey(opts.masterKey, peeked);
  const { payload } = parseAndVerify(opts.wire, tenantKey, opts.now);
  // Defense in depth. Today this is redundant: the MAC has already
  // proved the payload bytes weren't modified, and V8's `JSON.parse`
  // is deterministic over identical bytes, so `payload.tid` must equal
  // `peeked`. The check survives a future change to the parsing path
  // (streaming parser, different runtime, key-deduplication semantics)
  // that would otherwise silently let `peeked` and `payload.tid`
  // diverge — turning a routing decision into an attacker-controlled
  // primitive. The cost is one comparison.
  if (peeked !== payload.tid) {
    throw new EnvelopeError("invalid_tid");
  }
  return { tid: payload.tid, payload };
}

function peekTid(wire: string): string {
  const { payloadB64 } = splitWire(wire);
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new EnvelopeError("invalid_payload");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { tid?: unknown }).tid !== "string"
  ) {
    throw new EnvelopeError("invalid_payload");
  }
  const tid = (payload as { tid: string }).tid;
  if (!ALLOWED_TID_PATTERN.test(tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  return tid;
}

/**
 * Structural parse of the wire string. Narrows the three segments to
 * defined `string`s so callers don't have to re-check. Length and
 * version checks live here so they're applied exactly once per verify.
 */
function splitWire(wire: string): { payloadB64: string; macB64: string } {
  if (typeof wire !== "string" || wire.length === 0 || wire.length > MAX_WIRE_LENGTH) {
    throw new EnvelopeError("invalid_format");
  }
  const parts = wire.split(".");
  if (parts.length !== 3) {
    throw new EnvelopeError("invalid_format");
  }
  const [version, payloadB64, macB64] = parts;
  if (version !== ENVELOPE_VERSION || payloadB64 === undefined || macB64 === undefined) {
    throw new EnvelopeError("invalid_format");
  }
  return { payloadB64, macB64 };
}

function parseAndVerify(
  wire: string,
  key: Buffer,
  nowOverride: number | undefined,
): { payload: EnvelopePayload } {
  const { payloadB64, macB64 } = splitWire(wire);
  if (payloadB64.length > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeError("invalid_payload");
  }

  let payloadRaw: Buffer;
  let macProvided: Buffer;
  try {
    payloadRaw = base64UrlDecode(payloadB64);
    macProvided = base64UrlDecode(macB64);
  } catch {
    throw new EnvelopeError("invalid_format");
  }

  const signed = `${VERSION_PREFIX}${payloadB64}`;
  const macExpected = createHmac("sha256", key).update(signed).digest();

  // Length check first — `timingSafeEqual` requires equal-length inputs
  // and throws on mismatch. We classify any length difference as a bad
  // MAC rather than letting the throw escape.
  if (macProvided.length !== macExpected.length) {
    throw new EnvelopeError("bad_mac");
  }
  if (!timingSafeEqual(macProvided, macExpected)) {
    throw new EnvelopeError("bad_mac");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRaw.toString("utf8"));
  } catch {
    throw new EnvelopeError("invalid_payload");
  }
  const payload = validatePayloadShape(parsed);

  // Verifier-side cap on declared lifetime. Even with a valid MAC, an
  // envelope claiming a longer life than this is rejected — bounds the
  // damage of a derived-key leak.
  if (payload.exp - payload.iat > MAX_ENVELOPE_LIFETIME_SECONDS) {
    throw new EnvelopeError("expired");
  }

  const now = nowOverride ?? Math.floor(Date.now() / 1000);
  if (now > payload.exp) {
    throw new EnvelopeError("expired");
  }
  if (now < payload.iat - CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new EnvelopeError("issued_in_future");
  }

  return { payload };
}

function validatePayloadShape(raw: unknown): EnvelopePayload {
  if (!raw || typeof raw !== "object") {
    throw new EnvelopeError("invalid_payload");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.tid !== "string" || !ALLOWED_TID_PATTERN.test(r.tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  if (typeof r.inner !== "string" || r.inner.length === 0 || r.inner.length > MAX_INNER_LENGTH) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof r.iat !== "number" || !Number.isFinite(r.iat) || r.iat < 0) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof r.exp !== "number" || !Number.isFinite(r.exp) || r.exp <= r.iat) {
    throw new EnvelopeError("invalid_payload");
  }
  return { tid: r.tid, inner: r.inner, iat: r.iat, exp: r.exp };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
