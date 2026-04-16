import type { OidcAuth } from "../instance.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
} from "../provider.ts";
import type { User, UserStore } from "../user.ts";

// ── Types ─────────────────────────────────────────────────────────

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

interface OidcDiscovery {
  jwks_uri: string;
  issuer: string;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  [key: string]: unknown;
}

interface CachedJwks {
  keys: JwksKey[];
  fetchedAt: number;
}

// ── Helpers ───────────────────────────────────────────────────────

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

function base64UrlDecode(input: string): Uint8Array {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseJwt(token: string): {
  header: JwtHeader;
  payload: JwtPayload;
  signatureInput: Uint8Array;
  signature: Uint8Array;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const headerBytes = base64UrlDecode(parts[0]!);
    const payloadBytes = base64UrlDecode(parts[1]!);
    const signature = base64UrlDecode(parts[2]!);

    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as JwtHeader;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as JwtPayload;
    const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    return { header, payload, signatureInput, signature };
  } catch {
    return null;
  }
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function buildDisplayName(payload: JwtPayload): string {
  if (payload.name && typeof payload.name === "string") return payload.name;
  const parts: string[] = [];
  if (payload.given_name && typeof payload.given_name === "string") parts.push(payload.given_name);
  if (payload.family_name && typeof payload.family_name === "string")
    parts.push(payload.family_name);
  if (parts.length > 0) return parts.join(" ");
  return payload.email ?? payload.sub ?? "Unknown";
}

async function oidcUserId(sub: string): Promise<string> {
  const data = new TextEncoder().encode(sub);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `usr_oidc_${hashHex.slice(0, 12)}`;
}

// ── OidcIdentityProvider ─────────────────────────────────────────

/**
 * OIDC identity provider — JWT verification only.
 *
 * Verifies Bearer token JWTs against a configurable JWKS endpoint.
 * Auto-provisions users into the local UserStore on first valid login.
 * No auth code flow — providers that need redirect login (WorkOS, Clerk)
 * bring their own SDK and implement it in their own provider.
 */
export class OidcIdentityProvider implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
  };

  private issuer: string;
  private clientId: string;
  private allowedDomains: string[];
  private jwksUri: string | undefined;
  private userStore: UserStore;

  private jwksCache: CachedJwks | null = null;
  private discoveryCache: OidcDiscovery | null = null;

  /** Overridable fetch for testing. */
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

  /** Overridable clock for testing. */
  now: () => number = () => Date.now();

  constructor(config: OidcAuth, userStore: UserStore) {
    this.issuer = config.issuer.replace(/\/+$/, "");
    this.clientId = config.clientId;
    this.allowedDomains = config.allowedDomains.map((d) => d.toLowerCase());
    this.jwksUri = config.jwksUri;
    this.userStore = userStore;
  }

  async verifyRequest(req: Request): Promise<UserIdentity | null> {
    const token = extractBearerToken(req);
    if (!token) return null;

    const parsed = parseJwt(token);
    if (!parsed) return null;

    const { header, payload, signatureInput, signature } = parsed;

    if (header.alg !== "RS256") return null;
    if (!this.validateClaims(payload)) return null;
    if (!this.validateDomain(payload.email)) return null;

    const keys = await this.getJwks();
    if (!keys) return null;

    const verified = await this.verifySignature(header, signatureInput, signature, keys);
    if (!verified) return null;

    const email = payload.email!;
    const sub = payload.sub ?? email;
    const deterministicId = await oidcUserId(sub);

    let user = await this.userStore.get(deterministicId);
    if (!user) {
      user = await this.userStore.getByEmail(email);
    }

    if (!user) {
      user = await this.userStore.create({
        id: deterministicId,
        email,
        displayName: buildDisplayName(payload),
        orgRole: "member",
      });
    }

    return toIdentity(user);
  }

  async listUsers(): Promise<User[]> {
    return this.userStore.list();
  }

  async createUser(data: CreateUserInput): Promise<CreateUserResult> {
    const user = await this.userStore.create({
      email: data.email,
      displayName: data.displayName,
      orgRole: data.orgRole,
    });
    return { user };
  }

  async deleteUser(userId: string): Promise<boolean> {
    return this.userStore.delete(userId);
  }

  // ── Private helpers ────────────────────────────────────────────

  private validateClaims(payload: JwtPayload): boolean {
    const tokenIssuer = typeof payload.iss === "string" ? payload.iss.replace(/\/+$/, "") : "";
    if (tokenIssuer !== this.issuer) return false;

    if (payload.aud === undefined) return false;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.clientId)) return false;

    if (typeof payload.exp !== "number") return false;
    const nowSec = Math.floor(this.now() / 1000);
    if (payload.exp <= nowSec) return false;

    if (typeof payload.email !== "string") return false;

    return true;
  }

  private validateDomain(email: string | undefined): boolean {
    if (!email) return false;
    const atIndex = email.lastIndexOf("@");
    if (atIndex < 0) return false;
    const domain = email.slice(atIndex + 1).toLowerCase();
    return this.allowedDomains.includes(domain);
  }

  private async getJwks(): Promise<JwksKey[] | null> {
    const nowMs = this.now();

    if (this.jwksCache && nowMs - this.jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.jwksCache.keys;
    }

    try {
      let jwksUrl: string;
      if (this.jwksUri) {
        jwksUrl = this.jwksUri;
      } else {
        const discovery = await this.fetchDiscovery();
        if (!discovery) return null;
        jwksUrl = discovery.jwks_uri;
      }

      const jwksRes = await this.fetcher(jwksUrl);
      if (!jwksRes.ok) return null;

      const jwks = (await jwksRes.json()) as JwksResponse;
      if (!jwks.keys || !Array.isArray(jwks.keys)) return null;

      this.jwksCache = { keys: jwks.keys, fetchedAt: nowMs };
      return jwks.keys;
    } catch {
      return null;
    }
  }

  private async fetchDiscovery(): Promise<OidcDiscovery | null> {
    if (this.discoveryCache) return this.discoveryCache;

    try {
      const url = `${this.issuer}/.well-known/openid-configuration`;
      const res = await this.fetcher(url);
      if (!res.ok) return null;

      const doc = (await res.json()) as OidcDiscovery;
      if (typeof doc.jwks_uri !== "string") return null;

      this.discoveryCache = doc;
      return doc;
    } catch {
      return null;
    }
  }

  private async verifySignature(
    header: JwtHeader,
    data: Uint8Array,
    signature: Uint8Array,
    keys: JwksKey[],
  ): Promise<boolean> {
    let candidates: JwksKey[];
    if (header.kid) {
      candidates = keys.filter((k) => k.kid === header.kid);
    } else {
      candidates = keys.filter((k) => k.kty === "RSA");
    }

    for (const jwk of candidates) {
      try {
        const cryptoKey = await crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );

        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          cryptoKey,
          signature as Uint8Array<ArrayBuffer>,
          data as Uint8Array<ArrayBuffer>,
        );
        if (valid) return true;
      } catch {
        // Key mismatch — expected during key rotation, try next candidate
      }
    }
    if (candidates.length > 0) {
      console.warn(
        "[oidc] JWT signature verification failed: no matching key found among",
        candidates.length,
        "candidates",
      );
    }

    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function toIdentity(user: User): UserIdentity {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    orgRole: user.orgRole,
    preferences: user.preferences,
  };
}
