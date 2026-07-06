import { GeneratePortalLinkIntent, WorkOS } from "@workos-inc/node";
import { isAllowedOriginScheme, publicOrigin } from "../../oauth/public-origin.ts";
import { log } from "../../observability/log.ts";
import { ensureUserWorkspace } from "../../workspace/provisioning.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import type { WorkosAuth } from "../instance.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  TokenResult,
  UserIdentity,
} from "../provider.ts";
import { RefreshTokenError } from "../provider.ts";
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
 * provider's silent `return null` exits so an operator triaging an
 * involuntary logout sees the specific gate instead of a bare 401.
 * `org_mismatch` is the one behind the `retry_401` incident: a refreshed
 * token whose `org_id` no longer matches the configured org. See
 * {@link WorkosIdentityProvider.reject}.
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
  | "jwks_unavailable"
  | "authkit_bad_signature"
  | "authkit_jwks_unavailable";

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

/**
 * Resolve the WorkOS OAuth `redirect_uri`. An explicit value (legacy
 * `WORKOS_REDIRECT_URI`) overrides; **empty or blank-only counts as absent** and
 * derives `${publicOrigin()}/v1/auth/callback`. The empty case is load-bearing:
 * the Helm init container emits `"redirectUri":""` whenever the secret is unset
 * (and `instance.ts` keeps `""` as a present field, since `"" !== undefined`), so
 * a plain `??` would hand WorkOS an empty `redirect_uri` and break login at first
 * click. A non-empty override is validated here so a malformed value fails closed
 * at construction (startup), not at the user's first login.
 */
function resolveWorkosRedirectUri(explicit: string | undefined): string {
  const trimmed = explicit?.trim();
  if (!trimmed) return `${publicOrigin()}/v1/auth/callback`;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`[workos] redirectUri override is not a valid URL: "${trimmed}"`);
  }
  // Shared scheme/loopback rule (owned by public-origin.ts) so this can't drift
  // from assertOrigin. Unlike a bare origin, a redirect URI legitimately carries
  // a path (/v1/auth/callback), so only the scheme is checked here.
  if (!isAllowedOriginScheme(url)) {
    throw new Error(
      `[workos] redirectUri override must be https (or http on a loopback host in dev): "${trimmed}"`,
    );
  }
  return trimmed;
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
  private adminRoleSlugs: Set<string>;
  private userStore: UserStore | null;
  private workspaceStore: WorkspaceStore;

  private jwksCache: CachedJwks | null = null;
  private authkitJwksCache: CachedJwks | null = null;
  private userCache = new Map<string, { identity: UserIdentity; fetchedAt: number }>();
  private static USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
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
   * workspaceStore is required: Phase 1 establishes the "authenticated user
   * has ≥1 workspace" invariant at the identity boundary, and that requires
   * a place to create workspaces.
   */
  constructor(
    config: WorkosAuth,
    userStore: UserStore | undefined,
    workspaceStore: WorkspaceStore,
  ) {
    const apiKey = process.env.WORKOS_API_KEY ?? config.apiKey ?? "";
    this.workos = new WorkOS(apiKey, { clientId: config.clientId });
    this.clientId = config.clientId;
    // Explicit override (legacy WORKOS_REDIRECT_URI) wins; absent OR empty
    // derives from publicOrigin(). See resolveWorkosRedirectUri — the empty case
    // matters because the chart emits redirectUri:"" when the secret is unset.
    // A derived value must match a redirect URI registered in the WorkOS dashboard.
    this.redirectUri = resolveWorkosRedirectUri(config.redirectUri);
    this.organizationId = config.organizationId;
    this.authkitDomain = config.authkitDomain;
    this.adminRoleSlugs = normalizeAdminRoleSlugs(config.adminRoleSlugs);
    this.userStore = userStore ?? null;
    this.workspaceStore = workspaceStore;
  }

  // ── IdentityProvider interface ──────────────────────────────────

  getAuthorizationUrl(): string {
    return this.buildAuthorizationUrl();
  }

  async verifyRequest(req: Request): Promise<UserIdentity | null> {
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

    // Route verification based on issuer: AuthKit MCP OAuth vs WorkOS User Management.
    // Both branches route their rejections through reject() so failures carry the
    // same reason field and severity — one reason-keyed view covers both issuers.
    const authkitIssuer = this.authkitDomain ? `https://${this.authkitDomain}.authkit.app` : null;
    const identity =
      authkitIssuer && payload.iss === authkitIssuer
        ? await this.verifyAuthkitToken(parsed, payload.sub)
        : await this.verifyUserManagementToken(parsed, payload.sub);

    // Enforce the invariant "authenticated user has ≥1 workspace" on every
    // successful auth — covers the AuthKit/MCP-OAuth path (which never hits
    // exchangeCode) and self-heals any user whose workspace was lost to
    // admin deletion, partial failure, or migration. Idempotent; the happy
    // path is one filesystem read.
    if (identity) {
      await ensureUserWorkspace(this.workspaceStore, {
        id: identity.id,
        displayName: identity.displayName,
      });
    }
    return identity;
  }

  /**
   * Verify an AuthKit-issued JWT (MCP OAuth flow) against the AuthKit JWKS, then resolve the user.
   */
  private async verifyAuthkitToken(parsed: ParsedJwt, sub: string): Promise<UserIdentity | null> {
    const { header, signatureInput, signature } = parsed;
    // getAuthkitJwks still logs its own stale-cache diagnostics independently.
    const keys = await this.getAuthkitJwks();
    if (!keys) return this.reject("authkit_jwks_unavailable", { sub });

    const verified = await this.verifySignature(header, signatureInput, signature, keys);
    if (!verified) return this.reject("authkit_bad_signature", { sub });

    return this.resolveUser(sub);
  }

  /**
   * Verify a WorkOS User Management JWT (org gate then WorkOS JWKS signature), then resolve the user.
   */
  private async verifyUserManagementToken(
    parsed: ParsedJwt,
    sub: string,
  ): Promise<UserIdentity | null> {
    const { header, payload, signatureInput, signature } = parsed;

    // Validate org_id matches configured organization. This is the silent gate
    // behind the involuntary-logout incident: a refreshed token whose org_id
    // drifted from the configured org (see refreshToken) lands here and was,
    // until instrumented, indistinguishable from any other 401.
    if (this.organizationId && payload.org_id !== this.organizationId) {
      // `claimed_org` is the org_id from the JWT payload — this gate runs BEFORE
      // signature verification, so it is unverified input. It's safe to log (a
      // forged value only ever lands here or fails the sig check next) but an
      // operator must not treat it as authoritative.
      return this.reject("org_mismatch", {
        sub,
        claimed_org: payload.org_id ?? null,
        expected_org: this.organizationId,
      });
    }

    // Verify signature against WorkOS JWKS
    const keys = await this.getJwks();
    if (!keys) return this.reject("jwks_unavailable", { sub });

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

    // Provision user on first login — sync profile + create private workspace
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
        // Pin the refresh to the configured organization. Without it, WorkOS
        // mints the new access token against the user's *default* org, which
        // for a multi-org user can differ from the org this session was
        // established under (buildAuthorizationUrl pins organizationId on the
        // authorization request, so the original token is org-scoped;
        // exchangeCode then enforces membership in it). The drifted token then
        // fails verifyRequest's org_id gate on the very next request — a refresh
        // that "succeeds" yet yields a token the session rejects, which the
        // client surfaces to the user as an involuntary logout (Sentry
        // `retry_401`). Pinning keeps token mint and token verify in agreement.
        // Omitted when no org is configured.
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

  /**
   * Log a structured reason for a verify rejection, then return null.
   *
   * `verifyRequest` has several `return null` exits that were, until now,
   * indistinguishable downstream — each surfaced only as the auth
   * middleware's generic "[auth] authentication failed". An operator
   * triaging an involuntary logout (a freshly *refreshed* token that the
   * very next request rejected — the client emits Sentry `retry_401`)
   * could not tell a routine expiry from an `org_id` mismatch without
   * reading source. Naming the gate makes the cause greppable.
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
      if (cached) {
        log.warn(
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
   * user should be denied access.
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
      // Fail closed — deny access on API errors
      return null;
    }
  }

  /**
   * Provision a user on first login via auth code flow.
   *
   * Syncs the local profile from WorkOS. Workspace provisioning happens on
   * every verifyRequest (see verifyRequest above) so the invariant is
   * self-healing for any path — this includes AuthKit/MCP-OAuth which does
   * not route through exchangeCode.
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
