import { GeneratePortalLinkIntent, WorkOS } from "@workos-inc/node";
import type { WorkosAuth } from "../instance.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  TokenResult,
  UserIdentity,
} from "../provider.ts";
import type { OrgRole } from "../types.ts";
import type { User, UserStore } from "../user.ts";

// ── JWT helpers (shared with OIDC provider — duplicated intentionally to keep providers independent) ──

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface WorkosJwtPayload {
  sub?: string;
  sid?: string;
  org_id?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface CachedJwks {
  keys: JwksKey[];
  fetchedAt: number;
}

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
  payload: WorkosJwtPayload;
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
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as WorkosJwtPayload;
    const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    return { header, payload, signatureInput, signature };
  } catch {
    return null;
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  // Fall back to nb_session cookie (set during auth code flow callback)
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("nb_session=")) return trimmed.slice(11);
  }
  return null;
}

// ── WorkosIdentityProvider ────────────────────────────────────────

/**
 * Identity provider backed by the WorkOS SDK.
 *
 * Handles auth code flow (redirect login), JWT verification against
 * WorkOS JWKS, and user management via the WorkOS User Management API.
 *
 * This provider does NOT use the local UserStore — WorkOS is the
 * source of truth for users.
 */
export class WorkosIdentityProvider implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: true,
    tokenRefresh: true,
    managedUsers: true,
  };

  private workos: WorkOS;
  private clientId: string;
  private redirectUri: string;
  private organizationId: string | undefined;
  private authkitDomain: string | undefined;
  private userStore: UserStore | null;

  private jwksCache: CachedJwks | null = null;
  private authkitJwksCache: CachedJwks | null = null;
  private userCache = new Map<string, { identity: UserIdentity; fetchedAt: number }>();
  private static USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** Overridable for testing. */
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  now: () => number = () => Date.now();

  constructor(config: WorkosAuth, userStore?: UserStore) {
    const apiKey = process.env.WORKOS_API_KEY ?? config.apiKey ?? "";
    this.workos = new WorkOS(apiKey, { clientId: config.clientId });
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.organizationId = config.organizationId;
    this.authkitDomain = config.authkitDomain;
    this.userStore = userStore ?? null;
  }

  // ── IdentityProvider interface ──────────────────────────────────

  getAuthorizationUrl(): string {
    return this.buildAuthorizationUrl();
  }

  async verifyRequest(req: Request): Promise<UserIdentity | null> {
    const token = extractToken(req);
    if (!token) return null;

    const parsed = parseJwt(token);
    if (!parsed) return null;

    const { header, payload, signatureInput, signature } = parsed;

    if (header.alg !== "RS256") return null;

    // Validate expiration
    if (typeof payload.exp !== "number") return null;
    const nowSec = Math.floor(this.now() / 1000);
    if (payload.exp <= nowSec) return null;

    // Must have sub (WorkOS user ID)
    if (typeof payload.sub !== "string") return null;

    // Route verification based on issuer: AuthKit MCP OAuth vs WorkOS User Management
    const authkitIssuer = this.authkitDomain ? `https://${this.authkitDomain}.authkit.app` : null;

    if (authkitIssuer && payload.iss === authkitIssuer) {
      // AuthKit-issued JWT (from MCP OAuth flow) — verify against AuthKit JWKS
      const keys = await this.getAuthkitJwks();
      if (!keys) {
        console.error("[workos] AuthKit JWKS fetch failed");
        return null;
      }

      const verified = await this.verifySignature(header, signatureInput, signature, keys);
      if (!verified) {
        console.error("[workos] AuthKit JWT signature verification failed");
        return null;
      }

      return this.resolveUser(payload.sub);
    }

    // WorkOS User Management JWT (from session cookie / existing flow)
    // Validate org_id matches configured organization
    if (this.organizationId && payload.org_id !== this.organizationId) return null;

    // Verify signature against WorkOS JWKS
    const keys = await this.getJwks();
    if (!keys) return null;

    const verified = await this.verifySignature(header, signatureInput, signature, keys);
    if (!verified) return null;

    // Resolve user from WorkOS
    return this.resolveUser(payload.sub);
  }

  async exchangeCode(code: string, codeVerifier?: string): Promise<TokenResult> {
    const result = await this.workos.userManagement.authenticateWithCode({
      clientId: this.clientId,
      code,
      codeVerifier,
    });

    // SECURITY: Verify org membership BEFORE provisioning.
    // authenticateWithCode succeeds for any WorkOS user — org_id in the JWT
    // is only checked later in verifyRequest(). We must gate provisioning here.
    if (this.organizationId) {
      const orgRole = await this.resolveOrgRole(result.user.id);
      if (orgRole === null) {
        throw new Error(`User ${result.user.email} is not a member of this organization`);
      }
    }

    // Provision user on first login — sync profile + create private workspace
    await this.provisionUser(result.user);

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenResult> {
    const result = await this.workos.userManagement.authenticateWithRefreshToken({
      clientId: this.clientId,
      refreshToken,
    });
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  async listUsers(): Promise<User[]> {
    const result = await this.workos.userManagement.listUsers();
    const users: User[] = [];
    for (const workosUser of result.data) {
      const orgRole = await this.resolveOrgRole(workosUser.id);
      // Only include users with org membership
      if (orgRole !== null) {
        users.push(toUser(workosUser, orgRole));
      }
    }
    return users;
  }

  async createUser(data: CreateUserInput): Promise<CreateUserResult> {
    const [firstName, ...rest] = data.displayName.split(" ");
    const result = await this.workos.userManagement.createUser({
      email: data.email,
      firstName: firstName ?? data.displayName,
      lastName: rest.length > 0 ? rest.join(" ") : undefined,
    });
    return { user: toUser(result) };
  }

  async deleteUser(userId: string): Promise<boolean> {
    try {
      await this.workos.userManagement.deleteUser(userId);
      return true;
    } catch {
      return false;
    }
  }

  invalidateUser(userId: string): void {
    this.userCache.delete(userId);
  }

  // ── WorkOS-specific methods (not on the interface) ──────────────

  /** Generate the Admin Portal URL for self-serve SSO/directory setup. */
  async getAdminPortalUrl(returnUrl: string): Promise<string> {
    if (!this.organizationId) {
      throw new Error("organizationId required for Admin Portal");
    }
    const portal = await this.workos.portal.generateLink({
      organization: this.organizationId,
      intent: GeneratePortalLinkIntent.SSO,
      returnUrl,
    });
    return portal.link;
  }

  // ── Private helpers ────────────────────────────────────────────

  private buildAuthorizationUrl(): string {
    const params: Parameters<typeof this.workos.userManagement.getAuthorizationUrl>[0] = {
      provider: "authkit",
      redirectUri: this.redirectUri,
      clientId: this.clientId,
    };
    if (this.organizationId) {
      params.organizationId = this.organizationId;
    }
    return this.workos.userManagement.getAuthorizationUrl(params);
  }

  private async resolveUser(workosUserId: string): Promise<UserIdentity | null> {
    const nowMs = this.now();
    const cached = this.userCache.get(workosUserId);
    if (cached) {
      if (nowMs - cached.fetchedAt < WorkosIdentityProvider.USER_CACHE_TTL_MS) {
        return cached.identity;
      }
      // Cache is stale — try to refresh, but keep the entry for fallback
    }

    try {
      const workosUser = await this.workos.userManagement.getUser(workosUserId);
      const orgRole = await this.resolveOrgRole(workosUserId);

      // SECURITY: No org membership = no access
      if (orgRole === null) {
        console.error(`[workos] DENIED: user ${workosUserId} has no org membership`);
        // Clear stale cache — user definitively lost access
        this.userCache.delete(workosUserId);
        return null;
      }

      const displayName =
        [workosUser.firstName, workosUser.lastName].filter(Boolean).join(" ") || workosUser.email;

      const preferences = await this.syncLocalProfile(workosUserId, {
        email: workosUser.email,
        displayName,
        orgRole,
      });

      const identity: UserIdentity = {
        id: workosUser.id,
        email: workosUser.email,
        displayName,
        orgRole,
        preferences,
      };
      this.userCache.set(workosUserId, { identity, fetchedAt: nowMs });
      return identity;
    } catch (err) {
      console.error(
        `[workos] resolveUser failed for ${workosUserId}:`,
        err instanceof Error ? err.message : err,
      );
      // Fall back to stale cache on transient API errors — the JWT was already
      // validated (signature + expiration), so the user is who they claim to be.
      // Denying access because of a transient WorkOS API hiccup causes spurious 401s.
      if (cached) {
        console.warn(
          `[workos] Using stale cached identity for ${workosUserId} (age: ${Math.round((nowMs - cached.fetchedAt) / 1000)}s)`,
        );
        return cached.identity;
      }
      return null;
    }
  }

  /**
   * Sync WorkOS identity data to a local user profile.
   * Creates the profile if it doesn't exist; updates identity fields
   * (email, displayName, orgRole) on each login while preserving
   * user-owned data (preferences).
   *
   * Returns the user's current preferences.
   */
  private async syncLocalProfile(
    workosUserId: string,
    data: { email: string; displayName: string; orgRole: OrgRole },
  ): Promise<import("../user.ts").UserPreferences> {
    if (!this.userStore) return {};

    const existing = await this.userStore.get(workosUserId);
    if (existing) {
      // Update identity fields from WorkOS, preserve preferences
      if (
        existing.email !== data.email ||
        existing.displayName !== data.displayName ||
        existing.orgRole !== data.orgRole
      ) {
        await this.userStore.update(workosUserId, {
          email: data.email,
          displayName: data.displayName,
          orgRole: data.orgRole,
        });
      }
      return existing.preferences;
    }

    // First login — create local profile
    try {
      const user = await this.userStore.create({
        id: workosUserId,
        email: data.email,
        displayName: data.displayName,
        orgRole: data.orgRole,
      });
      return user.preferences;
    } catch {
      // UserConflictError — race condition, profile was created between get and create
      const raced = await this.userStore.get(workosUserId);
      return raced?.preferences ?? {};
    }
  }

  /**
   * Resolve the NimbleBrain OrgRole from WorkOS organization membership.
   *
   * Queries the WorkOS Organization Membership API for the user's role
   * in the configured organization. Maps WorkOS role slugs to OrgRole:
   *   - "admin" → "admin"
   *   - "member" → "member"
   *
   * Returns null if the user has no org membership — this is a security
   * signal that the user should be denied access.
   */
  private async resolveOrgRole(workosUserId: string): Promise<OrgRole | null> {
    if (!this.organizationId) return "member";

    try {
      const memberships = await this.workos.userManagement.listOrganizationMemberships({
        userId: workosUserId,
        organizationId: this.organizationId,
      });

      const membership = memberships.data[0];
      if (!membership) {
        console.error(
          `[workos] DENIED: No org membership for user=${workosUserId} org=${this.organizationId}`,
        );
        return null;
      }

      const roleSlug = (membership.role as { slug?: string })?.slug;
      if (roleSlug === "admin") return "admin";
      return "member";
    } catch (err) {
      console.error(
        `[workos] resolveOrgRole failed for user=${workosUserId}:`,
        err instanceof Error ? err.message : err,
      );
      // Fail closed — deny access on API errors
      return null;
    }
  }

  /**
   * Provision a user on first login via auth code flow.
   *
   * 1. Sync local profile from WorkOS (create or update)
   * 2. If user has no workspaces, create a private workspace for them
   *
   * On subsequent logins this is a no-op — profile sync is handled by
   * resolveUser() on every request, and the workspace already exists.
   */
  private async provisionUser(workosUser: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  }): Promise<void> {
    const displayName =
      [workosUser.firstName, workosUser.lastName].filter(Boolean).join(" ") || workosUser.email;
    const orgRole = await this.resolveOrgRole(workosUser.id);

    // SECURITY: Do not provision users without org membership
    if (orgRole === null) {
      throw new Error(
        `Cannot provision user ${workosUser.email}: not a member of this organization`,
      );
    }

    // Sync local profile (workspace provisioning is handled by resolveWorkspace in auth-middleware)
    await this.syncLocalProfile(workosUser.id, { email: workosUser.email, displayName, orgRole });
  }

  /** The AuthKit domain, if configured. Used by well-known route handlers. */
  getAuthkitDomain(): string | undefined {
    return this.authkitDomain;
  }

  private async getAuthkitJwks(): Promise<JwksKey[] | null> {
    if (!this.authkitDomain) return null;
    const nowMs = this.now();
    if (this.authkitJwksCache && nowMs - this.authkitJwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.authkitJwksCache.keys;
    }

    try {
      const url = `https://${this.authkitDomain}.authkit.app/oauth2/jwks`;
      const res = await this.fetcher(url);
      if (!res.ok) {
        if (this.authkitJwksCache) {
          console.warn(`[workos] AuthKit JWKS fetch failed (${res.status}), using stale cache`);
          return this.authkitJwksCache.keys;
        }
        return null;
      }

      const jwks = (await res.json()) as { keys: JwksKey[] };
      if (!jwks.keys || !Array.isArray(jwks.keys)) return null;

      this.authkitJwksCache = { keys: jwks.keys, fetchedAt: nowMs };
      return jwks.keys;
    } catch {
      if (this.authkitJwksCache) {
        console.warn("[workos] AuthKit JWKS fetch error, using stale cache");
        return this.authkitJwksCache.keys;
      }
      return null;
    }
  }

  private async getJwks(): Promise<JwksKey[] | null> {
    const nowMs = this.now();
    if (this.jwksCache && nowMs - this.jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
      return this.jwksCache.keys;
    }

    try {
      const url = `https://api.workos.com/sso/jwks/${this.clientId}`;
      const res = await this.fetcher(url);
      if (!res.ok) {
        // Fall back to stale keys — JWKS rotate rarely, stale keys are almost
        // certainly still valid. Failing verification here causes spurious 401s.
        if (this.jwksCache) {
          console.warn(
            `[workos] JWKS fetch failed (${res.status}), using stale cache (age: ${Math.round((nowMs - this.jwksCache.fetchedAt) / 1000)}s)`,
          );
          return this.jwksCache.keys;
        }
        return null;
      }

      const jwks = (await res.json()) as { keys: JwksKey[] };
      if (!jwks.keys || !Array.isArray(jwks.keys)) return null;

      this.jwksCache = { keys: jwks.keys, fetchedAt: nowMs };
      return jwks.keys;
    } catch {
      // Fall back to stale keys on network errors
      if (this.jwksCache) {
        console.warn(
          `[workos] JWKS fetch error, using stale cache (age: ${Math.round((nowMs - this.jwksCache.fetchedAt) / 1000)}s)`,
        );
        return this.jwksCache.keys;
      }
      return null;
    }
  }

  private async verifySignature(
    header: JwtHeader,
    data: Uint8Array,
    signature: Uint8Array,
    keys: JwksKey[],
  ): Promise<boolean> {
    const candidates = header.kid
      ? keys.filter((k) => k.kid === header.kid)
      : keys.filter((k) => k.kty === "RSA");

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
        "[workos] JWT signature verification failed: no matching key found among",
        candidates.length,
        "candidates",
      );
    }
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/** Map a WorkOS User object to the NimbleBrain User type. */
function toUser(
  workosUser: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    createdAt: string;
    updatedAt: string;
  },
  orgRole: OrgRole = "member",
): User {
  return {
    id: workosUser.id,
    email: workosUser.email,
    displayName:
      [workosUser.firstName, workosUser.lastName].filter(Boolean).join(" ") || workosUser.email,
    orgRole,
    preferences: {},
    createdAt: workosUser.createdAt,
    updatedAt: workosUser.updatedAt,
  };
}
