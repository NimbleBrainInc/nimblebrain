import { WorkOS } from "@workos-inc/node";
import { publicOrigin } from "../../oauth/public-origin.ts";
import { log } from "../../observability/log.ts";
import type { WorkosAuth } from "../instance.ts";
import {
  type AuthorizationServer,
  type CreateUserInput,
  type CreateUserResult,
  FIRST_PARTY_GRANT,
  type IdentityProvider,
  type ProviderCapabilities,
  RefreshTokenError,
  type TokenGrant,
  type TokenResult,
  TransientAuthError,
  type UpdateUserInput,
  type UserIdentity,
  type VerifiedIdentity,
} from "../provider.ts";
import type { OrgRole } from "../types.ts";
import type { User, UserPreferences, UserStore } from "../user.ts";

// ── JWT helpers (shared with OIDC provider — duplicated intentionally to keep providers independent) ──

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface WorkosJwtPayload {
  sub?: string;
  sid?: string;
  org_id?: string;
  aud?: string | string[];
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

/**
 * Why a `verifyRequest` call rejected a token. Each value names one of the
 * token-level `return null` exits, so a 401 in the logs carries the gate that
 * produced it; an access denial from `resolveUser` logs its own `DENIED` line
 * instead. `org_mismatch` is a token, from either issuer, whose `org_id`
 * is not the configured org or is absent, such as one minted for another org
 * of a multi-org user. See {@link WorkosIdentityProvider.reject}.
 */
type WorkosRejectReason =
  | "no_token"
  | "malformed_jwt"
  | "bad_alg"
  | "missing_exp"
  | "token_expired"
  | "missing_sub"
  | "org_mismatch"
  | "bad_signature"
  | "authkit_bad_signature";

/**
 * Failures that are ours, not the caller's — a key set we could not fetch, or
 * an identity API we could not reach with nothing cached. Deliberately separate
 * from {@link WorkosRejectReason}: these do not mean "not authenticated", and
 * routing one through `reject()` would 401 a valid session.
 */
type WorkosTransientReason =
  | "jwks_unavailable"
  | "authkit_jwks_unavailable"
  | "user_unresolvable"
  | "org_role_unresolvable";

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

interface ParsedJwt {
  header: JwtHeader;
  payload: WorkosJwtPayload;
  signatureInput: Uint8Array;
  signature: Uint8Array;
}

function parseJwt(token: string): ParsedJwt | null {
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

/**
 * WorkOS role slugs that map to the app `admin` role when the operator hasn't
 * configured `adminRoleSlugs`. Includes `owner` so a WorkOS org-owner role
 * lands as app `admin` (the app's `owner` tier is internal — see
 * `syncLocalProfile`), and so the common case works without configuration.
 */
const DEFAULT_ADMIN_ROLE_SLUGS = ["admin", "owner"];

/**
 * Normalize the configured (or default) admin role slugs into a lowercased
 * Set for case-insensitive membership tests. Whitespace entries are dropped.
 * An omitted, empty, or blank-only config falls back to the defaults — the
 * result is never an empty set, which would mean "no slug grants admin" and
 * lock out every WorkOS admin. (Config-level empties are already rejected in
 * `instance.ts`; this is the defense-in-depth invariant for direct callers.)
 */
function normalizeAdminRoleSlugs(slugs: string[] | undefined): Set<string> {
  const source = slugs && slugs.length > 0 ? slugs : DEFAULT_ADMIN_ROLE_SLUGS;
  const normalized = source.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  return new Set(normalized.length > 0 ? normalized : DEFAULT_ADMIN_ROLE_SLUGS);
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
  /** Assigned in the constructor: `authorizationServer` depends on config. */
  readonly capabilities: ProviderCapabilities;

  private workos: WorkOS;
  private clientId: string;
  private redirectUri: string;
  private organizationId: string | undefined;
  private authkitDomain: string | undefined;
  private adminRoleSlugs: Set<string>;
  private adminRoleSlugForWrite: string;
  /** Client IDs whose AuthKit tokens are first-party; empty means none are. */
  private firstPartyClientIds: ReadonlySet<string>;
  private userStore: UserStore | null;

  private jwksCache: CachedJwks | null = null;
  private authkitJwksCache: CachedJwks | null = null;
  private userCache = new Map<string, { identity: UserIdentity; fetchedAt: number }>();
  private static USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  /**
   * How long after its last successful check a cached identity may still be
   * served while WorkOS is failing. The membership check is what notices an
   * org removal made in WorkOS, and during an outage that check is the call
   * that fails, so this is the longest such a removal can go unnoticed. It is
   * long enough to ride out a rate-limit window or a short outage without
   * failing requests. Past it, the request gets a 503, not the old answer.
   */
  private static MAX_STALE_IDENTITY_MS = 30 * 60 * 1000; // 30 minutes
  /**
   * Normalized slugs already warned about in `resolveOrgRole`, so an
   * unrecognized-but-legitimate non-admin slug (e.g. `viewer`) logs once per
   * process instead of on every login. The diagnostic is the first occurrence;
   * recurring volume on a busy tenant is not.
   */
  private warnedUnmatchedSlugs = new Set<string>();

  /** Overridable for testing. */
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  now: () => number = () => Date.now();

  /**
   * userStore is optional because WorkOS itself is the source of truth for
   * users (managedUsers: true); the local profile is a cache for preferences.
   */
  constructor(config: WorkosAuth, userStore: UserStore | undefined) {
    const apiKey = process.env.WORKOS_API_KEY ?? config.apiKey ?? "";
    this.workos = new WorkOS(apiKey, { clientId: config.clientId });
    this.clientId = config.clientId;
    // The OAuth callback is always on the canonical public origin; it must
    // match a redirect URI registered in the WorkOS dashboard.
    this.redirectUri = `${publicOrigin()}/v1/auth/callback`;
    // Every org gate below reads a falsy organizationId as "no organization
    // scope", so a blank one must never get this far. instance.json loading
    // rejects it; this covers a provider built from config that skipped it.
    if (config.organizationId !== undefined && config.organizationId.trim() === "")
      throw new Error("workos auth 'organizationId' must not be empty");
    this.organizationId = config.organizationId;
    this.authkitDomain = config.authkitDomain;
    this.adminRoleSlugs = normalizeAdminRoleSlugs(config.adminRoleSlugs);
    // The slug written when `manage_users` makes someone an admin: the first
    // one the operator names, so it is a role their WorkOS environment has.
    this.adminRoleSlugForWrite = [...this.adminRoleSlugs][0] ?? "admin";
    this.firstPartyClientIds = new Set(
      (config.firstPartyClientIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    );
    this.userStore = userStore ?? null;
    this.capabilities = {
      authCodeFlow: true,
      tokenRefresh: true,
      managedUsers: true,
      // AuthKit is the authorization server; without a domain there is none.
      authorizationServer: this.authkitOrigin() !== null,
      // AuthKit signs a user in by their email, so changing it is an identity
      // change WorkOS owns, not a profile edit.
      providerOwnedUserFields: ["email"],
    };
  }

  // ── IdentityProvider interface ──────────────────────────────────

  getAuthorizationUrl(): string {
    return this.buildAuthorizationUrl();
  }

  async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    const token = extractToken(req);
    if (!token) return this.reject("no_token");

    const parsed = parseJwt(token);
    if (!parsed) return this.reject("malformed_jwt");

    const { header, payload } = parsed;

    if (header.alg !== "RS256") return this.reject("bad_alg", { alg: header.alg });

    // Validate expiration
    if (typeof payload.exp !== "number") return this.reject("missing_exp", { sub: payload.sub });
    const nowSec = Math.floor(this.now() / 1000);
    if (payload.exp <= nowSec) return this.reject("token_expired", { sub: payload.sub });

    // Must have sub (WorkOS user ID)
    if (typeof payload.sub !== "string") return this.reject("missing_sub");

    // Every token, whichever issuer minted it, must be for the configured org.
    // Membership alone does not settle it: a user who belongs to several orgs
    // holds tokens minted for each, and only this org's may act here. `iss`
    // says which issuer minted the refused token. This gate runs before the
    // signature check, so `claimed_org` and `iss` are unverified input: safe
    // to log, since a forged value only ever lands here or fails the signature
    // check next, but not authoritative.
    if (this.organizationId && payload.org_id !== this.organizationId) {
      return this.reject("org_mismatch", {
        sub: payload.sub,
        iss: payload.iss ?? null,
        claimed_org: payload.org_id ?? null,
        expected_org: this.organizationId,
      });
    }

    // Route verification based on issuer: AuthKit MCP OAuth vs WorkOS User Management.
    // Both branches route their token rejections through reject() so failures
    // carry the same reason field and severity — one reason-keyed view covers
    // both issuers. resolveUser's access denials log their own DENIED line.
    //
    // The issuer and the client decide the grant. A User Management token was
    // issued to this instance's own login client, so it is first-party. An
    // AuthKit token is first-party only when the client it was issued to (its
    // signed `client_id`) is one the operator lists as its own; any other was
    // minted for the resource its client named, so it carries its
    // (signature-covered) audience. The audience never decides first-party
    // standing: it says where a token may be used, not whose app holds it, and
    // an MCP client that refreshes without a `resource` gets the same `aud`
    // as a first-party app.
    const authkitIssuer = this.authkitOrigin();
    const fromAuthkit = authkitIssuer !== null && payload.iss === authkitIssuer;
    const identity = fromAuthkit
      ? await this.verifyAuthkitToken(parsed, payload.sub)
      : await this.verifyUserManagementToken(parsed, payload.sub);

    if (!identity) return null;
    const grant: TokenGrant =
      !fromAuthkit || this.isFirstPartyClient(payload.client_id)
        ? FIRST_PARTY_GRANT
        : { kind: "resource", audience: audienceList(payload.aud) };
    return { ...identity, grant };
  }

  /** Whether a verified AuthKit token's `client_id` claim names a configured first-party client. */
  private isFirstPartyClient(clientId: unknown): boolean {
    return typeof clientId === "string" && this.firstPartyClientIds.has(clientId);
  }

  /**
   * Verify an AuthKit-issued JWT (MCP OAuth flow) against the AuthKit JWKS, then resolve the user.
   */
  private async verifyAuthkitToken(parsed: ParsedJwt, sub: string): Promise<UserIdentity | null> {
    const { header, signatureInput, signature } = parsed;
    // getAuthkitJwks still logs its own stale-cache diagnostics independently.
    const keys = await this.getAuthkitJwks();
    if (!keys) this.transient("authkit_jwks_unavailable", { sub });

    const verified = await this.verifySignature(header, signatureInput, signature, keys);
    if (!verified) return this.reject("authkit_bad_signature", { sub });

    return this.resolveUser(sub);
  }

  /**
   * Verify a WorkOS User Management JWT against the WorkOS JWKS, then resolve the user.
   */
  private async verifyUserManagementToken(
    parsed: ParsedJwt,
    sub: string,
  ): Promise<UserIdentity | null> {
    const { header, signatureInput, signature } = parsed;

    // Verify signature against WorkOS JWKS
    const keys = await this.getJwks();
    if (!keys) this.transient("jwks_unavailable", { sub });

    const verified = await this.verifySignature(header, signatureInput, signature, keys);
    // A signature failure is the most security-relevant rejection (forged or
    // tampered token, or a JWKS-rotation mismatch). Name it so a spike is
    // visible — covering the 0-candidate case where verifySignature stays silent.
    if (!verified) return this.reject("bad_signature", { sub });

    // Resolve user from WorkOS
    return this.resolveUser(sub);
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

    // Provision user on first login — sync the local profile
    await this.provisionUser(result.user);

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenResult> {
    try {
      const result = await this.workos.userManagement.authenticateWithRefreshToken({
        clientId: this.clientId,
        refreshToken,
        // Pin the refresh to the configured organization, so token mint and
        // token verify agree. Without it, WorkOS mints the new access token
        // against the user's *default* org, which for a multi-org user can
        // differ from the org this session was established under
        // (buildAuthorizationUrl pins organizationId on the authorization
        // request, and exchangeCode enforces membership in it). That token
        // fails verifyRequest's org_id gate on the next request, so a refresh
        // that succeeds would still log the user out. Omitted when no org is
        // configured.
        ...(this.organizationId ? { organizationId: this.organizationId } : {}),
      });
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    } catch (err) {
      // Classify the failure for the handler. The end-user's session is dead
      // ONLY on `invalid_grant` (refresh token expired/revoked/reused — RFC
      // 6749 §5.2), which WorkOS surfaces as an OauthException carrying that
      // `.error` code. Everything else leaves the session intact and must NOT
      // log the user out:
      //   - other OAuth codes (invalid_client/unauthorized_client) = this
      //     deployment's WorkOS credentials are wrong — a config problem, not a
      //     dead session;
      //   - GenericServerException / RateLimitExceededException = a 5xx/429
      //     from WorkOS during a blip;
      //   - a thrown fetch / TypeError = the IdP hop never completed.
      // All of those are `unavailable`: we couldn't reach a verdict, so keep
      // the session and let the client retry.
      const oauthError =
        typeof err === "object" && err !== null && "error" in err
          ? (err as { error?: unknown }).error
          : undefined;
      if (oauthError === "invalid_grant") {
        throw new RefreshTokenError("rejected", "Refresh token rejected by IdP (invalid_grant)", {
          code: "invalid_grant",
          cause: err,
        });
      }
      throw new RefreshTokenError("unavailable", "Token refresh did not reach a verdict", {
        code: typeof oauthError === "string" ? oauthError : undefined,
        cause: err,
      });
    }
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

  /**
   * Write an edit to WorkOS, then to the local profile. WorkOS is the source of
   * the name and of the admin/member role, and `syncLocalProfile` copies both
   * back over the local profile on the next uncached sign-in, so an edit made
   * only locally would revert. `owner` is app-internal and is written locally
   * only. Email is refused: AuthKit signs the user in by it
   * (`providerOwnedUserFields`), so `manage_users` never sends it here.
   */
  async updateUser(userId: string, data: UpdateUserInput): Promise<User | null> {
    if (!this.userStore) return null;
    const existing = await this.userStore.get(userId);
    if (!existing) return null;
    if (data.email !== undefined && data.email !== existing.email) {
      throw new Error("Email is managed in WorkOS. Change it there.");
    }

    const local: UpdateUserInput = { ...data };
    delete local.email;
    if (data.displayName !== undefined && data.displayName !== existing.displayName) {
      const [firstName = "", ...rest] = data.displayName.trim().split(/\s+/);
      const lastName = rest.join(" ");
      await this.workos.userManagement.updateUser({
        userId,
        firstName,
        // Empty, not omitted, so a one-word name clears the old last name
        // rather than keeping it beside the new first name.
        lastName,
      });
      // Stored as the login sync will rebuild it from WorkOS, so it never differs.
      local.displayName = [firstName, lastName].filter(Boolean).join(" ");
    }

    if (
      data.orgRole !== undefined &&
      data.orgRole !== "owner" &&
      data.orgRole !== existing.orgRole
    ) {
      await this.writeMembershipRole(userId, data.orgRole);
    }

    return this.userStore.update(userId, local);
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

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Log a structured reason for a verify rejection, then return null.
   *
   * Every token-level `return null` exit in `verifyRequest` goes through here,
   * because the auth middleware logs only a generic "[auth] authentication
   * failed". Access denials from `resolveUser` (no org membership, deactivated
   * user) log their own `DENIED` line and do not come through here. The
   * reason tells a routine expiry from an `org_id` mismatch or a bad
   * signature without reading source, and makes each cause greppable.
   *
   * Routine, self-healing reasons (`no_token`, `token_expired` — a refresh
   * fixes both) log at debug to avoid flooding the warn stream on every
   * pre-refresh request; every other reason is anomalous and logs at warn.
   * Only token-derived identifiers are stamped (sub, org ids) — never the
   * token, email, or display name (mirrors this file's trust rule).
   */
  private reject(reason: WorkosRejectReason, fields?: Record<string, unknown>): null {
    if (reason === "no_token" || reason === "token_expired") {
      log.debug("auth", `[workos] verify rejected: ${reason}`, fields);
    } else {
      log.warn(`[workos] verify rejected: ${reason}`, fields);
    }
    return null;
  }

  /**
   * Verification could not reach a verdict — our own dependency failed, not the
   * caller's token. Throws rather than returning null so the middleware answers
   * 503 instead of logging a valid user out. See {@link TransientAuthError}.
   */
  private transient(reason: WorkosTransientReason, fields?: Record<string, unknown>): never {
    log.warn(`[workos] verify unavailable: ${reason}`, fields);
    throw new TransientAuthError(reason, `WorkOS verification unavailable: ${reason}`);
  }

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
        log.error(`[workos] DENIED: user ${workosUserId} has no org membership`);
        // Clear stale cache — user definitively lost access
        this.userCache.delete(workosUserId);
        return null;
      }

      // SECURITY: soft-deleted (deactivated) users keep a valid WorkOS identity
      // but are denied platform access. The tombstone lives in the local profile;
      // checking here (before we cache) makes the revocation effective on the
      // next request, and invalidateUser() drops any in-flight cache entry.
      // The `?.` is load-bearing only in theory: userStore is UserStore | null
      // (a no-store config can't soft-delete anyone, so the gate correctly
      // no-ops), and the factory always wires a real store in production.
      const localProfile = await this.userStore?.get(workosUserId);
      if (localProfile?.deletedAt) {
        log.error(`[workos] DENIED: user ${workosUserId} is deactivated`);
        this.userCache.delete(workosUserId);
        return null;
      }

      const displayName =
        [workosUser.firstName, workosUser.lastName].filter(Boolean).join(" ") || workosUser.email;

      // The effective role (not the raw `orgRole`) is what gates the live
      // session: `syncLocalProfile` may preserve a local `owner` that
      // `resolveOrgRole` can't produce. Building the identity from the raw
      // value would leave a preserved owner inert (store says owner, session
      // says member) — see syncLocalProfile's contract.
      const { preferences, orgRole: effectiveRole } = await this.syncLocalProfile(workosUserId, {
        email: workosUser.email,
        displayName,
        orgRole,
      });

      const identity: UserIdentity = {
        id: workosUser.id,
        email: workosUser.email,
        displayName,
        orgRole: effectiveRole,
        preferences,
      };
      this.userCache.set(workosUserId, { identity, fetchedAt: nowMs });
      return identity;
    } catch (err) {
      log.error(`[workos] resolveUser failed for ${workosUserId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to stale cache on transient API errors — the JWT was already
      // validated (signature + expiration), so the user is who they claim to be.
      // Denying access because of a transient WorkOS API hiccup causes spurious 401s.
      //
      // `USER_CACHE_TTL_MS` decides only whether a refresh is attempted. How
      // long a failed refresh may keep serving the cached identity, and the org
      // role in it, is `MAX_STALE_IDENTITY_MS`, measured from the last
      // successful check; `fetchedAt` is not restamped here.
      if (cached && nowMs - cached.fetchedAt < WorkosIdentityProvider.MAX_STALE_IDENTITY_MS) {
        log.warn(
          `[workos] Using stale cached identity for ${workosUserId} (age: ${Math.round((nowMs - cached.fetchedAt) / 1000)}s)`,
        );
        return cached.identity;
      }
      // No cache young enough to fall back on, so we never reached a verdict
      // about this user. Returning null would 401 a valid session, the outcome
      // the stale fallback above exists to avoid; throw so the caller gets 503
      // and retries.
      this.transient("user_unresolvable", {
        userId: workosUserId,
        stale_age_s: cached ? Math.round((nowMs - cached.fetchedAt) / 1000) : null,
      });
    }
  }

  /**
   * Sync WorkOS identity data to a local user profile.
   * Creates the profile if it doesn't exist; updates identity fields
   * (email, displayName, orgRole) on each login while preserving
   * user-owned data (preferences).
   *
   * Returns both the user's preferences AND the **effective** org role — the
   * post-preservation value, which may be `owner` even though `resolveOrgRole`
   * never yields `owner`. The caller MUST build the live session identity from
   * this returned role, not from the raw `data.orgRole`; otherwise a preserved
   * owner exists only in the store and the live session is gated as a lesser
   * role (store and session disagree).
   */
  private async syncLocalProfile(
    workosUserId: string,
    data: { email: string; displayName: string; orgRole: OrgRole },
  ): Promise<{ preferences: UserPreferences; orgRole: OrgRole }> {
    if (!this.userStore) return { preferences: {}, orgRole: data.orgRole };

    const existing = await this.userStore.get(workosUserId);
    if (existing) {
      // `owner` is an app-internal elevation, not a WorkOS-derived role:
      // `resolveOrgRole` only ever yields "admin"/"member", and only the
      // guarded `manage_users` path may create or remove an owner. So a
      // login-time sync must never DOWNGRADE a local owner to a lesser
      // WorkOS-derived role — otherwise a WorkOS membership change would
      // silently strip owners and defeat the last-owner invariant (the
      // sync path bypasses that guard). admin/member still track WorkOS.
      const effectiveRole: OrgRole = existing.orgRole === "owner" ? "owner" : data.orgRole;
      // Update identity fields from WorkOS, preserve preferences
      if (
        existing.email !== data.email ||
        existing.displayName !== data.displayName ||
        existing.orgRole !== effectiveRole
      ) {
        await this.userStore.update(workosUserId, {
          email: data.email,
          displayName: data.displayName,
          orgRole: effectiveRole,
        });
      }
      return { preferences: existing.preferences, orgRole: effectiveRole };
    }

    // First login — create local profile. No existing record means no owner to
    // preserve, so the effective role is the WorkOS-derived one.
    try {
      const user = await this.userStore.create({
        id: workosUserId,
        email: data.email,
        displayName: data.displayName,
        orgRole: data.orgRole,
      });
      return { preferences: user.preferences, orgRole: user.orgRole };
    } catch {
      // UserConflictError — race condition, profile was created between get and
      // create. Preserve the raced record's owner the same way the existing
      // branch does, so a concurrent login can't strip it either.
      const raced = await this.userStore.get(workosUserId);
      const racedRole: OrgRole = raced?.orgRole === "owner" ? "owner" : data.orgRole;
      return { preferences: raced?.preferences ?? {}, orgRole: racedRole };
    }
  }

  /**
   * Resolve the NimbleBrain OrgRole from WorkOS organization membership.
   *
   * Queries the WorkOS Organization Membership API for the user's role in the
   * configured organization and maps the role slug to an app OrgRole:
   *   - slug ∈ `adminRoleSlugs` (default `["admin", "owner"]`, case-insensitive)
   *     → "admin"
   *   - any other slug → "member" (logged, so a custom admin slug that should
   *     have matched is diagnosable instead of silently downgraded)
   *
   * This NEVER returns "owner": `owner` is an app-internal elevation managed
   * via `manage_users` and preserved across login by `syncLocalProfile`, not a
   * WorkOS-derived role. A WorkOS owner-slug role therefore grants app `admin`.
   *
   * Returns null if the user has no org membership — a security signal that the
   * user should be denied access, and the only meaning null carries here.
   *
   * Throws {@link TransientAuthError} if the membership lookup itself failed.
   * That is not a verdict about membership, and callers must not read it as
   * one: `resolveUser` treats null as definitive and evicts the cached
   * identity, so returning null on an API error denies a valid session and
   * takes the fallback that would have covered the next request with it.
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
        log.error(
          `[workos] DENIED: No org membership for user=${workosUserId} org=${this.organizationId}`,
        );
        return null;
      }

      const roleSlug = (membership.role as { slug?: string })?.slug;
      const normalized = roleSlug?.trim().toLowerCase();
      if (normalized && this.adminRoleSlugs.has(normalized)) return "admin";
      if (normalized && normalized !== "member" && !this.warnedUnmatchedSlugs.has(normalized)) {
        // An unexpected slug that isn't a recognized admin slug and isn't the
        // ordinary "member" — this is the silent-downgrade trap. Log the actual
        // slug and the configured set so a misconfigured admin role surfaces in
        // the logs instead of an invisible "everyone is a member" outcome. The
        // plain "member" slug is the normal case and is intentionally quiet, and
        // each unmatched slug warns once per process (not per login) so a tenant
        // with legitimate non-admin slugs (e.g. `viewer`) isn't spammed.
        // Add the slug to `auth.adminRoleSlugs` to grant admin.
        this.warnedUnmatchedSlugs.add(normalized);
        log.warn(
          `[workos] role slug "${roleSlug}" for user=${workosUserId} is not in ` +
            `adminRoleSlugs [${[...this.adminRoleSlugs].join(", ")}] — mapping to "member". ` +
            "If this role should be an org admin, add its slug to auth.adminRoleSlugs.",
        );
      }
      return "member";
    } catch (err) {
      log.error(`[workos] resolveOrgRole failed for user=${workosUserId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // An API error is not a verdict about membership. resolveUser reads
      // `null` as *definitively* lost access: it denies AND deletes the cached
      // identity, so returning it here would log a valid user out and destroy
      // the stale-identity fallback for the next request. Throw instead, so it
      // classifies as unavailability like every other dependency failure and
      // resolveUser's catch decides between stale cache and 503.
      this.transient("org_role_unresolvable", { userId: workosUserId });
    }
  }

  /**
   * Set the user's role in the configured WorkOS organization to the slug that
   * `resolveOrgRole` maps back to `role`. A membership whose slug already maps
   * to `role` is left alone, so a WorkOS `owner` slug (app `admin`) is not
   * rewritten to `admin`.
   */
  private async writeMembershipRole(userId: string, role: "admin" | "member"): Promise<void> {
    if (!this.organizationId) {
      // With no organization every user resolves to member.
      if (role === "admin") {
        throw new Error("No WorkOS organization is configured, so no one can be an admin.");
      }
      return;
    }
    const memberships = await this.workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId: this.organizationId,
    });
    const membership = memberships.data[0];
    if (!membership) {
      throw new Error("This user has no membership in the WorkOS organization.");
    }
    const slug = (membership.role as { slug?: string })?.slug?.trim().toLowerCase();
    const current = slug && this.adminRoleSlugs.has(slug) ? "admin" : "member";
    if (current === role) return;
    await this.workos.userManagement.updateOrganizationMembership(membership.id, {
      roleSlug: role === "admin" ? this.adminRoleSlugForWrite : "member",
    });
  }

  /**
   * Provision a user on first login via auth code flow.
   *
   * Syncs the local profile from WorkOS. It creates no workspace: a user who
   * belongs to none gets one from `ensureUserWorkspace` when the web shell
   * bootstraps (`GET /v1/bootstrap`).
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

    // Sync local profile
    await this.syncLocalProfile(workosUser.id, { email: workosUser.email, displayName, orgRole });
  }

  /**
   * AuthKit, when this instance is configured for it — the authorization
   * server external MCP clients discover and obtain tokens from.
   */
  authorizationServer(): AuthorizationServer | null {
    const origin = this.authkitOrigin();
    if (!origin) return null;
    return {
      issuer: origin,
      metadataUrl: `${origin}/.well-known/oauth-authorization-server`,
    };
  }

  /** AuthKit's origin, or null when no AuthKit domain is configured. */
  private authkitOrigin(): string | null {
    return this.authkitDomain ? `https://${this.authkitDomain}.authkit.app` : null;
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
          log.warn(`[workos] AuthKit JWKS fetch failed (${res.status}), using stale cache`);
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
        log.warn("[workos] AuthKit JWKS fetch error, using stale cache");
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
          log.warn(
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
        log.warn(
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
      log.warn("[workos] JWT signature verification failed: no matching key found", {
        candidates: candidates.length,
      });
    }
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/** A JWT `aud` claim as a list: a string is one audience, anything malformed none. */
function audienceList(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === "string");
  return [];
}

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
