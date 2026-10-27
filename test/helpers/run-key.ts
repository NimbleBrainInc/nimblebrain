import { generateKeyPairSync } from "node:crypto";
import type { RunKeySet } from "../../src/runtime/run-key.ts";

/** A fresh Ed25519 private JWK, as an operator stores it in the run key ring. */
export function runKeyJwk(kid: string): {
  kty: string;
  crv: string;
  kid: string;
  d: string;
  x: string;
} {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", kid, d: jwk.d as string, x: jwk.x as string };
}

/** The stored value of a ring: a JWK Set, signing key first. */
export function runKeyRingValue(...keys: ReturnType<typeof runKeyJwk>[]): string {
  return JSON.stringify({ keys });
}

export interface VerifiedJwt {
  header: { alg: string; typ: string; kid: string };
  claims: Record<string, unknown>;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Verify a credential as a gateway does, with WebCrypto rather than the
 * `node:crypto` path that signed it: find the key by `kid` in the published
 * set, check the signature, then the issuer, audience and expiry. Throws with
 * the reason on any failure.
 */
export async function verifyAsGateway(
  token: string,
  keySet: RunKeySet,
  expected: { issuer: string; audience: string; nowMs?: number; leewayMs?: number },
): Promise<VerifiedJwt> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed");
  const header = decodeSegment(h) as VerifiedJwt["header"];
  if (header.alg !== "EdDSA") throw new Error("alg");
  const jwk = keySet.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown kid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    Buffer.from(s, "base64url"),
    Buffer.from(`${h}.${p}`, "ascii"),
  );
  if (!ok) throw new Error("signature");
  const claims = decodeSegment(p);
  if (claims.iss !== expected.issuer) throw new Error("issuer");
  if (claims.aud !== expected.audience) throw new Error("audience");
  const now = (expected.nowMs ?? Date.now()) / 1000;
  const leeway = (expected.leewayMs ?? 0) / 1000;
  if (typeof claims.exp !== "number" || now >= claims.exp + leeway) throw new Error("expired");
  return { header, claims };
}
