import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TID_PATTERN,
  DEFAULT_TTL_SECONDS,
  EnvelopeError,
  ENVELOPE_VERSION,
  MAX_INNER_LENGTH,
  deriveTenantKey,
  signEnvelope,
  verifyEnvelopeAsRouter,
  verifyEnvelopeAsTenant,
} from "../../src/oauth/envelope.ts";

const MASTER = randomBytes(32);
const TID = "tenant-a";
const INNER = "abc123-csrf-token-value";

function tenantKey(tid: string = TID): Buffer {
  return deriveTenantKey(MASTER, tid);
}

describe("envelope round-trip", () => {
  test("tenant signs and verifies its own envelope", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const payload = verifyEnvelopeAsTenant({
      wire,
      tenantKey: tenantKey(),
      expectedTid: TID,
    });
    expect(payload.tid).toBe(TID);
    expect(payload.inner).toBe(INNER);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  test("router verifies with master key (derives tenant key on the fly)", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const result = verifyEnvelopeAsRouter({ wire, masterKey: MASTER });
    expect(result.tid).toBe(TID);
    expect(result.payload.inner).toBe(INNER);
  });

  test("wire format is v1.<b64>.<b64>", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const parts = wire.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(ENVELOPE_VERSION);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("envelope rejects forgeries", () => {
  test("MAC mismatch → bad_mac", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const [v, payload] = wire.split(".");
    const forged = `${v}.${payload}.${"A".repeat(43)}`;
    expectError(() => verifyEnvelopeAsTenant({ wire: forged, tenantKey: tenantKey(), expectedTid: TID }), "bad_mac");
  });

  test("signed with wrong tenant key → bad_mac", () => {
    const attackerKey = deriveTenantKey(MASTER, "tenant-z");
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: attackerKey });
    expectError(() => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID }), "bad_mac");
  });

  test("payload tampering invalidates MAC", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const [, , mac] = wire.split(".");
    const tampered = Buffer.from(JSON.stringify({ tid: "tenant-b", inner: INNER, iat: 0, exp: 9e9 })).toString("base64url");
    const forged = `${ENVELOPE_VERSION}.${tampered}.${mac}`;
    expectError(() => verifyEnvelopeAsTenant({ wire: forged, tenantKey: tenantKey(), expectedTid: TID }), "bad_mac");
  });

  test("router rejects forged tid (HKDF gives different key)", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const parts = wire.split(".");
    const swapped = Buffer.from(JSON.stringify({ tid: "tenant-b", inner: INNER, iat: 1, exp: 9e9 })).toString("base64url");
    const forged = `${parts[0]}.${swapped}.${parts[2]}`;
    expectError(() => verifyEnvelopeAsRouter({ wire: forged, masterKey: MASTER }), "bad_mac");
  });
});

describe("envelope rejects malformed input", () => {
  test("non-string wire → invalid_format", () => {
    expectError(() => verifyEnvelopeAsTenant({ wire: undefined as unknown as string, tenantKey: tenantKey(), expectedTid: TID }), "invalid_format");
  });

  test("missing parts → invalid_format", () => {
    expectError(() => verifyEnvelopeAsTenant({ wire: "v1.justone", tenantKey: tenantKey(), expectedTid: TID }), "invalid_format");
  });

  test("wrong version prefix → invalid_format", () => {
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey() });
    const swapped = "v2" + wire.slice(2);
    expectError(() => verifyEnvelopeAsTenant({ wire: swapped, tenantKey: tenantKey(), expectedTid: TID }), "invalid_format");
  });

  test("oversize wire → invalid_format", () => {
    const huge = "v1." + "A".repeat(5000) + ".AAAA";
    expectError(() => verifyEnvelopeAsTenant({ wire: huge, tenantKey: tenantKey(), expectedTid: TID }), "invalid_format");
  });

  test("non-JSON payload → invalid_payload", () => {
    const payloadB64 = Buffer.from("not-json").toString("base64url");
    const mac = Buffer.alloc(32).toString("base64url");
    expectError(
      () => verifyEnvelopeAsTenant({ wire: `v1.${payloadB64}.${mac}`, tenantKey: tenantKey(), expectedTid: TID }),
      // bad_mac fires first because MAC check precedes JSON parse; either is fine,
      // but we MUST NOT crash. Accept either failure code.
      ["bad_mac", "invalid_payload"],
    );
  });
});

describe("envelope tid handling", () => {
  test("rejects tid with invalid characters at sign time", () => {
    expectError(
      () => signEnvelope({ tid: "TENANT.evil", inner: INNER, tenantKey: tenantKey() }),
      "invalid_tid",
    );
  });

  test("rejects tid containing path traversal at router verification", () => {
    expect(() => deriveTenantKey(MASTER, "../../etc/passwd")).toThrow(EnvelopeError);
  });

  test("rejects tid mismatch between expected and payload (tenant view)", () => {
    const wire = signEnvelope({ tid: "tenant-b", inner: INNER, tenantKey: deriveTenantKey(MASTER, "tenant-b") });
    expectError(() => verifyEnvelopeAsTenant({ wire, tenantKey: deriveTenantKey(MASTER, "tenant-b"), expectedTid: "tenant-a" }), "tid_mismatch");
  });

  test("ALLOWED_TID_PATTERN pins to RFC 1123 DNS label grammar", () => {
    for (const ok of ["tenant-a", "tenant-c", "tenant-b", "client-7", "a", "a1b2c3", "ab"]) {
      expect(ALLOWED_TID_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "1starts-with-digit",
      "-leading-dash",
      "UPPER",
      "has.dot",
      "has/slash",
      "trailing-",
    ]) {
      expect(ALLOWED_TID_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("envelope expiration", () => {
  test("rejects expired envelope", () => {
    const past = Math.floor(Date.now() / 1000) - DEFAULT_TTL_SECONDS - 60;
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey(), now: past });
    expectError(() => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID }), "expired");
  });

  test("accepts envelope inside its TTL window", () => {
    const now = Math.floor(Date.now() / 1000);
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey(), now, ttlSeconds: 600 });
    expect(() => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID, now: now + 300 })).not.toThrow();
  });

  test("rejects envelope from the far future (clock skew bound)", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey(), now: future });
    expectError(() => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID }), "issued_in_future");
  });

  test("accepts envelope right at the 60s clock-skew boundary", () => {
    const now = 1_700_000_000;
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey(), now });
    // Verifier's clock is 60s behind; envelope's iat is in the future by 60s exactly — should pass.
    expect(() =>
      verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID, now: now - 60 }),
    ).not.toThrow();
  });

  test("rejects one second past the clock-skew boundary", () => {
    const now = 1_700_000_000;
    const wire = signEnvelope({ tid: TID, inner: INNER, tenantKey: tenantKey(), now });
    expectError(
      () => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID, now: now - 61 }),
      "issued_in_future",
    );
  });

  test("rejects envelope claiming a lifetime longer than verifier accepts", () => {
    // Bypass signEnvelope's TTL by hand-crafting a payload with a 24h life.
    // This is exactly the forgery shape a leaked tenant key would enable.
    const now = Math.floor(Date.now() / 1000);
    const payload = { tid: TID, inner: INNER, iat: now, exp: now + 24 * 3600 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signed = `v1.${payloadB64}`;
    const mac = createHmac("sha256", tenantKey()).update(signed).digest().toString("base64url");
    const wire = `${signed}.${mac}`;
    expectError(
      () => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID }),
      "expired",
    );
  });
});

describe("envelope payload boundary checks", () => {
  test("accepts inner at the MAX_INNER_LENGTH upper bound (ASCII)", () => {
    const innerAtCap = "x".repeat(MAX_INNER_LENGTH);
    const wire = signEnvelope({ tid: TID, inner: innerAtCap, tenantKey: tenantKey() });
    const payload = verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID });
    expect(payload.inner).toHaveLength(MAX_INNER_LENGTH);
  });

  test("signEnvelope rejects inner one character past MAX_INNER_LENGTH", () => {
    // Sign-side check keeps the contract symmetric with verify — a signer
    // should never produce wire bytes that every peer rejects.
    expectError(
      () => signEnvelope({ tid: TID, inner: "x".repeat(MAX_INNER_LENGTH + 1), tenantKey: tenantKey() }),
      "invalid_payload",
    );
  });

  test("verify also rejects an oversize inner if one is hand-crafted past the signer", () => {
    // Belt-and-suspenders: even if a future signer regression slips an
    // oversize inner past the sign-side check, the verifier still catches it.
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      tid: TID,
      inner: "x".repeat(MAX_INNER_LENGTH + 1),
      iat: now,
      exp: now + 900,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signed = `v1.${payloadB64}`;
    const mac = createHmac("sha256", tenantKey()).update(signed).digest().toString("base64url");
    const wire = `${signed}.${mac}`;
    expectError(
      () => verifyEnvelopeAsTenant({ wire, tenantKey: tenantKey(), expectedTid: TID }),
      "invalid_payload",
    );
  });
});

describe("master key validation", () => {
  test("deriveTenantKey rejects a too-short master key", () => {
    const tooShort = Buffer.alloc(16); // 128 bits, half what HKDF expects
    expect(() => deriveTenantKey(tooShort, TID)).toThrow(/at least 32 bytes/);
  });

  test("deriveTenantKey accepts a 32-byte master key", () => {
    const ok = randomBytes(32);
    expect(() => deriveTenantKey(ok, TID)).not.toThrow();
  });
});

describe("HKDF key derivation", () => {
  test("different tids produce different keys", () => {
    const k1 = deriveTenantKey(MASTER, "tenant-a");
    const k2 = deriveTenantKey(MASTER, "tenant-b");
    expect(k1.equals(k2)).toBe(false);
  });

  test("same tid + same master produces identical keys (deterministic)", () => {
    const k1 = deriveTenantKey(MASTER, "tenant-a");
    const k2 = deriveTenantKey(MASTER, "tenant-a");
    expect(k1.equals(k2)).toBe(true);
  });

  test("derived key is 32 bytes", () => {
    const key = deriveTenantKey(MASTER, "tenant-a");
    expect(key).toHaveLength(32);
  });

  test("changing master changes all derived keys", () => {
    const m1 = randomBytes(32);
    const m2 = randomBytes(32);
    const k1 = deriveTenantKey(m1, "tenant-a");
    const k2 = deriveTenantKey(m2, "tenant-a");
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("master key entropy sanity checks", () => {
  test("rejects all-zeros master key (placeholder pattern)", () => {
    const zeros = Buffer.alloc(32, 0);
    expect(() => deriveTenantKey(zeros, "tenant-a")).toThrow(/placeholder pattern/);
  });

  test("rejects all-0xff master key (placeholder pattern)", () => {
    const ffs = Buffer.alloc(32, 0xff);
    expect(() => deriveTenantKey(ffs, "tenant-a")).toThrow(/placeholder pattern/);
  });

  test("accepts a CSPRNG-generated master key with one byte differing", () => {
    // Even a master key where 31/32 bytes are zero is acceptable — the
    // check is for the obvious "Buffer.alloc(32)" foot-gun, not for
    // measuring entropy in general.
    const nearZero = Buffer.alloc(32, 0);
    nearZero[7] = 0x42;
    expect(() => deriveTenantKey(nearZero, "tenant-a")).not.toThrow();
  });
});

describe("inner length is measured in UTF-8 bytes", () => {
  test("signEnvelope accepts inner exactly at the byte boundary with multibyte chars", () => {
    // "🙂" is 4 UTF-8 bytes and 2 UTF-16 code units. Pack the cap full.
    const emojiCount = MAX_INNER_LENGTH / 4;
    const inner = "🙂".repeat(emojiCount);
    expect(Buffer.byteLength(inner, "utf8")).toBe(MAX_INNER_LENGTH);
    expect(() => signEnvelope({ tid: TID, inner, tenantKey: tenantKey() })).not.toThrow();
  });

  test("signEnvelope rejects inner whose UTF-8 byte length exceeds the cap, even when UTF-16 length fits", () => {
    // One emoji past the cap = MAX_INNER_LENGTH + 4 UTF-8 bytes, but the
    // UTF-16 length stays at (MAX_INNER_LENGTH / 4 + 1) * 2, still under
    // the cap if it were measured in code units. The pre-fix
    // `inner.length` check would have allowed this; the byte-length
    // check correctly rejects.
    const inner = "🙂".repeat(MAX_INNER_LENGTH / 4 + 1);
    expect(inner.length).toBeLessThan(MAX_INNER_LENGTH);
    expect(Buffer.byteLength(inner, "utf8")).toBeGreaterThan(MAX_INNER_LENGTH);
    expectError(
      () => signEnvelope({ tid: TID, inner, tenantKey: tenantKey() }),
      "invalid_payload",
    );
  });
});

// --- helpers --------------------------------------------------------

function expectError(fn: () => unknown, codes: string | string[]): void {
  const accepted = Array.isArray(codes) ? codes : [codes];
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    expect(accepted).toContain((err as EnvelopeError).code);
    return;
  }
  throw new Error(`Expected EnvelopeError(${accepted.join("|")}) but no error thrown`);
}
